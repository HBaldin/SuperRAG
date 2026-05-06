import { generateId } from '../utils/hash.js';
import { estimateTokens } from '../utils/tokens.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import type {
  StructuredDocument,
  Chunk,
  ChunkKind,
  Symbol,
} from '../types/index.js';

const logger = getLogger('chunker');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeChunkId(docId: string, index: number): string {
  return generateId('chunk', docId, String(index));
}

function extractTitle(symbol: Symbol): string {
  return `${symbol.kind}: ${symbol.name}`;
}

function getContentLines(rawText: string, startLine: number, endLine: number): string {
  const lines = rawText.split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

// ─── Code Chunker ─────────────────────────────────────────────────────────────

function chunkCodeDocument(doc: StructuredDocument): Chunk[] {
  const config = getConfig().chunking;
  const chunks: Chunk[] = [];
  let idx = 0;

  // Group symbols by kind
  const topLevel = doc.symbols.filter(s =>
    s.kind === 'class' || s.kind === 'interface' || s.kind === 'function' || s.kind === 'module'
  );

  const methods = doc.symbols.filter(s => s.kind === 'method');

  if (topLevel.length === 0) {
    // No structured symbols — chunk by line blocks
    return chunkByLineBlocks(doc, config.maxTokens);
  }

  for (const symbol of topLevel) {
    const content = getContentLines(doc.rawText, symbol.startLine, symbol.endLine);
    const tokens = estimateTokens(content);

    if (symbol.kind === 'class' && tokens > config.largeNodeThresholdTokens && config.splitLargeClasses) {
      // Split class into method chunks
      const classMethods = methods.filter(
        m => m.startLine >= symbol.startLine && m.endLine <= symbol.endLine
      );

      if (classMethods.length > 0) {
        // Class header chunk (everything before first method)
        const headerEnd = classMethods[0]!.startLine - 1;
        const headerContent = getContentLines(doc.rawText, symbol.startLine, headerEnd);
        if (estimateTokens(headerContent) >= config.minTokens) {
          chunks.push(buildChunk(doc, makeChunkId(doc.id, idx++), null, 'class', symbol.name + ' (header)', headerContent, symbol.startLine, headerEnd));
        }

        // Each method as its own chunk
        for (const method of classMethods) {
          const methodContent = getContentLines(doc.rawText, method.startLine, method.endLine);
          if (estimateTokens(methodContent) >= config.minTokens) {
            chunks.push(buildChunk(doc, makeChunkId(doc.id, idx++), null, 'method', `${symbol.name}.${method.name}`, methodContent, method.startLine, method.endLine));
          }
        }
        continue;
      }
    }

    if (tokens > config.maxTokens) {
      // Split large function/block by sub-blocks
      const subChunks = splitLargeContent(doc, symbol, content, config.maxTokens, config.overlapTokens, idx);
      for (const sc of subChunks) {
        chunks.push(sc);
        idx++;
      }
      continue;
    }

    if (tokens < config.minTokens) continue;

    const kind: ChunkKind = symbol.kind === 'method' ? 'method' :
      symbol.kind === 'class' ? 'class' :
      symbol.kind === 'interface' ? 'interface' :
      'function';

    chunks.push(buildChunk(doc, makeChunkId(doc.id, idx++), null, kind, extractTitle(symbol), content, symbol.startLine, symbol.endLine));
  }

  // If no chunks produced, fallback
  if (chunks.length === 0) {
    return chunkByLineBlocks(doc, config.maxTokens);
  }

  return chunks;
}

// ─── Document Chunker ─────────────────────────────────────────────────────────

function chunkDocumentBySection(doc: StructuredDocument): Chunk[] {
  const config = getConfig().chunking;
  const chunks: Chunk[] = [];
  let idx = 0;

  if (doc.sections.length === 0) {
    return chunkByLineBlocks(doc, config.maxTokens);
  }

  for (const section of doc.sections) {
    const tokens = estimateTokens(section.content);

    if (tokens < config.minTokens) continue;

    if (tokens > config.maxTokens) {
      // Split large section into paragraphs
      const paragraphs = section.content.split(/\n\n+/);
      let paraIdx = 0;
      let buffer = '';
      let bufferTokens = 0;

      for (const para of paragraphs) {
        const paraTokens = estimateTokens(para);
        if (bufferTokens + paraTokens > config.maxTokens && buffer.length > 0) {
          chunks.push(buildChunk(doc, makeChunkId(doc.id, idx++), null, 'paragraph', `${section.title} (part ${paraIdx + 1})`, buffer.trim(), section.startLine, section.endLine));
          buffer = '';
          bufferTokens = 0;
          paraIdx++;
        }
        buffer += (buffer ? '\n\n' : '') + para;
        bufferTokens += paraTokens;
      }

      if (buffer.trim().length > 0 && estimateTokens(buffer) >= config.minTokens) {
        chunks.push(buildChunk(doc, makeChunkId(doc.id, idx++), null, 'paragraph', `${section.title} (part ${paraIdx + 1})`, buffer.trim(), section.startLine, section.endLine));
      }
      continue;
    }

    const kind: ChunkKind = doc.type === 'config' ? 'config-block' :
      section.level === 1 ? 'section' : 'paragraph';

    chunks.push(buildChunk(doc, makeChunkId(doc.id, idx++), null, kind, section.title, section.content, section.startLine, section.endLine));
  }

  return chunks;
}

// ─── Line Block Chunker (fallback) ───────────────────────────────────────────

function chunkByLineBlocks(doc: StructuredDocument, maxTokens: number): Chunk[] {
  const config = getConfig().chunking;
  const lines = doc.rawText.split('\n');
  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let startLine = 1;
  let idx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineTokens = estimateTokens(line);

    if (bufferTokens + lineTokens > maxTokens && buffer.length > 0) {
      const content = buffer.join('\n');
      if (estimateTokens(content) >= config.minTokens) {
        chunks.push(buildChunk(doc, makeChunkId(doc.id, idx++), null, 'fallback', `lines ${startLine}-${i}`, content, startLine, i));
      }
      // Overlap: keep last N lines
      const overlapLines = Math.ceil(config.overlapTokens / 4);
      buffer = buffer.slice(-overlapLines);
      bufferTokens = estimateTokens(buffer.join('\n'));
      startLine = i - overlapLines + 1;
    }

    buffer.push(line);
    bufferTokens += lineTokens;
  }

  if (buffer.length > 0) {
    const content = buffer.join('\n');
    if (estimateTokens(content) >= config.minTokens) {
      chunks.push(buildChunk(doc, makeChunkId(doc.id, idx++), null, 'fallback', `lines ${startLine}-${lines.length}`, content, startLine, lines.length));
    }
  }

  return chunks;
}

