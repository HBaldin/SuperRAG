import { getLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { hashString } from '../utils/hash.js';
import { hierarchicalRetrieve } from '../retrieval/hierarchical.js';
import { recordQueryMetrics } from '../storage/sqlite.js';
import { getEmbeddingClient } from '../embeddings/client.js';
import { getSemanticCache } from '../cache/index.js';
import type {
  QueryRequest,
  QueryResult,
  QueryIntent,
  QueryMetadata,
  QueryFilters,
} from '../types/index.js';

const logger = getLogger('query-pipeline');

// ─── Stage 1: Query Normalization ─────────────────────────────────────────────

function normalizeQuery(query: string): string {
  return query
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[^\w\s\-_.?]/g, ' ')
    .trim();
}

// ─── Stage 2: Query Rewriting ─────────────────────────────────────────────────

const DOMAIN_EXPANSIONS: Record<string, string[]> = {
  auth: ['authentication', 'authorization', 'login', 'token', 'jwt', 'oauth', 'session', 'credential', 'password'],
  login: ['authentication', 'signin', 'credential', 'token', 'session', 'auth'],
  database: ['db', 'sql', 'query', 'repository', 'orm', 'model', 'entity', 'migration', 'schema'],
  api: ['endpoint', 'route', 'controller', 'handler', 'request', 'response', 'http', 'rest'],
  error: ['exception', 'catch', 'throw', 'fault', 'failure', 'handle', 'try'],
  config: ['configuration', 'settings', 'environment', 'env', 'options', 'parameters'],
  test: ['spec', 'unit', 'integration', 'mock', 'fixture', 'assert', 'expect'],
  cache: ['redis', 'memcache', 'ttl', 'invalidate', 'store', 'memory'],
  log: ['logging', 'logger', 'trace', 'debug', 'info', 'warn', 'error', 'pino', 'winston'],
  queue: ['worker', 'job', 'task', 'async', 'background', 'message', 'broker'],
  security: ['encrypt', 'decrypt', 'hash', 'crypto', 'ssl', 'tls', 'certificate', 'vulnerability'],
  validate: ['validation', 'schema', 'sanitize', 'check', 'verify', 'constraint'],
  deploy: ['deployment', 'docker', 'kubernetes', 'container', 'infrastructure', 'ci', 'cd'],
  middleware: ['interceptor', 'filter', 'guard', 'pipe', 'hook', 'plugin'],
};

function rewriteQuery(query: string): string {
  const words = query.split(/\s+/);
  const expansions = new Set<string>(words);

  for (const word of words) {
    const related = DOMAIN_EXPANSIONS[word.toLowerCase()];
    if (related) {
      for (const r of related.slice(0, 3)) {
        expansions.add(r);
      }
    }
  }

  return [...expansions].join(' ');
}

// ─── Stage 3: Intent Detection ────────────────────────────────────────────────

function detectIntent(query: string): QueryIntent {
  const q = query.toLowerCase();

  if (q.match(/\b(how|implement|create|build|write|make)\b/)) return 'find-implementation';
  if (q.match(/\b(where|find|locate|show)\b.*\b(use|used|call|called|reference)\b/)) return 'find-usage';
  if (q.match(/\b(architecture|structure|overview|diagram|design|pattern)\b/)) return 'understand-architecture';
  if (q.match(/\b(what is|define|definition|interface|type|class|function)\b/)) return 'find-definition';
  if (q.match(/\b(config|setting|env|environment|option|parameter)\b/)) return 'find-configuration';
  if (q.match(/\b(test|spec|mock|fixture|assert)\b/)) return 'find-test';
  if (q.match(/\b(doc|readme|guide|tutorial|example|usage)\b/)) return 'find-documentation';
  if (q.match(/\b(bug|error|fix|debug|issue|problem|fail)\b/)) return 'debug';

  return 'general';
}

// ─── Stage 4: Candidate Narrowing ────────────────────────────────────────────

