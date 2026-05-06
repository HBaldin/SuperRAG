// ─── File System Types ───────────────────────────────────────────────────────

export interface FileFingerprint {
  path: string;
  absolutePath: string;
  hash: string;
  modifiedTime: number;
  size: number;
  encoding: string;
  mimeType: string;
  isBinary: boolean;
}

export interface ScannedFile extends FileFingerprint {
  relativePath: string;
  extension: string;
  language: string | null;
  category: FileCategory;
}

export type FileCategory =
  | 'code'
  | 'documentation'
  | 'config'
  | 'data'
  | 'infrastructure'
  | 'test'
  | 'build'
  | 'unknown';

// ─── Document Types ──────────────────────────────────────────────────────────

export interface StructuredDocument {
  id: string;
  path: string;
  relativePath: string;
  type: string;
  language: string | null;
  module: string | null;
  symbols: Symbol[];
  dependencies: string[];
  sections: DocumentSection[];
  rawText: string;
  metadata: DocumentMetadata;
  fingerprint: FileFingerprint;
}

export interface Symbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  docComment?: string;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isExported?: boolean;
  decorators?: string[];
  parameters?: SymbolParameter[];
  returnType?: string;
}

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'enum'
  | 'namespace'
  | 'module'
  | 'type'
  | 'variable'
  | 'constant'
  | 'decorator'
  | 'annotation';

export interface SymbolParameter {
  name: string;
  type?: string;
  defaultValue?: string;
  isOptional?: boolean;
}

export interface DocumentSection {
  id: string;
  title: string;
  level: number;
  content: string;
  startLine: number;
  endLine: number;
  subsections?: DocumentSection[];
}

export interface DocumentMetadata {
  title?: string;
  description?: string;
  author?: string;
  created?: string;
  modified?: string;
  version?: string;
  tags?: string[];
  imports?: string[];
  exports?: string[];
  framework?: string;
  testFile?: boolean;
  generatedFile?: boolean;
  [key: string]: unknown;
}

// ─── Chunk Types ─────────────────────────────────────────────────────────────

export interface Chunk {
  id: string;
  parentId: string | null;
  documentId: string;
  path: string;
  relativePath: string;
  kind: ChunkKind;
  language: string | null;
  title: string;
  content: string;
  summary: string;
  tags: string[];
  dependencies: string[];
  references: string[];
  tokenEstimate: number;
  startLine: number;
  endLine: number;
  embeddingRef: string | null;
  metadata: ChunkMetadata;
}

export type ChunkKind =
  | 'function'
  | 'method'
  | 'class'
  | 'class-body'
  | 'interface'
  | 'module'
  | 'section'
  | 'paragraph'
  | 'code-block'
  | 'config-block'
  | 'table'
  | 'list'
  | 'fallback';

export interface ChunkMetadata {
  domain?: SemanticDomain;
  complexity?: ComplexityLevel;
  responsibilities?: string[];
  patterns?: ArchitecturalPattern[];
  sideEffects?: string[];
  isEntryPoint?: boolean;
  isPublicApi?: boolean;
  [key: string]: unknown;
}

export type SemanticDomain =
  | 'backend'
  | 'frontend'
  | 'infra'
  | 'database'
  | 'security'
  | 'auth'
  | 'messaging'
  | 'logging'
  | 'config'
  | 'tests'
  | 'docs'
  | 'utils'
  | 'unknown';

export type ComplexityLevel = 'low' | 'medium' | 'high' | 'very-high';

export type ArchitecturalPattern =
  | 'singleton'
  | 'factory'
  | 'repository'
  | 'service'
  | 'controller'
  | 'middleware'
  | 'observer'
  | 'decorator'
  | 'adapter'
  | 'strategy'
  | 'command'
  | 'event-driven'
  | 'cqrs'
  | 'ddd';

// ─── Summary Types ───────────────────────────────────────────────────────────

export interface ChunkSummary {
  chunkId: string;
  summary: string;
  responsibilities: string[];
  inputs: string[];
  outputs: string[];
  dependencies: string[];
  sideEffects: string[];
  tags: string[];
}

export interface FileSummary {
  fileId: string;
  path: string;
  summary: string;
  purpose: string;
  exports: string[];
  dependencies: string[];
  architecturalRole: string;
  domain: SemanticDomain;
  tags: string[];
}

