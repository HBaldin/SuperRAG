import { describe, it, expect } from 'vitest';
import { enrichChunk } from './enricher.js';
import type { Chunk } from '../types/index.js';

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: 'chunk_test',
    parentId: null,
    documentId: 'doc_test',
    path: '/tmp/test.ts',
    relativePath: 'src/auth/login.ts',
    kind: 'function',
    language: 'typescript',
    title: 'function: validateToken',
    content: 'async function validateToken(token: string): Promise<boolean> { const decoded = jwt.verify(token, secret); return !!decoded; }',
    summary: '',
    tags: [],
    dependencies: [],
    references: [],
    tokenEstimate: 30,
    startLine: 1,
    endLine: 3,
    embeddingRef: null,
    metadata: {},
    ...overrides,
  };
}

describe('enrichChunk', () => {
  it('should detect auth domain', () => {
    const chunk = makeChunk();
    const enriched = enrichChunk(chunk);
    expect(enriched.metadata.domain).toBe('auth');
  });

  it('should generate tags', () => {
    const chunk = makeChunk();
    const enriched = enrichChunk(chunk);
    expect(enriched.tags).toContain('async');
    expect(enriched.tags.length).toBeGreaterThan(0);
  });

  it('should detect complexity', () => {
    const chunk = makeChunk({
      content: Array(50).fill('if (x) { for (let i=0; i<10; i++) { while(true) { try { } catch(e) { } } } }').join('\n'),
      tokenEstimate: 500,
    });
    const enriched = enrichChunk(chunk);
    expect(['high', 'very-high']).toContain(enriched.metadata.complexity);
  });

  it('should detect side effects', () => {
    const chunk = makeChunk({
      content: 'function save() { console.log("saving"); db.insert(data); emit("saved"); }',
    });
    const enriched = enrichChunk(chunk);
    expect(enriched.metadata.sideEffects).toContain('console-output');
  });
});
