import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import type {
  Chunk,
  FileSummary,
  ModuleSummary,
  ProjectSummary,
  FileFingerprint,
} from '../types/index.js';

const logger = getLogger('sqlite');

// ─── DB Singleton ─────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const config = getConfig().sqlite;
    const dbPath = resolve(config.path);
    mkdirSync(dirname(dbPath), { recursive: true });

    _db = new Database(dbPath);

    if (config.walMode) {
      _db.pragma('journal_mode = WAL');
    }
    _db.pragma(`cache_size = ${config.cacheSize}`);
    _db.pragma('synchronous = NORMAL');
    _db.pragma('temp_store = MEMORY');
    _db.pragma('mmap_size = 268435456'); // 256MB

    initSchema(_db);
    logger.info({ path: dbPath }, 'SQLite database opened');
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function initSchema(db: Database.Database): void {
  db.exec(`
    -- File fingerprints for incremental indexing
    CREATE TABLE IF NOT EXISTS file_fingerprints (
      path TEXT PRIMARY KEY,
      absolute_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      modified_time REAL NOT NULL,
      size INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      is_binary INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Chunks metadata
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      parent_id TEXT,
      relative_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      language TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      dependencies TEXT NOT NULL DEFAULT '[]',
      token_estimate INTEGER NOT NULL DEFAULT 0,
      start_line INTEGER NOT NULL DEFAULT 0,
      end_line INTEGER NOT NULL DEFAULT 0,
      domain TEXT,
      complexity TEXT,
      is_public_api INTEGER NOT NULL DEFAULT 0,
      embedding_ref TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_relative_path ON chunks(relative_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_kind ON chunks(kind);
    CREATE INDEX IF NOT EXISTS idx_chunks_language ON chunks(language);
    CREATE INDEX IF NOT EXISTS idx_chunks_domain ON chunks(domain);

    -- FTS5 virtual table for full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      title,
      summary,
      content,
      tags,
      relative_path,
      tokenize = 'porter unicode61'
    );

    -- File summaries
    CREATE TABLE IF NOT EXISTS file_summaries (
      file_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      summary TEXT NOT NULL,
      purpose TEXT NOT NULL,
      domain TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      exports TEXT NOT NULL DEFAULT '[]',
      dependencies TEXT NOT NULL DEFAULT '[]',
      architectural_role TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Module summaries
    CREATE TABLE IF NOT EXISTS module_summaries (
      module_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      purpose TEXT NOT NULL,
      domain TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      files TEXT NOT NULL DEFAULT '[]',
      public_api TEXT NOT NULL DEFAULT '[]',
      dependencies TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Project summaries
    CREATE TABLE IF NOT EXISTS project_summaries (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      purpose TEXT NOT NULL,
      modules TEXT NOT NULL DEFAULT '[]',
      main_languages TEXT NOT NULL DEFAULT '[]',
      frameworks TEXT NOT NULL DEFAULT '[]',
      architectural_patterns TEXT NOT NULL DEFAULT '[]',
      domains TEXT NOT NULL DEFAULT '[]',
      entry_points TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Metrics
    CREATE TABLE IF NOT EXISTS indexing_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      files_scanned INTEGER NOT NULL DEFAULT 0,
      files_indexed INTEGER NOT NULL DEFAULT 0,
      chunks_created INTEGER NOT NULL DEFAULT 0,
      embeddings_generated INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS query_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_hash TEXT NOT NULL,
      total_time_ms INTEGER NOT NULL DEFAULT 0,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      tokens_saved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  logger.debug('SQLite schema initialized');
}

// ─── Fingerprint Operations ───────────────────────────────────────────────────

export function upsertFingerprint(fp: FileFingerprint): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO file_fingerprints
      (path, absolute_path, hash, modified_time, size, encoding, mime_type, is_binary, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `).run(fp.path, fp.absolutePath, fp.hash, fp.modifiedTime, fp.size, fp.encoding, fp.mimeType, fp.isBinary ? 1 : 0);
}

