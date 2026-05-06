import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

// ─── Schemas ────────────────────────────────────────────────────────────────

const EmbeddingConfigSchema = z.object({
  serverUrl: z.string().default('http://localhost:8001'),
  model: z.string().default('BAAI/bge-m3'),
  batchSize: z.number().int().positive().default(32),
  maxRetries: z.number().int().nonnegative().default(3),
  timeoutMs: z.number().int().positive().default(30000),
  cacheEnabled: z.boolean().default(true),
  cacheTtlSeconds: z.number().int().positive().default(86400),
  dimensions: z.number().int().positive().default(1024),
});

const RerankConfigSchema = z.object({
  serverUrl: z.string().default('http://localhost:8002'),
  model: z.string().default('BAAI/bge-reranker-v2-m3'),
  topK: z.number().int().positive().default(20),
  timeoutMs: z.number().int().positive().default(15000),
  enabled: z.boolean().default(true),
});

const QdrantConfigSchema = z.object({
  url: z.string().default('http://localhost:6333'),
  apiKey: z.string().optional(),
  collectionPrefix: z.string().default('superrag'),
  vectorSize: z.number().int().positive().default(1024),
  onDiskPayload: z.boolean().default(true),
});

const SqliteConfigSchema = z.object({
  path: z.string().default('./data/sqlite/superrag.db'),
  walMode: z.boolean().default(true),
  cacheSize: z.number().int().default(-64000),
});

const ChunkingConfigSchema = z.object({
  maxTokens: z.number().int().positive().default(512),
  overlapTokens: z.number().int().nonnegative().default(64),
  minTokens: z.number().int().positive().default(20),
  splitLargeClasses: z.boolean().default(true),
  splitLargeFunctions: z.boolean().default(true),
  largeNodeThresholdTokens: z.number().int().positive().default(800),
});

const RetrievalConfigSchema = z.object({
  maxCandidates: z.number().int().positive().default(50),
  vectorTopK: z.number().int().positive().default(20),
  ftsTopK: z.number().int().positive().default(20),
  graphExpansionDepth: z.number().int().nonnegative().default(2),
  graphExpansionLimit: z.number().int().positive().default(10),
  finalTopK: z.number().int().positive().default(10),
  hierarchical: z.boolean().default(true),
  compressionRatio: z.number().min(0.1).max(1.0).default(0.6),
});

const IndexingConfigSchema = z.object({
  batchSize: z.number().int().positive().default(50),
  parallelParsers: z.number().int().positive().default(4),
  watchDebounceMs: z.number().int().positive().default(500),
  snapshotEnabled: z.boolean().default(true),
  snapshotIntervalMinutes: z.number().int().positive().default(30),
  incrementalEnabled: z.boolean().default(true),
});

const CacheConfigSchema = z.object({
  semanticCacheEnabled: z.boolean().default(true),
  semanticSimilarityThreshold: z.number().min(0).max(1).default(0.92),
  queryCacheTtlSeconds: z.number().int().positive().default(3600),
  maxCacheEntries: z.number().int().positive().default(1000),
  persistPath: z.string().default('./data/cache/query-cache.db'),
});

const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  pretty: z.boolean().default(true),
  traceEnabled: z.boolean().default(false),
});

const IgnorePatternsSchema = z.array(z.string()).default([
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'bin/**',
  'obj/**',
  'coverage/**',
  '.cache/**',
  'venv/**',
  '__pycache__/**',
  '*.pyc',
  '*.pyo',
  '*.class',
  '*.o',
  '*.a',
  '*.so',
  '*.dll',
  '*.exe',
  '*.bin',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.min.js',
  '*.min.css',
  '*.map',
]);

const SummarizationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxChunkSummaryTokens: z.number().int().positive().default(100),
  maxFileSummaryTokens: z.number().int().positive().default(200),
  maxModuleSummaryTokens: z.number().int().positive().default(300),
  maxProjectSummaryTokens: z.number().int().positive().default(500),
  useLocalLlm: z.boolean().default(false),
  localLlmUrl: z.string().optional(),
});

const RagConfigSchema = z.object({
  dataDir: z.string().default('./data'),
  embedding: EmbeddingConfigSchema.default({}),
  rerank: RerankConfigSchema.default({}),
  qdrant: QdrantConfigSchema.default({}),
  sqlite: SqliteConfigSchema.default({}),
  chunking: ChunkingConfigSchema.default({}),
  retrieval: RetrievalConfigSchema.default({}),
  indexing: IndexingConfigSchema.default({}),
  cache: CacheConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  ignorePatterns: IgnorePatternsSchema,
  summarization: SummarizationConfigSchema.default({}),
});

export type RagConfig = z.infer<typeof RagConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type RerankConfig = z.infer<typeof RerankConfigSchema>;
export type QdrantConfig = z.infer<typeof QdrantConfigSchema>;
export type SqliteConfig = z.infer<typeof SqliteConfigSchema>;
export type ChunkingConfig = z.infer<typeof ChunkingConfigSchema>;
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
export type CacheConfig = z.infer<typeof CacheConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type SummarizationConfig = z.infer<typeof SummarizationConfigSchema>;

// ─── Loader ─────────────────────────────────────────────────────────────────

function loadConfigFile(configPath?: string): Record<string, unknown> {
  const candidates = [
    configPath,
    process.env['RAG_CONFIG'],
    './rag.config.json',
    './rag.config.js',
    join(process.env['HOME'] ?? '', '.config/superrag/config.json'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      try {
        const content = readFileSync(resolved, 'utf-8');
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        // continue
      }
    }
  }
  return {};
}

function mergeWithEnv(config: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...config };

  // Override from environment variables
  if (process.env['RAG_DATA_DIR']) merged['dataDir'] = process.env['RAG_DATA_DIR'];
  if (process.env['RAG_LOG_LEVEL']) {
    merged['logging'] = { ...(merged['logging'] as object ?? {}), level: process.env['RAG_LOG_LEVEL'] };
  }
  if (process.env['QDRANT_URL']) {
    merged['qdrant'] = { ...(merged['qdrant'] as object ?? {}), url: process.env['QDRANT_URL'] };
  }
  if (process.env['QDRANT_API_KEY']) {
    merged['qdrant'] = { ...(merged['qdrant'] as object ?? {}), apiKey: process.env['QDRANT_API_KEY'] };
  }
  if (process.env['RAG_EMBEDDING_URL']) {
    merged['embedding'] = { ...(merged['embedding'] as object ?? {}), serverUrl: process.env['RAG_EMBEDDING_URL'] };
  }
  if (process.env['RAG_RERANK_URL']) {
    merged['rerank'] = { ...(merged['rerank'] as object ?? {}), serverUrl: process.env['RAG_RERANK_URL'] };
  }

  return merged;
}

let _config: RagConfig | null = null;

export function loadConfig(configPath?: string): RagConfig {
  if (_config) return _config;

  const raw = loadConfigFile(configPath);
  const withEnv = mergeWithEnv(raw);
  const result = RagConfigSchema.safeParse(withEnv);

  if (!result.success) {
    console.error('Invalid RAG configuration:', result.error.format());
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): RagConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function resetConfig(): void {
  _config = null;
}

export { RagConfigSchema };
