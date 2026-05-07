import { QdrantClient } from '@qdrant/js-client-rest';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import type { Chunk, FileSummary, ModuleSummary } from '../types/index.js';

const logger = getLogger('qdrant');

// ─── Collection Names ─────────────────────────────────────────────────────────

export function getCollectionName(kind: 'chunks' | 'files' | 'modules' | 'documents'): string {
  const config = getConfig().qdrant;
  return `${config.collectionPrefix}_${kind}`;
}

// ─── Client Singleton ─────────────────────────────────────────────────────────

let _client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!_client) {
    const config = getConfig().qdrant;
    _client = new QdrantClient({
      url: config.url,
      apiKey: config.apiKey,
    });
  }
  return _client;
}

// ─── Collection Management ────────────────────────────────────────────────────

export async function ensureCollections(): Promise<void> {
  const client = getQdrantClient();
  const config = getConfig().qdrant;
  const collections = ['chunks', 'files', 'modules', 'documents'] as const;

  for (const kind of collections) {
    const name = getCollectionName(kind);
    try {
      await client.getCollection(name);
      logger.debug({ collection: name }, 'Collection exists');
    } catch {
      logger.info({ collection: name }, 'Creating collection');
      await client.createCollection(name, {
        vectors: {
          size: config.vectorSize,
          distance: 'Cosine',
          on_disk: config.onDiskPayload,
        },
        optimizers_config: {
          default_segment_number: 2,
        },
        replication_factor: 1,
      });

      // Create payload indexes for fast filtering
      if (kind === 'chunks') {
        await client.createPayloadIndex(name, {
          field_name: 'relativePath',
          field_schema: 'keyword',
        });
        await client.createPayloadIndex(name, {
          field_name: 'language',
          field_schema: 'keyword',
        });
        await client.createPayloadIndex(name, {
          field_name: 'kind',
          field_schema: 'keyword',
        });
        await client.createPayloadIndex(name, {
          field_name: 'domain',
          field_schema: 'keyword',
        });
        await client.createPayloadIndex(name, {
          field_name: 'documentId',
          field_schema: 'keyword',
        });
      }

      logger.info({ collection: name }, 'Collection created');
    }
  }
}

export async function deleteCollection(kind: 'chunks' | 'files' | 'modules' | 'documents'): Promise<void> {
  const client = getQdrantClient();
  const name = getCollectionName(kind);
  try {
    await client.deleteCollection(name);
    logger.info({ collection: name }, 'Collection deleted');
  } catch (err) {
    logger.warn({ collection: name, err }, 'Failed to delete collection');
  }
}

export async function deleteAllCollections(): Promise<void> {
  for (const kind of ['chunks', 'files', 'modules', 'documents'] as const) {
    await deleteCollection(kind);
  }
}

// ─── Chunk Vectors ────────────────────────────────────────────────────────────

export interface ChunkPoint {
  id: string;
  vector: number[];
  chunk: Chunk;
}

export async function upsertChunks(points: ChunkPoint[]): Promise<void> {
  if (points.length === 0) return;

  const client = getQdrantClient();
  const collection = getCollectionName('chunks');

  const qdrantPoints = points.map(p => ({
    id: stableId(p.id),
    vector: p.vector,
    payload: {
      chunkId: p.chunk.id,
      documentId: p.chunk.documentId,
      relativePath: p.chunk.relativePath,
      kind: p.chunk.kind,
      language: p.chunk.language ?? '',
      title: p.chunk.title,
      summary: p.chunk.summary,
      tags: p.chunk.tags,
      tokenEstimate: p.chunk.tokenEstimate,
      startLine: p.chunk.startLine,
      endLine: p.chunk.endLine,
      domain: p.chunk.metadata.domain ?? 'unknown',
      complexity: p.chunk.metadata.complexity ?? 'low',
      isPublicApi: p.chunk.metadata.isPublicApi ?? false,
    },
  }));

  // Upsert in batches of 100
  for (let i = 0; i < qdrantPoints.length; i += 100) {
    const batch = qdrantPoints.slice(i, i + 100);
    await client.upsert(collection, {
      wait: true,
      points: batch,
    });
  }

  logger.debug({ collection, count: points.length }, 'Chunks upserted');
}