export function upsertFingerprints(fps: FileFingerprint[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO file_fingerprints
      (path, absolute_path, hash, modified_time, size, encoding, mime_type, is_binary, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `);
  const insertMany = db.transaction((items: FileFingerprint[]) => {
    for (const fp of items) {
      stmt.run(fp.path, fp.absolutePath, fp.hash, fp.modifiedTime, fp.size, fp.encoding, fp.mimeType, fp.isBinary ? 1 : 0);
    }
  });
  insertMany(fps);
}

export function getAllFingerprints(): Map<string, FileFingerprint> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM file_fingerprints').all() as Array<{
    path: string;
    absolute_path: string;
    hash: string;
    modified_time: number;
    size: number;
    encoding: string;
    mime_type: string;
    is_binary: number;
  }>;

  const map = new Map<string, FileFingerprint>();
  for (const row of rows) {
    map.set(row.path, {
      path: row.path,
      absolutePath: row.absolute_path,
      hash: row.hash,
      modifiedTime: row.modified_time,
      size: row.size,
      encoding: row.encoding,
      mimeType: row.mime_type,
      isBinary: row.is_binary === 1,
    });
  }
  return map;
}

export function deleteFingerprint(path: string): void {
  getDb().prepare('DELETE FROM file_fingerprints WHERE path = ?').run(path);
}

// ─── Chunk Operations ─────────────────────────────────────────────────────────

export function upsertChunk(chunk: Chunk, content: string): void {
  const db = getDb();

  db.prepare(`
    INSERT OR REPLACE INTO chunks
      (id, document_id, parent_id, relative_path, kind, language, title, summary,
       tags, dependencies, token_estimate, start_line, end_line, domain, complexity,
       is_public_api, embedding_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunk.id, chunk.documentId, chunk.parentId, chunk.relativePath,
    chunk.kind, chunk.language, chunk.title, chunk.summary,
    JSON.stringify(chunk.tags), JSON.stringify(chunk.dependencies),
    chunk.tokenEstimate, chunk.startLine, chunk.endLine,
    chunk.metadata.domain ?? null, chunk.metadata.complexity ?? null,
    chunk.metadata.isPublicApi ? 1 : 0, chunk.embeddingRef
  );

  // Upsert FTS
  db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(chunk.id);
  db.prepare(`
    INSERT INTO chunks_fts (chunk_id, title, summary, content, tags, relative_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    chunk.id,
    chunk.title,
    chunk.summary,
    content.slice(0, 10000), // cap content for FTS
    chunk.tags.join(' '),
    chunk.relativePath
  );
}

export function upsertChunks(chunks: Array<{ chunk: Chunk; content: string }>): void {
  const db = getDb();
  const insertChunk = db.prepare(`
    INSERT OR REPLACE INTO chunks
      (id, document_id, parent_id, relative_path, kind, language, title, summary,
       tags, dependencies, token_estimate, start_line, end_line, domain, complexity,
       is_public_api, embedding_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteFts = db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?');
  const insertFts = db.prepare(`
    INSERT INTO chunks_fts (chunk_id, title, summary, content, tags, relative_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction((items: Array<{ chunk: Chunk; content: string }>) => {
    for (const { chunk, content } of items) {
      insertChunk.run(
        chunk.id, chunk.documentId, chunk.parentId, chunk.relativePath,
        chunk.kind, chunk.language, chunk.title, chunk.summary,
        JSON.stringify(chunk.tags), JSON.stringify(chunk.dependencies),
        chunk.tokenEstimate, chunk.startLine, chunk.endLine,
        chunk.metadata.domain ?? null, chunk.metadata.complexity ?? null,
        chunk.metadata.isPublicApi ? 1 : 0, chunk.embeddingRef
      );
      deleteFts.run(chunk.id);
      insertFts.run(
        chunk.id, chunk.title, chunk.summary,
        content.slice(0, 10000), chunk.tags.join(' '), chunk.relativePath
      );
    }
  });

  insertAll(chunks);
  logger.debug({ count: chunks.length }, 'Chunks upserted to SQLite');
}

export function deleteChunksByDocument(documentId: string): void {
  const db = getDb();
  // Get chunk IDs first for FTS cleanup
  const chunkIds = (db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(documentId) as Array<{ id: string }>).map(r => r.id);
  for (const id of chunkIds) {
    db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(id);
  }
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
}

// ─── FTS Search ───────────────────────────────────────────────────────────────

export interface FtsResult {
  chunkId: string;
  title: string;
  summary: string;
  relativePath: string;
  rank: number;
}

export function searchFts(query: string, topK = 20): FtsResult[] {
  const db = getDb();

  // Sanitize query for FTS5
  const sanitized = query
    .replace(/['"*()]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)
    .map(w => `"${w}"`)
    .join(' OR ');

  if (!sanitized) return [];

  try {
    const rows = db.prepare(`
      SELECT chunk_id, title, summary, relative_path, rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, topK) as Array<{
      chunk_id: string;
      title: string;
      summary: string;
      relative_path: string;
      rank: number;
    }>;

    return rows.map(r => ({
      chunkId: r.chunk_id,
      title: r.title,
      summary: r.summary,
      relativePath: r.relative_path,
      rank: r.rank,
    }));
  } catch (err) {
    logger.warn({ query, err }, 'FTS search failed');
    return [];
  }
}

export function searchFtsKeyword(keyword: string, topK = 20): FtsResult[] {
  return searchFts(keyword, topK);
}

export function searchFtsPrefix(prefix: string, topK = 20): FtsResult[] {
  const db = getDb();
  const sanitized = prefix.replace(/['"*()]/g, '').trim();
  if (!sanitized) return [];

  try {
    const rows = db.prepare(`
      SELECT chunk_id, title, summary, relative_path, rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(`${sanitized}*`, topK) as Array<{
      chunk_id: string;
      title: string;
      summary: string;
      relative_path: string;
      rank: number;
    }>;

    return rows.map(r => ({
      chunkId: r.chunk_id,
      title: r.title,
      summary: r.summary,
      relativePath: r.relative_path,
      rank: r.rank,
    }));
  } catch (err) {
    logger.warn({ prefix, err }, 'FTS prefix search failed');
    return [];
  }
}

// ─── Summary Operations ───────────────────────────────────────────────────────

export function upsertFileSummary(summary: FileSummary): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO file_summaries
      (file_id, path, summary, purpose, domain, tags, exports, dependencies, architectural_role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    summary.fileId, summary.path, summary.summary, summary.purpose,
    summary.domain, JSON.stringify(summary.tags), JSON.stringify(summary.exports),
    JSON.stringify(summary.dependencies), summary.architecturalRole
  );
}

export function upsertModuleSummary(summary: ModuleSummary): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO module_summaries
      (module_id, name, summary, purpose, domain, tags, files, public_api, dependencies)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    summary.moduleId, summary.name, summary.summary, summary.purpose,
    summary.domain, JSON.stringify(summary.tags), JSON.stringify(summary.files),
    JSON.stringify(summary.publicApi), JSON.stringify(summary.dependencies)
  );
}

export function upsertProjectSummary(summary: ProjectSummary): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO project_summaries
      (project_id, name, summary, purpose, modules, main_languages, frameworks,
       architectural_patterns, domains, entry_points, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    summary.projectId, summary.name, summary.summary, summary.purpose,
    JSON.stringify(summary.modules), JSON.stringify(summary.mainLanguages),
    JSON.stringify(summary.frameworks), JSON.stringify(summary.architecturalPatterns),
    JSON.stringify(summary.domains), JSON.stringify(summary.entryPoints),
    JSON.stringify(summary.tags)
  );
}

export function getProjectSummary(projectId: string): ProjectSummary | null {
  const row = getDb().prepare('SELECT * FROM project_summaries WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    projectId: row['project_id'] as string,
    name: row['name'] as string,
    summary: row['summary'] as string,
    purpose: row['purpose'] as string,
    modules: JSON.parse(row['modules'] as string) as string[],
    mainLanguages: JSON.parse(row['main_languages'] as string) as string[],
    frameworks: JSON.parse(row['frameworks'] as string) as string[],
    architecturalPatterns: JSON.parse(row['architectural_patterns'] as string),
    domains: JSON.parse(row['domains'] as string),
    entryPoints: JSON.parse(row['entry_points'] as string) as string[],
    tags: JSON.parse(row['tags'] as string) as string[],
  };
}

export function getFileSummariesByModule(module: string): FileSummary[] {
  const rows = getDb().prepare(
    "SELECT * FROM file_summaries WHERE path LIKE ?"
  ).all(`${module}/%`) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    fileId: row['file_id'] as string,
    path: row['path'] as string,
    summary: row['summary'] as string,
    purpose: row['purpose'] as string,
    domain: row['domain'] as FileSummary['domain'],
    tags: JSON.parse(row['tags'] as string) as string[],
    exports: JSON.parse(row['exports'] as string) as string[],
    dependencies: JSON.parse(row['dependencies'] as string) as string[],
    architecturalRole: row['architectural_role'] as string,
  }));
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export function recordIndexingMetrics(metrics: {
  projectPath: string;
  filesScanned: number;
  filesIndexed: number;
  chunksCreated: number;
  embeddingsGenerated: number;
  durationMs: number;
}): void {
  getDb().prepare(`
    INSERT INTO indexing_metrics
      (project_path, files_scanned, files_indexed, chunks_created, embeddings_generated, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    metrics.projectPath, metrics.filesScanned, metrics.filesIndexed,
    metrics.chunksCreated, metrics.embeddingsGenerated, metrics.durationMs
  );
}

export function recordQueryMetrics(metrics: {
  queryHash: string;
  totalTimeMs: number;
  cacheHit: boolean;
  tokensSaved: number;
}): void {
  getDb().prepare(`
    INSERT INTO query_metrics (query_hash, total_time_ms, cache_hit, tokens_saved)
    VALUES (?, ?, ?, ?)
  `).run(metrics.queryHash, metrics.totalTimeMs, metrics.cacheHit ? 1 : 0, metrics.tokensSaved);
}

export function getStorageStats(): {
  chunks: number;
  files: number;
  modules: number;
  projects: number;
  fingerprints: number;
} {
  const db = getDb();
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;

  return {
    chunks: count('chunks'),
    files: count('file_summaries'),
    modules: count('module_summaries'),
    projects: count('project_summaries'),
    fingerprints: count('file_fingerprints'),
  };
}
