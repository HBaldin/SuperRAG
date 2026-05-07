import Database from 'better-sqlite3';
import { LRUCache } from 'lru-cache';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { hashString } from '../utils/hash.js';
import type { QueryResult } from '../types/index.js';

const logger = getLogger('semantic-cache');

// ─── Cosine Similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS query_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_hash TEXT NOT NULL UNIQUE,
    query_text TEXT NOT NULL,
    embedding TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cache_hash ON query_cache(query_hash);
  CREATE INDEX IF NOT EXISTS idx_cache_expires ON query_cache(expires_at);
`;

// ─── SemanticCache ────────────────────────────────────────────────────────────

export class SemanticCache {
  private db: Database.Database;
  private memCache: LRUCache<string, QueryResult>;
  private hits = 0;
  private misses = 0;

  constructor() {
    const config = getConfig().cache;
    const dbPath = resolve(config.persistPath);
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this.memCache = new LRUCache<string, QueryResult>({
      max: config.maxCacheEntries,
    });

    logger.info({ path: dbPath }, 'SemanticCache opened');
  }

  async get(queryText: string, queryEmbedding: number[]): Promise<QueryResult | null> {
    const config = getConfig().cache;
    const hash = hashString(queryText);

    // 1. Check mem cache
    const memHit = this.memCache.get(hash);
    if (memHit) {
      this.hits++;
      logger.debug({ hash }, 'Semantic cache mem-hit');
      return memHit;
    }

    // 2. Query SQLite for non-expired entries
    const now = Math.floor(Date.now() / 1000);
    const rows = this.db
      .prepare('SELECT query_hash, embedding, result FROM query_cache WHERE expires_at > ?')
      .all(now) as Array<{ query_hash: string; embedding: string; result: string }>;

    // 3. Find best match by cosine similarity
    let bestResult: QueryResult | null = null;
    let bestSim = -1;
    let bestHash: string | null = null;

    for (const row of rows) {
      let storedEmbedding: number[];
      try {
        storedEmbedding = JSON.parse(row.embedding) as number[];
      } catch {
        continue;
      }

      const sim = cosineSimilarity(queryEmbedding, storedEmbedding);
      if (sim > bestSim) {
        bestSim = sim;
        if (sim >= config.semanticSimilarityThreshold) {
          bestResult = JSON.parse(row.result) as QueryResult;
          bestHash = row.query_hash;
        }
      }
    }

    if (bestResult && bestHash) {
      this.hits++;
      this.memCache.set(bestHash, bestResult);
      logger.debug({ hash, similarity: bestSim }, 'Semantic cache DB-hit');
      return bestResult;
    }

    this.misses++;
    return null;
  }

  async set(queryText: string, queryEmbedding: number[], result: QueryResult): Promise<void> {
    const config = getConfig().cache;
    const hash = hashString(queryText);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + config.queryCacheTtlSeconds;

    // Evict oldest if at capacity
    const count = (this.db.prepare('SELECT COUNT(*) as cnt FROM query_cache').get() as { cnt: number }).cnt;
    if (count >= config.maxCacheEntries) {
      this.db.prepare('DELETE FROM query_cache WHERE id = (SELECT id FROM query_cache ORDER BY created_at ASC LIMIT 1)').run();
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO query_cache (query_hash, query_text, embedding, result, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash, queryText, JSON.stringify(queryEmbedding), JSON.stringify(result), expiresAt);

    this.memCache.set(hash, result);
    logger.debug({ hash }, 'Semantic cache entry stored');
  }

  async invalidate(queryHash: string): Promise<void> {
    this.db.prepare('DELETE FROM query_cache WHERE query_hash = ?').run(queryHash);
    this.memCache.delete(queryHash);
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM query_cache').run();
    this.memCache.clear();
    this.hits = 0;
    this.misses = 0;
    logger.debug('Semantic cache cleared');
  }

  getStats(): { size: number; hitRate: number } {
    const size = (this.db.prepare('SELECT COUNT(*) as cnt FROM query_cache').get() as { cnt: number }).cnt;
    const total = this.hits + this.misses;
    const hitRate = total === 0 ? 0 : this.hits / total;
    return { size, hitRate };
  }

  close(): void {
    this.db.close();
    logger.debug('SemanticCache closed');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _cache: SemanticCache | null = null;

export function getSemanticCache(): SemanticCache {
  if (!_cache) {
    _cache = new SemanticCache();
  }
  return _cache;
}

export function resetSemanticCache(): void {
  if (_cache) {
    _cache.close();
    _cache = null;
  }
}