export async function searchChunks(
  vector: number[],
  options: {
    topK?: number;
    filter?: Record<string, unknown>;
    scoreThreshold?: number;
  } = {}
): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
  const client = getQdrantClient();
  const collection = getCollectionName('chunks');

  const results = await client.search(collection, {
    vector,
    limit: options.topK ?? 20,
    score_threshold: options.scoreThreshold ?? 0.3,
    with_payload: true,
    filter: options.filter as Parameters<typeof client.search>[1]['filter'],
  });

  return results.map(r => ({
    id: String(r.id),
    score: r.score,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

export async function deleteChunksByDocument(documentId: string): Promise<void> {
  const client = getQdrantClient();
  const collection = getCollectionName('chunks');

  await client.delete(collection, {
    wait: true,
    filter: {
      must: [
        { key: 'documentId', match: { value: documentId } },
      ],
    },
  });

  logger.debug({ collection, documentId }, 'Chunks deleted by document');
}

// ─── File Vectors ─────────────────────────────────────────────────────────────

export interface FilePoint {
  id: string;
  vector: number[];
  summary: FileSummary;
}

export async function upsertFiles(points: FilePoint[]): Promise<void> {
  if (points.length === 0) return;

  const client = getQdrantClient();
  const collection = getCollectionName('files');

  const qdrantPoints = points.map(p => ({
    id: stableId(p.id),
    vector: p.vector,
    payload: {
      fileId: p.summary.fileId,
      path: p.summary.path,
      summary: p.summary.summary,
      purpose: p.summary.purpose,
      domain: p.summary.domain,
      tags: p.summary.tags,
      exports: p.summary.exports,
    },
  }));

  await client.upsert(collection, { wait: true, points: qdrantPoints });
  logger.debug({ collection, count: points.length }, 'Files upserted');
}

export async function searchFiles(
  vector: number[],
  topK = 10
): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
  const client = getQdrantClient();
  const collection = getCollectionName('files');

  const results = await client.search(collection, {
    vector,
    limit: topK,
    with_payload: true,
  });

  return results.map(r => ({
    id: String(r.id),
    score: r.score,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

// ─── Module Vectors ───────────────────────────────────────────────────────────

export interface ModulePoint {
  id: string;
  vector: number[];
  summary: ModuleSummary;
}

export async function upsertModules(points: ModulePoint[]): Promise<void> {
  if (points.length === 0) return;

  const client = getQdrantClient();
  const collection = getCollectionName('modules');

  const qdrantPoints = points.map(p => ({
    id: stableId(p.id),
    vector: p.vector,
    payload: {
      moduleId: p.summary.moduleId,
      name: p.summary.name,
      summary: p.summary.summary,
      domain: p.summary.domain,
      tags: p.summary.tags,
      files: p.summary.files,
    },
  }));

  await client.upsert(collection, { wait: true, points: qdrantPoints });
  logger.debug({ collection, count: points.length }, 'Modules upserted');
}

export async function searchModules(
  vector: number[],
  topK = 5
): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
  const client = getQdrantClient();
  const collection = getCollectionName('modules');

  const results = await client.search(collection, {
    vector,
    limit: topK,
    with_payload: true,
  });

  return results.map(r => ({
    id: String(r.id),
    score: r.score,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getCollectionStats(): Promise<Record<string, { count: number; status: string }>> {
  const client = getQdrantClient();
  const stats: Record<string, { count: number; status: string }> = {};

  for (const kind of ['chunks', 'files', 'modules', 'documents'] as const) {
    const name = getCollectionName(kind);
    try {
      const info = await client.getCollection(name);
      stats[kind] = {
        count: info.points_count ?? 0,
        status: info.status ?? 'unknown',
      };
    } catch {
      stats[kind] = { count: 0, status: 'missing' };
    }
  }

  return stats;
}

// ─── Delete by Path ───────────────────────────────────────────────────────────

export async function deleteChunksByPath(relativePath: string): Promise<void> {
  const client = getQdrantClient();
  const collection = getCollectionName('chunks');

  await client.delete(collection, {
    wait: true,
    filter: {
      must: [
        { key: 'relativePath', match: { value: relativePath } },
      ],
    },
  });

  logger.debug({ collection, relativePath }, 'Chunks deleted by path');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a string ID to a stable ID for Qdrant.
 * Qdrant accepts UUID strings natively — we use the raw string directly.
 */
function stableId(id: string): string {
  return id;
}
