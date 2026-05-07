import { getLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { searchFts } from '../storage/sqlite.js';
import { searchChunks, searchFiles, searchModules } from '../storage/qdrant.js';
import { expandNeighbors } from '../graph/graph.js';
import { getEmbeddingClient } from '../embeddings/client.js';
import { getRerankClient } from '../reranking/client.js';
import { compressChunks } from '../compression/compressor.js';
import { estimateTokens } from '../utils/tokens.js';
import { getDb } from '../storage/sqlite.js';
import type {
  Chunk,
  RankedChunk,
  GraphEdge,
  QueryFilters,
} from '../types/index.js';

const logger = getLogger('retrieval');

// ─── Candidate Merging ────────────────────────────────────────────────────────

interface ScoredCandidate {
  chunkId: string;
  vectorScore: number;
  ftsScore: number;
  graphScore: number;
  payload: Record<string, unknown>;
}

function mergeScores(
  vectorResults: Array<{ id: string; score: number; payload: Record<string, unknown> }>,
  ftsResults: Array<{ chunkId: string; rank: number }>,
  graphChunkIds: Set<string>
): Map<string, ScoredCandidate> {
  const candidates = new Map<string, ScoredCandidate>();

  // Add vector results
  for (const r of vectorResults) {
    const id = r.payload['chunkId'] as string ?? r.id;
    candidates.set(id, {
      chunkId: id,
      vectorScore: r.score,
      ftsScore: 0,
      graphScore: 0,
      payload: r.payload,
    });
  }

  // Add/merge FTS results
  const maxFtsRank = Math.max(...ftsResults.map(r => Math.abs(r.rank)), 1);
  for (const r of ftsResults) {
    const normalizedFts = 1 - Math.abs(r.rank) / maxFtsRank;
    const existing = candidates.get(r.chunkId);
    if (existing) {
      existing.ftsScore = normalizedFts;
    } else {
      candidates.set(r.chunkId, {
        chunkId: r.chunkId,
        vectorScore: 0,
        ftsScore: normalizedFts,
        graphScore: 0,
        payload: {},
      });
    }
  }

  // Boost graph-expanded chunks
  for (const id of graphChunkIds) {
    const existing = candidates.get(id);
    if (existing) {
      existing.graphScore = 0.1;
    }
  }

  return candidates;
}

function computeHybridScore(candidate: ScoredCandidate): number {
  // Weighted combination: vector 60%, FTS 30%, graph 10%
  return (
    candidate.vectorScore * 0.6 +
    candidate.ftsScore * 0.3 +
    candidate.graphScore * 0.1
  );
}

// ─── Chunk Loader ─────────────────────────────────────────────────────────────

function loadChunkFromDb(chunkId: string): Chunk | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: row['id'] as string,
    parentId: row['parent_id'] as string | null,
    documentId: row['document_id'] as string,
    path: '',
    relativePath: row['relative_path'] as string,
    kind: row['kind'] as Chunk['kind'],
    language: row['language'] as string | null,
    title: row['title'] as string,
    content: '', // content not stored in chunks table — stored in FTS
    summary: row['summary'] as string,
    tags: JSON.parse(row['tags'] as string) as string[],
    dependencies: JSON.parse(row['dependencies'] as string) as string[],
    references: [],
    tokenEstimate: row['token_estimate'] as number,
    startLine: row['start_line'] as number,
    endLine: row['end_line'] as number,
    embeddingRef: row['embedding_ref'] as string | null,
    metadata: {
      domain: row['domain'] as Chunk['metadata']['domain'],
      complexity: row['complexity'] as Chunk['metadata']['complexity'],
      isPublicApi: (row['is_public_api'] as number) === 1,
    },
  };
}

function loadChunkContent(chunkId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT content FROM chunks_fts WHERE chunk_id = ?').get(chunkId) as { content: string } | undefined;
  return row?.content ?? '';
}

// ─── Main Retrieval ───────────────────────────────────────────────────────────

export interface RetrievalOptions {
  topK?: number;
  filters?: QueryFilters;
  includeGraph?: boolean;
  includeCompression?: boolean;
  vectorTopK?: number;
  ftsTopK?: number;
}

export interface RetrievalResult {
  chunks: RankedChunk[];
  relations: GraphEdge[];
  vectorTimeMs: number;
  ftsTimeMs: number;
  rerankTimeMs: number;
  compressionTimeMs: number;
  candidatesBeforeRerank: number;
  tokensBeforeCompression: number;
  tokensAfterCompression: number;
}