function narrowByIntent(intent: QueryIntent): Partial<QueryFilters> {
  switch (intent) {
    case 'find-test':
      return { tags: ['test'] };
    case 'find-configuration':
      return { domains: ['config'] };
    case 'find-documentation':
      return { kinds: ['section', 'paragraph'] };
    case 'find-implementation':
      return { kinds: ['function', 'method', 'class'] };
    case 'find-definition':
      return { kinds: ['class', 'interface', 'function'] };
    default:
      return {};
  }
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────

export async function runQueryPipeline(request: QueryRequest): Promise<QueryResult> {
  const startTime = Date.now();
  logger.info({ query: request.query.slice(0, 80) }, 'Query pipeline started');

  // Stage 1: Normalize
  const normalized = normalizeQuery(request.query);

  // Stage 2: Rewrite
  const rewritten = rewriteQuery(normalized);

  // Stage 3: Intent
  const intent = detectIntent(normalized);
  logger.debug({ intent, rewritten: rewritten.slice(0, 80) }, 'Intent detected');

  // Stage 4: Narrow
  const intentFilters = narrowByIntent(intent);
  const filters: QueryFilters = { ...intentFilters, ...request.filters };

  // Cache check — compute embedding once, reuse for retrieval
  const config = getConfig();
  const queryHash = hashString(normalized + JSON.stringify(filters));
  let queryEmbedding: number[] | null = null;

  if (config.cache.semanticCacheEnabled) {
    try {
      const embClient = getEmbeddingClient();
      queryEmbedding = await embClient.embed(normalized);
    } catch {
      // non-critical — proceed without embedding cache
    }

    if (queryEmbedding) {
      const cached = await getSemanticCache().get(normalized, queryEmbedding);
      if (cached) {
        logger.debug({ queryHash }, 'Semantic cache hit');
        return { ...cached, metadata: { ...cached.metadata, cacheHit: true } };
      }
    }
  }

  // Stages 5-9: Retrieval (vector + FTS + graph + rerank + compress)
  const retrieval = await hierarchicalRetrieve(rewritten, {
    topK: request.topK ?? getConfig().retrieval.finalTopK,
    filters,
    includeGraph: request.includeGraph ?? true,
    includeCompression: request.includeCompressed ?? true,
  });

  const totalTimeMs = Date.now() - startTime;

  const metadata: QueryMetadata = {
    totalTimeMs,
    parseTimeMs: 0,
    vectorTimeMs: retrieval.vectorTimeMs,
    ftsTimeMs: retrieval.ftsTimeMs,
    rerankTimeMs: retrieval.rerankTimeMs,
    compressionTimeMs: retrieval.compressionTimeMs,
    cacheHit: false,
    candidatesBeforeRerank: retrieval.candidatesBeforeRerank,
    tokensBeforeCompression: retrieval.tokensBeforeCompression,
    tokensAfterCompression: retrieval.tokensAfterCompression,
    tokensSaved: retrieval.tokensBeforeCompression - retrieval.tokensAfterCompression,
  };

  const result: QueryResult = {
    query: request.query,
    rewrittenQuery: rewritten,
    intent,
    chunks: retrieval.chunks,
    summaries: {},
    relations: retrieval.relations,
    metadata,
  };

  // Cache result
  if (config.cache.semanticCacheEnabled && queryEmbedding) {
    try {
      await getSemanticCache().set(normalized, queryEmbedding, result);
    } catch {
      // non-critical
    }
  }

  // Record metrics
  try {
    recordQueryMetrics({
      queryHash,
      totalTimeMs,
      cacheHit: false,
      tokensSaved: metadata.tokensSaved,
    });
  } catch {
    // non-critical
  }

  logger.info({
    query: request.query.slice(0, 50),
    intent,
    chunks: retrieval.chunks.length,
    totalMs: totalTimeMs,
    tokensSaved: metadata.tokensSaved,
  }, 'Query pipeline complete');

  return result;
}
