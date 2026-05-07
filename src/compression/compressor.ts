import { getLogger } from '../utils/logger.js';
import { estimateTokens } from '../utils/tokens.js';
import { getConfig } from '../config/index.js';
import type { Chunk, RankedChunk } from '../types/index.js';

const logger = getLogger('compressor');

// ─── Line-level Compression ───────────────────────────────────────────────────

const BOILERPLATE_PATTERNS = [
  /^\s*\/\/.*$/,                          // single-line comments
  /^\s*\/\*[\s\S]*?\*\/\s*$/,            // block comments
  /^\s*#.*$/,                             // Python/shell comments
  /^\s*import\s+.*from\s+['"][^'"]+['"]\s*;?\s*$/,  // import statements
  /^\s*require\s*\(['"]/,                 // require statements
  /^\s*use\s+\w+/,                        // Rust use statements
  /^\s*package\s+\w+/,                    // Go/Java package declarations
  /^\s*\*\s/,                             // JSDoc lines
  /^\s*\*\/\s*$/,                         // JSDoc closing
  /^\s*\/\*\*\s*$/,                       // JSDoc opening
  /^\s*@(param|returns?|throws?|type|author|version|since|deprecated)\s/i, // JSDoc tags
  /^\s*console\.(log|debug|info)\s*\(/,  // debug logs
  /^\s*\/\/\s*(eslint|tslint|prettier|stylelint)/i, // linter comments
  /^\s*\/\/\s*(TODO|FIXME|HACK|XXX)/i,   // todo comments (optional)
];

const CRITICAL_PATTERNS = [
  /^\s*(export\s+)?(async\s+)?function\s+\w+/,  // function declarations
  /^\s*(export\s+)?(abstract\s+)?class\s+\w+/,  // class declarations
  /^\s*(export\s+)?interface\s+\w+/,             // interface declarations
  /^\s*(export\s+)?type\s+\w+\s*=/,             // type aliases
  /^\s*(export\s+)?const\s+\w+\s*=/,            // const declarations
  /^\s*return\s+/,                               // return statements
  /^\s*throw\s+/,                                // throw statements
  /^\s*if\s*\(/,                                 // conditionals
  /^\s*for\s*\(/,                                // loops
  /^\s*while\s*\(/,                              // while loops
  /^\s*switch\s*\(/,                             // switch
  /^\s*case\s+/,                                 // case
  /^\s*catch\s*\(/,                              // catch
  /^\s*await\s+/,                                // await
  /^\s*yield\s+/,                                // yield
];

function isBoilerplate(line: string): boolean {
  return BOILERPLATE_PATTERNS.some(p => p.test(line));
}

function isCritical(line: string): boolean {
  return CRITICAL_PATTERNS.some(p => p.test(line));
}

function compressCode(content: string, targetRatio: number): string {
  const lines = content.split('\n');
  const targetLines = Math.ceil(lines.length * targetRatio);

  if (lines.length <= targetLines) return content;

  const result: string[] = [];
  let removedCount = 0;
  const toRemove = lines.length - targetLines;

  for (const line of lines) {
    const trimmed = line.trim();

    // Always keep critical lines
    if (isCritical(trimmed)) {
      result.push(line);
      continue;
    }

    // Remove boilerplate if we still need to reduce
    if (removedCount < toRemove && isBoilerplate(trimmed)) {
      removedCount++;
      continue;
    }

    // Remove blank lines if still need to reduce
    if (removedCount < toRemove && trimmed === '') {
      removedCount++;
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

function compressText(content: string, targetRatio: number): string {
  const sentences = content.split(/(?<=[.!?])\s+/);
  const targetCount = Math.ceil(sentences.length * targetRatio);

  if (sentences.length <= targetCount) return content;

  // Keep first and last sentences, remove middle ones proportionally
  if (sentences.length <= 3) return content;

  const keep = new Set<number>();
  keep.add(0);
  keep.add(sentences.length - 1);

  // Keep evenly distributed sentences
  const step = sentences.length / (targetCount - 2);
  for (let i = 1; i < targetCount - 1; i++) {
    keep.add(Math.round(i * step));
  }

  return sentences.filter((_, i) => keep.has(i)).join(' ');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CompressionResult {
  original: string;
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
}

export function compressChunk(chunk: Chunk | RankedChunk): CompressionResult {
  const config = getConfig().retrieval;
  const content = chunk.content;
  const originalTokens = estimateTokens(content);

  let compressed: string;

  if (chunk.language && ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp'].includes(chunk.language)) {
    compressed = compressCode(content, config.compressionRatio);
  } else {
    compressed = compressText(content, config.compressionRatio);
  }

  // Remove excessive blank lines
  compressed = compressed.replace(/\n{3,}/g, '\n\n').trim();

  const compressedTokens = estimateTokens(compressed);

  return {
    original: content,
    compressed,
    originalTokens,
    compressedTokens,
    ratio: compressedTokens / Math.max(originalTokens, 1),
  };
}

export function compressChunks(chunks: RankedChunk[]): RankedChunk[] {
  let totalOriginal = 0;
  let totalCompressed = 0;

  const result = chunks.map(chunk => {
    const { compressed, originalTokens, compressedTokens } = compressChunk(chunk);
    totalOriginal += originalTokens;
    totalCompressed += compressedTokens;
    return { ...chunk, compressed };
  });

  logger.debug({
    chunks: chunks.length,
    originalTokens: totalOriginal,
    compressedTokens: totalCompressed,
    saved: totalOriginal - totalCompressed,
  }, 'Compression complete');

  return result;
}

export function assembleContext(
  chunks: RankedChunk[],
  maxTokens: number,
  useCompressed = true
): string {
  const parts: string[] = [];
  let tokenCount = 0;

  for (const chunk of chunks) {
    const content = useCompressed && chunk.compressed ? chunk.compressed : chunk.content;
    const tokens = estimateTokens(content);

    if (tokenCount + tokens > maxTokens) break;

    parts.push(`### ${chunk.title}\n// ${chunk.relativePath}:${chunk.startLine}-${chunk.endLine}\n${content}`);
    tokenCount += tokens;
  }

  return parts.join('\n\n---\n\n');
}