export async function retrieveChunks(
  query: string,
  queryEmbedding: number[],
  options: RetrievalOptions = {}
): Promise<RetrievalResult> {
  const config = getConfig().retrieval;
  const {
    topK = config.finalTopK,
    filters,
    includeGraph = true,
    includeCompression = true,
    vectorTopK = config.vectorTopK,
    ftsTopK = config.ftsTopK,
  } = options;

  let vectorTimeMs = 0;
  let ftsTimeMs = 0;
  let rerankTimeMs = 0;
  let compressionTimeMs = 0;

  // ── Step 1: Vector Search ──────────────────────────────────────────────────
  const t0 = Date.now();
  let vectorResults: Array<{ id: string; score: number; payload: Record<string, unknown> }> = [];
  try {
    const qdrantFilter = buildQdrantFilter(filters);
    vectorResults = await searchChunks(queryEmbedding, {
      topK: vectorTopK,
      filter: qdrantFilter,
    });
  } catch (err) {
    logger.warn({ err }, 'Vector search failed, continuing without');
  }
  vectorTimeMs = Date.now() - t0;

  // ── Step 2: FTS Search ─────────────────────────────────────────────────────
  const t1 = Date.now();
  let ftsResults: Array<{ chunkId: string; rank: number }> = [];
  try {
    ftsResults = searchFts(query, ftsTopK);
  } catch (err) {
    logger.warn({ err }, 'FTS search failed, continuing without');
  }
  ftsTimeMs = Date.now() - t1;

  // ── Step 3: Graph Expansion ────────────────────────────────────────────────
  const graphChunkIds = new Set<string>();
  let relations: GraphEdge[] = [];

  if (includeGraph && vectorResults.length > 0) {
    try {
      const topIds = vectorResults.slice(0, 5).map(r => r.payload['chunkId'] as string ?? r.id);
      const traversal = expandNeighbors(topIds, config.graphExpansionDepth, undefined, config.graphExpansionLimit);
      relations = traversal.edges;
      for (const node of traversal.nodes) {
        if (node.kind === 'chunk') graphChunkIds.add(node.id);
      }
    } catch (err) {
      logger.warn({ err }, 'Graph expansion failed, continuing without');
    }
  }

  // ── Step 4: Merge & Score ──────────────────────────────────────────────────
  const merged = mergeScores(vectorResults, ftsResults, graphChunkIds);
  const candidatesBeforeRerank = merged.size;

  // Sort by hybrid score
  const sorted = [...merged.values()]
    .map(c => ({ ...c, hybridScore: computeHybridScore(c) }))
    .sort((a, b) => b.hybridScore - a.hybridScore)
    .slice(0, config.maxCandidates);

  // ── Step 5: Load Chunk Data ────────────────────────────────────────────────
  const chunksWithContent: Array<{ chunk: Chunk; content: string; hybridScore: number }> = [];
  for (const candidate of sorted) {
    const chunk = loadChunkFromDb(candidate.chunkId);
    if (!chunk) continue;
    const content = loadChunkContent(candidate.chunkId);
    chunksWithContent.push({ chunk: { ...chunk, content }, content, hybridScore: candidate.hybridScore });
  }

  // ── Step 6: Reranking ──────────────────────────────────────────────────────
  const t2 = Date.now();
  let rankedChunks: RankedChunk[];

  const rerankConfig = getConfig().rerank;
  if (rerankConfig.enabled && chunksWithContent.length > 1) {
    try {
      const rerankClient = getRerankClient();
      const available = await rerankClient.isAvailable();

      if (available) {
        const docs = chunksWithContent.map(c => `${c.chunk.title}\n${c.content.slice(0, 500)}`);
        const rerankResult = await rerankClient.rerank(query, docs, topK);

        rankedChunks = rerankResult.scores.map(s => {
          const item = chunksWithContent[s.index]!;
          return {
            ...item.chunk,
            score: s.score,
            scoreBreakdown: {
              vector: sorted[s.index]?.vectorScore ?? 0,
              fts: sorted[s.index]?.ftsScore ?? 0,
              rerank: s.score,
              graph: sorted[s.index]?.graphScore ?? 0,
            },
          };
        });
      } else {
        rankedChunks = fallbackRank(chunksWithContent, sorted, topK);
      }
    } catch (err) {
      logger.warn({ err }, 'Reranking failed, using hybrid score');
      rankedChunks = fallbackRank(chunksWithContent, sorted, topK);
    }
  } else {
    rankedChunks = fallbackRank(chunksWithContent, sorted, topK);
  }
  rerankTimeMs = Date.now() - t2;

  // ── Step 7: Compression ────────────────────────────────────────────────────
  const t3 = Date.now();
  const tokensBeforeCompression = rankedChunks.reduce((sum, c) => sum + estimateTokens(c.content), 0);

  if (includeCompression) {
    rankedChunks = compressChunks(rankedChunks);
  }

  const tokensAfterCompression = rankedChunks.reduce((sum, c) => sum + estimateTokens(c.compressed ?? c.content), 0);
  compressionTimeMs = Date.now() - t3;

  logger.info({
    query: query.slice(0, 50),
    candidates: candidatesBeforeRerank,
    returned: rankedChunks.length,
    vectorMs: vectorTimeMs,
    ftsMs: ftsTimeMs,
    rerankMs: rerankTimeMs,
    compressionMs: compressionTimeMs,
    tokensSaved: tokensBeforeCompression - tokensAfterCompression,
  }, 'Retrieval complete');

  return {
    chunks: rankedChunks,
    relations,
    vectorTimeMs,
    ftsTimeMs,
    rerankTimeMs,
    compressionTimeMs,
    candidatesBeforeRerank,
    tokensBeforeCompression,
    tokensAfterCompression,
  };
}