// ─── Split Large Content ──────────────────────────────────────────────────────

function splitLargeContent(
  doc: StructuredDocument,
  symbol: Symbol,
  content: string,
  maxTokens: number,
  overlapTokens: number,
  startIdx: number
): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let localIdx = 0;

  for (const line of lines) {
    const lt = estimateTokens(line);
    if (bufferTokens + lt > maxTokens && buffer.length > 0) {
      chunks.push(buildChunk(
        doc,
        makeChunkId(doc.id, startIdx + localIdx),
        null,
        'function',
        `${symbol.name} (part ${localIdx + 1})`,
        buffer.join('\n'),
        symbol.startLine,
        symbol.endLine
      ));
      localIdx++;
      const overlapLines = Math.ceil(overlapTokens / 4);
      buffer = buffer.slice(-overlapLines);
      bufferTokens = estimateTokens(buffer.join('\n'));
    }
    buffer.push(line);
    bufferTokens += lt;
  }

  if (buffer.length > 0) {
    chunks.push(buildChunk(
      doc,
      makeChunkId(doc.id, startIdx + localIdx),
      null,
      'function',
      `${symbol.name} (part ${localIdx + 1})`,
      buffer.join('\n'),
      symbol.startLine,
      symbol.endLine
    ));
  }

  return chunks;
}

// ─── Chunk Builder ────────────────────────────────────────────────────────────

function buildChunk(
  doc: StructuredDocument,
  id: string,
  parentId: string | null,
  kind: ChunkKind,
  title: string,
  content: string,
  startLine: number,
  endLine: number
): Chunk {
  return {
    id,
    parentId,
    documentId: doc.id,
    path: doc.path,
    relativePath: doc.relativePath,
    kind,
    language: doc.language,
    title,
    content,
    summary: '', // filled by summarizer
    tags: [],    // filled by enricher
    dependencies: doc.dependencies,
    references: [],
    tokenEstimate: estimateTokens(content),
    startLine,
    endLine,
    embeddingRef: null,
    metadata: {},
  };
}

// ─── Main Chunker ─────────────────────────────────────────────────────────────

export function chunkDocument(doc: StructuredDocument): Chunk[] {
  logger.debug({ path: doc.relativePath, type: doc.type }, 'Chunking document');

  let chunks: Chunk[];

  switch (doc.type) {
    case 'code':
      chunks = chunkCodeDocument(doc);
      break;
    case 'documentation':
    case 'config':
    case 'data':
      chunks = chunkDocumentBySection(doc);
      break;
    default:
      chunks = chunkByLineBlocks(doc, getConfig().chunking.maxTokens);
  }

  logger.debug({ path: doc.relativePath, chunks: chunks.length }, 'Chunking complete');
  return chunks;
}

export function chunkDocuments(docs: StructuredDocument[]): Chunk[] {
  return docs.flatMap(doc => chunkDocument(doc));
}