export interface ModuleSummary {
  moduleId: string;
  name: string;
  summary: string;
  purpose: string;
  files: string[];
  publicApi: string[];
  dependencies: string[];
  domain: SemanticDomain;
  tags: string[];
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  summary: string;
  purpose: string;
  modules: string[];
  mainLanguages: string[];
  frameworks: string[];
  architecturalPatterns: ArchitecturalPattern[];
  domains: SemanticDomain[];
  entryPoints: string[];
  tags: string[];
}

// ─── Graph Types ─────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export type GraphNodeKind = 'chunk' | 'file' | 'module' | 'document' | 'symbol';

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: GraphEdgeKind;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export type GraphEdgeKind =
  | 'calls'
  | 'imports'
  | 'depends_on'
  | 'extends'
  | 'implements'
  | 'references'
  | 'mentions'
  | 'contains'
  | 'exports';

// ─── Query Types ─────────────────────────────────────────────────────────────

export interface QueryRequest {
  query: string;
  projectPath?: string;
  topK?: number;
  includeGraph?: boolean;
  includeCompressed?: boolean;
  filters?: QueryFilters;
}

export interface QueryFilters {
  languages?: string[];
  domains?: SemanticDomain[];
  paths?: string[];
  kinds?: ChunkKind[];
  tags?: string[];
}

export interface QueryResult {
  query: string;
  rewrittenQuery: string;
  intent: QueryIntent;
  chunks: RankedChunk[];
  summaries: {
    project?: ProjectSummary;
    modules?: ModuleSummary[];
    files?: FileSummary[];
  };
  relations: GraphEdge[];
  metadata: QueryMetadata;
}

export interface RankedChunk extends Chunk {
  score: number;
  scoreBreakdown: {
    vector: number;
    fts: number;
    rerank: number;
    graph: number;
  };
  compressed?: string;
}

export type QueryIntent =
  | 'find-implementation'
  | 'find-usage'
  | 'understand-architecture'
  | 'find-definition'
  | 'find-configuration'
  | 'find-test'
  | 'find-documentation'
  | 'debug'
  | 'general';

export interface QueryMetadata {
  totalTimeMs: number;
  parseTimeMs: number;
  vectorTimeMs: number;
  ftsTimeMs: number;
  rerankTimeMs: number;
  compressionTimeMs: number;
  cacheHit: boolean;
  candidatesBeforeRerank: number;
  tokensBeforeCompression: number;
  tokensAfterCompression: number;
  tokensSaved: number;
}

// ─── Indexing Types ──────────────────────────────────────────────────────────

export interface IndexingResult {
  projectPath: string;
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  embeddingsGenerated: number;
  errors: IndexingError[];
  durationMs: number;
  incrementalDelta?: IncrementalDelta;
}

export interface IncrementalDelta {
  newFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  unchangedFiles: number;
}

export interface IndexingError {
  path: string;
  phase: 'scan' | 'parse' | 'chunk' | 'embed' | 'store';
  error: string;
}

// ─── Embedding Types ─────────────────────────────────────────────────────────

export interface EmbeddingRequest {
  texts: string[];
  model?: string;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
  durationMs: number;
}

// ─── Rerank Types ────────────────────────────────────────────────────────────

export interface RerankRequest {
  query: string;
  documents: string[];
  topK?: number;
}

export interface RerankResponse {
  scores: Array<{ index: number; score: number }>;
  model: string;
  durationMs: number;
}

// ─── Metrics Types ───────────────────────────────────────────────────────────

export interface SystemMetrics {
  indexing: {
    totalFiles: number;
    totalChunks: number;
    totalEmbeddings: number;
    lastIndexedAt: string | null;
    avgParseTimeMs: number;
    avgEmbedTimeMs: number;
  };
  retrieval: {
    totalQueries: number;
    avgQueryTimeMs: number;
    cacheHitRate: number;
    avgTokensSaved: number;
    avgPrecisionEstimate: number;
  };
  storage: {
    sqliteSizeBytes: number;
    vectorStoreSizeBytes: number;
    cacheSizeBytes: number;
  };
}

// ─── Context Package (Agent Adapter) ─────────────────────────────────────────

export interface ContextPackage {
  query: string;
  summaries: {
    project?: ProjectSummary;
    modules?: ModuleSummary[];
    files?: FileSummary[];
  };
  chunks: RankedChunk[];
  relations: GraphEdge[];
  metadata: QueryMetadata & {
    projectPath: string;
    indexedAt: string;
  };
}