function fallbackRank(
  chunksWithContent: Array<{ chunk: Chunk; content: string; hybridScore: number }>,
  sorted: Array<{ chunkId: string; hybridScore: number; vectorScore: number; ftsScore: number; graphScore: number }>,
  topK: number
): RankedChunk[] {
  return chunksWithContent.slice(0, topK).map((item, i) => ({
    ...item.chunk,
    score: item.hybridScore,
    scoreBreakdown: {
      vector: sorted[i]?.vectorScore ?? 0,
      fts: sorted[i]?.ftsScore ?? 0,
      rerank: 0,
      graph: sorted[i]?.graphScore ?? 0,
    },
  }));
}

function buildQdrantFilter(filters?: QueryFilters): Record<string, unknown> | undefined {
  if (!filters) return undefined;

  const must: Array<Record<string, unknown>> = [];

  if (filters.languages && filters.languages.length > 0) {
    must.push({ key: 'language', match: { any: filters.languages } });
  }
  if (filters.domains && filters.domains.length > 0) {
    must.push({ key: 'domain', match: { any: filters.domains } });
  }
  if (filters.kinds && filters.kinds.length > 0) {
    must.push({ key: 'kind', match: { any: filters.kinds } });
  }

  return must.length > 0 ? { must } : undefined;
}

// ─── Hierarchical Entry Point ─────────────────────────────────────────────────

export async function hierarchicalRetrieve(
  query: string,
  options: RetrievalOptions = {}
): Promise<RetrievalResult> {
  const config = getConfig().retrieval;

  if (!config.hierarchical) {
    // Flat retrieval
    const embeddingClient = getEmbeddingClient();
    const queryEmbedding = await embeddingClient.embed(query);
    return retrieveChunks(query, queryEmbedding, options);
  }

  // Hierarchical: embed query once, use for all levels
  let queryEmbedding: number[];
  try {
    const embeddingClient = getEmbeddingClient();
    queryEmbedding = await embeddingClient.embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed, using zero vector');
    queryEmbedding = new Array(getConfig().embedding.dimensions).fill(0) as number[];
  }

  // Step 1: Find relevant modules
  let relevantModuleNames: string[] = [];
  try {
    const moduleResults = await searchModules(queryEmbedding, 3);
    relevantModuleNames = moduleResults.map(r => r.payload['name'] as string).filter(Boolean);
  } catch {
    // continue without module filtering
  }

  // Step 2: Find relevant files
  let relevantFilePaths: string[] = [];
  try {
    const fileResults = await searchFiles(queryEmbedding, 10);
    relevantFilePaths = fileResults.map(r => r.payload['path'] as string).filter(Boolean);
  } catch {
    // continue without file filtering
  }

  // Step 3: Retrieve chunks with optional path filter
  const pathFilters = relevantFilePaths.length > 0 ? relevantFilePaths : undefined;
  const enhancedFilters: QueryFilters = {
    ...options.filters,
    paths: pathFilters,
  };

  // suppress unused variable warning
  void relevantModuleNames;

  return retrieveChunks(query, queryEmbedding, {
    ...options,
    filters: enhancedFilters,
  });
}
