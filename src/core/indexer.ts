import { resolve, relative, dirname, basename } from 'path';
import pLimit from 'p-limit';
import { getLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { generateId } from '../utils/hash.js';
import { scanDirectory, computeDelta, createFingerprint } from './scanner.js';
import { parseFile } from '../parsers/index.js';
import { chunkDocument } from '../chunking/chunker.js';
import { enrichChunks } from '../summarization/enricher.js';
import {
  summarizeFile,
  summarizeModule,
  summarizeProject,
} from '../summarization/summarizer.js';
import { getEmbeddingClient } from '../embeddings/client.js';
import {
  getDb,
  getAllFingerprints,
  upsertFingerprints,
  upsertChunks as sqliteUpsertChunks,
  deleteChunksByDocument,
  deleteFingerprint,
  upsertFileSummary,
  upsertModuleSummary,
  upsertProjectSummary,
  recordIndexingMetrics,
} from '../storage/sqlite.js';
import {
  ensureCollections,
  upsertChunks as qdrantUpsertChunks,
  deleteChunksByPath,
} from '../storage/qdrant.js';
import {
  initGraphSchema,
  upsertNode,
  upsertEdge,
  deleteNodesByPath,
} from '../graph/graph.js';
import type { IndexingResult, IndexingError, StructuredDocument, Chunk } from '../types/index.js';

const logger = getLogger('indexer');

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface IndexerOptions {
  projectPath: string;
  force?: boolean;
  onProgress?: (event: IndexProgressEvent) => void;
}

export interface IndexProgressEvent {
  phase: 'scan' | 'parse' | 'chunk' | 'embed' | 'store' | 'graph' | 'summarize';
  current: number;
  total: number;
  file?: string;
}

// ─── indexProject ─────────────────────────────────────────────────────────────

export async function indexProject(options: IndexerOptions): Promise<IndexingResult> {
  const { projectPath, force = false, onProgress } = options;
  const absoluteRoot = resolve(projectPath);
  const config = getConfig().indexing;
  const startTime = Date.now();

  const errors: IndexingError[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let embeddingsGenerated = 0;

  // 1. Initialize storage
  ensureCollections().catch(err => logger.warn({ err }, 'ensureCollections failed (non-fatal)'));
  initGraphSchema();
  getDb(); // ensure schema

  // 2. Scan
  onProgress?.({ phase: 'scan', current: 0, total: 0 });
  const scanResult = await scanDirectory({ rootPath: absoluteRoot });
  const scannedFiles = scanResult.files;

  onProgress?.({ phase: 'scan', current: scannedFiles.length, total: scannedFiles.length });

  // 3. Compute delta
  let filesToProcess = scannedFiles;
  let deletedPaths: string[] = [];
  let newFilePaths: string[] = [];
  let modifiedFilePaths: string[] = [];
  let unchangedCount = 0;

  if (!force) {
    const prevFingerprints = getAllFingerprints();
    const delta = computeDelta(prevFingerprints, scannedFiles);
    filesToProcess = [...delta.newFiles, ...delta.modifiedFiles];
    deletedPaths = delta.deletedPaths;
    newFilePaths = delta.newFiles.map(f => f.relativePath);
    modifiedFilePaths = delta.modifiedFiles.map(f => f.relativePath);
    unchangedCount = delta.unchangedFiles.length;
  } else {
    newFilePaths = scannedFiles.map(f => f.relativePath);
  }

  // 4. Handle deleted files
  for (const relPath of deletedPaths) {
    try {
      const docId = generateId('doc', relPath);
      deleteChunksByDocument(docId);
      deleteFingerprint(relPath);
      await deleteChunksByPath(relPath);
      deleteNodesByPath(relPath);
      logger.debug({ path: relPath }, 'Deleted file removed from index');
    } catch (err) {
      errors.push({ path: relPath, phase: 'store', error: String(err) });
    }
  }

  // 5. Process files in batches
  const limit = pLimit(config.parallelParsers);
  const batchSize = config.batchSize;

  // Collect all docs+chunks for summarization later
  const allDocs: StructuredDocument[] = [];
  const docChunksMap = new Map<string, Chunk[]>();

  for (let batchStart = 0; batchStart < filesToProcess.length; batchStart += batchSize) {
    const batch = filesToProcess.slice(batchStart, batchStart + batchSize);

    // Parse + chunk + enrich in parallel
    const parseResults = await Promise.all(
      batch.map((scannedFile, idx) =>
        limit(async () => {
          const current = batchStart + idx + 1;
          onProgress?.({ phase: 'parse', current, total: filesToProcess.length, file: scannedFile.relativePath });

          try {
            const doc = await parseFile(scannedFile);
            if (!doc) {
              errors.push({ path: scannedFile.relativePath, phase: 'parse', error: 'Parser returned null' });
              return null;
            }

            onProgress?.({ phase: 'chunk', current, total: filesToProcess.length, file: scannedFile.relativePath });
            const rawChunks = chunkDocument(doc);
            const chunks = enrichChunks(rawChunks);

            return { scannedFile, doc, chunks };
          } catch (err) {
            errors.push({ path: scannedFile.relativePath, phase: 'parse', error: String(err) });
            return null;
          }
        })
      )
    );

    const validResults = parseResults.filter((r): r is NonNullable<typeof r> => r !== null);

    if (validResults.length === 0) continue;

    // Embed batch
    const allTexts = validResults.flatMap(r => r.chunks.map(c => `${c.title}\n${c.content}`));
    let embeddings: number[][] = [];

    try {
      onProgress?.({ phase: 'embed', current: batchStart, total: filesToProcess.length });
      const embResult = await getEmbeddingClient().embedBatch(allTexts);
      embeddings = embResult.embeddings;
      embeddingsGenerated += embeddings.length;
    } catch (err) {
      // If embedding fails, use zero vectors
      logger.warn({ err }, 'Embedding failed, using zero vectors');
      const dims = getConfig().qdrant.vectorSize;
      embeddings = allTexts.map(() => new Array(dims).fill(0) as number[]);
    }

    // Store
    onProgress?.({ phase: 'store', current: batchStart, total: filesToProcess.length });

    let embIdx = 0;
    for (const { scannedFile, doc, chunks } of validResults) {
      try {
        // SQLite
        upsertFingerprints([scannedFile]);
        sqliteUpsertChunks(chunks.map(c => ({ chunk: c, content: c.content })));

        // Qdrant
        const points = chunks.map(c => ({
          id: c.id,
          vector: embeddings[embIdx++] ?? new Array(getConfig().qdrant.vectorSize).fill(0) as number[],
          chunk: c,
        }));
        await qdrantUpsertChunks(points);

        // Graph
        onProgress?.({ phase: 'graph', current: batchStart, total: filesToProcess.length, file: scannedFile.relativePath });
        _buildGraph(doc, chunks);

        allDocs.push(doc);
        docChunksMap.set(doc.id, chunks);
        chunksCreated += chunks.length;
        filesIndexed++;
      } catch (err) {
        errors.push({ path: scannedFile.relativePath, phase: 'store', error: String(err) });
      }
    }
  }

  // 6. Hierarchical summarization
  onProgress?.({ phase: 'summarize', current: 0, total: allDocs.length });

  const fileSummaries = [];
  for (const doc of allDocs) {
    const chunks = docChunksMap.get(doc.id) ?? [];
    try {
      const summary = summarizeFile(doc, chunks);
      upsertFileSummary(summary);
      fileSummaries.push(summary);
    } catch (err) {
      logger.warn({ path: doc.relativePath, err }, 'File summarization failed');
    }
  }

  // Group by module (first-level directory)
  const moduleMap = new Map<string, { summaries: typeof fileSummaries; docs: StructuredDocument[] }>();
  for (let i = 0; i < fileSummaries.length; i++) {
    const summary = fileSummaries[i]!;
    const doc = allDocs[i]!;
    const parts = summary.path.split('/');
    const moduleName = parts.length > 1 ? parts[0]! : '_root';
    const entry = moduleMap.get(moduleName) ?? { summaries: [], docs: [] };
    entry.summaries.push(summary);
    entry.docs.push(doc);
    moduleMap.set(moduleName, entry);
  }

  const moduleSummaries = [];
  for (const [moduleName, { summaries, docs }] of moduleMap) {
    try {
      const modSummary = summarizeModule(moduleName, summaries, docs);
      upsertModuleSummary(modSummary);
      moduleSummaries.push(modSummary);
    } catch (err) {
      logger.warn({ moduleName, err }, 'Module summarization failed');
    }
  }

  if (moduleSummaries.length > 0) {
    try {
      const projectName = basename(absoluteRoot);
      const projectSummary = summarizeProject(projectName, moduleSummaries, allDocs);
      upsertProjectSummary(projectSummary);
    } catch (err) {
      logger.warn({ err }, 'Project summarization failed');
    }
  }

  // 7. Record metrics
  const durationMs = Date.now() - startTime;
  try {
    recordIndexingMetrics({
      projectPath: absoluteRoot,
      filesScanned: scannedFiles.length,
      filesIndexed,
      chunksCreated,
      embeddingsGenerated,
      durationMs,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to record metrics');
  }

  logger.info(
    { filesScanned: scannedFiles.length, filesIndexed, chunksCreated, errors: errors.length, durationMs },
    'Indexing complete'
  );

  return {
    projectPath: absoluteRoot,
    filesScanned: scannedFiles.length,
    filesIndexed,
    filesSkipped: unchangedCount,
    chunksCreated,
    embeddingsGenerated,
    errors,
    durationMs,
    incrementalDelta: {
      newFiles: newFilePaths,
      modifiedFiles: modifiedFilePaths,
      deletedFiles: deletedPaths,
      unchangedFiles: unchangedCount,
    },
  };
}

// ─── indexFile ────────────────────────────────────────────────────────────────

export async function indexFile(absolutePath: string, projectPath: string): Promise<void> {
  const absoluteRoot = resolve(projectPath);
  const relPath = relative(absoluteRoot, absolutePath);

  const fp = await createFingerprint(absolutePath, relPath);
  const scannedFile = {
    ...fp,
    relativePath: relPath,
    extension: '.' + absolutePath.split('.').pop()!,
    language: null,
    category: 'unknown' as const,
  };

  const doc = await parseFile(scannedFile);
  if (!doc) {
    logger.warn({ path: relPath }, 'indexFile: parser returned null');
    return;
  }

  const rawChunks = chunkDocument(doc);
  const chunks = enrichChunks(rawChunks);

  const texts = chunks.map(c => `${c.title}\n${c.content}`);
  let embeddings: number[][] = [];
  try {
    const embResult = await getEmbeddingClient().embedBatch(texts);
    embeddings = embResult.embeddings;
  } catch {
    const dims = getConfig().qdrant.vectorSize;
    embeddings = texts.map(() => new Array(dims).fill(0) as number[]);
  }

  upsertFingerprints([fp]);
  sqliteUpsertChunks(chunks.map(c => ({ chunk: c, content: c.content })));

  const points = chunks.map((c, i) => ({
    id: c.id,
    vector: embeddings[i] ?? new Array(getConfig().qdrant.vectorSize).fill(0) as number[],
    chunk: c,
  }));
  await qdrantUpsertChunks(points);

  _buildGraph(doc, chunks);

  logger.debug({ path: relPath, chunks: chunks.length }, 'indexFile complete');
}

// ─── removeFile ───────────────────────────────────────────────────────────────

export async function removeFile(relativePath: string, _projectPath: string): Promise<void> {
  const docId = generateId('doc', relativePath);
  deleteChunksByDocument(docId);
  deleteFingerprint(relativePath);
  await deleteChunksByPath(relativePath);
  deleteNodesByPath(relativePath);
  logger.debug({ path: relativePath }, 'removeFile complete');
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _buildGraph(doc: StructuredDocument, chunks: Chunk[]): void {
  try {
    // Document node
    upsertNode({
      id: doc.id,
      kind: 'document',
      label: doc.relativePath,
      path: doc.relativePath,
      metadata: { language: doc.language, module: doc.module },
    });

    // Chunk nodes + contains edges
    for (const chunk of chunks) {
      upsertNode({
        id: chunk.id,
        kind: 'chunk',
        label: chunk.title,
        path: doc.relativePath,
        metadata: { kind: chunk.kind, domain: chunk.metadata.domain },
      });

      upsertEdge({
        id: generateId('edge', doc.id, chunk.id, 'contains'),
        sourceId: doc.id,
        targetId: chunk.id,
        kind: 'contains',
        weight: 1.0,
      });
    }

    // Dependency edges
    for (const dep of doc.dependencies) {
      const depId = generateId('doc', dep);
      upsertEdge({
        id: generateId('edge', doc.id, depId, 'depends_on'),
        sourceId: doc.id,
        targetId: depId,
        kind: 'depends_on',
        weight: 0.8,
      });
    }
  } catch (err) {
    logger.warn({ path: doc.relativePath, err }, 'Graph build failed (non-fatal)');
  }
}
