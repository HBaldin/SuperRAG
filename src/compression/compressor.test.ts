import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    retrieval: { compressionRatio: 0.6, finalTopK: 10 },
    logging: { level: 'error', pretty: false, traceEnabled: false },
  }),
}));

import { compressChunk, assembleContext } from './compressor.js';
import type { Chunk, RankedChunk } from '../types/index.js';

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: 'c1', parentId: null, documentId: 'd1',
    path: '/tmp/a.ts', relativePath: 'src/a.ts',
    kind: 'function', language: 'typescript',
    title: 'function: foo',
    content: [
      '// This is a comment',
      'import { bar } from "./bar";',
      'export function foo(x: number): number {',
      '  // another comment',
      '  if (x > 0) {',
      '    return x * 2;',
      '  }',
      '  return 0;',
      '}',
    ].join('\n'),
    summary: '', tags: [], dependencies: [], references: [],
    tokenEstimate: 50, startLine: 1, endLine: 9,
    embeddingRef: null, metadata: {},
    ...overrides,
  };
}

describe('compressChunk', () => {
  it('should reduce token count', () => {
    const chunk = makeChunk();
    const result = compressChunk(chunk);
    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
  });

  it('should preserve critical lines (return, if)', () => {
    const chunk = makeChunk();
    const result = compressChunk(chunk);
    expect(result.compressed).toContain('return');
    expect(result.compressed).toContain('if');
  });

  it('should remove import statements', () => {
    const chunk = makeChunk();
    const result = compressChunk(chunk);
    expect(result.compressed).not.toContain('import { bar }');
  });
});

describe('assembleContext', () => {
  it('should assemble chunks into context string', () => {
    const chunk: RankedChunk = {
      ...makeChunk(),
      score: 0.9,
      scoreBreakdown: { vector: 0.9, fts: 0, rerank: 0, graph: 0 },
      compressed: 'compressed content here',
    };
    const context = assembleContext([chunk], 10000, true);
    expect(context).toContain('function: foo');
    expect(context).toContain('compressed content here');
  });

  it('should respect token budget', () => {
    const chunks: RankedChunk[] = Array(20).fill(null).map((_, i) => ({
      ...makeChunk({ id: `c${i}`, title: `fn${i}` }),
      score: 0.9,
      scoreBreakdown: { vector: 0.9, fts: 0, rerank: 0, graph: 0 },
    }));
    const context = assembleContext(chunks, 100, false);
    // Should not include all 20 chunks
    expect(context.split('---').length).toBeLessThan(20);
  });
});
