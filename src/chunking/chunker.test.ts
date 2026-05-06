import { describe, it, expect } from 'vitest';
import { chunkDocument } from './chunker.js';
import type { StructuredDocument } from '../types/index.js';

function makeDoc(overrides: Partial<StructuredDocument> = {}): StructuredDocument {
  return {
    id: 'doc_test',
    path: '/tmp/test.ts',
    relativePath: 'src/test.ts',
    type: 'code',
    language: 'typescript',
    module: 'src',
    symbols: [],
    dependencies: [],
    sections: [],
    rawText: '',
    metadata: {},
    fingerprint: {
      path: 'src/test.ts',
      absolutePath: '/tmp/test.ts',
      hash: 'abc',
      modifiedTime: 0,
      size: 0,
      encoding: 'utf-8',
      mimeType: 'text/plain',
      isBinary: false,
    },
    ...overrides,
  };
}

describe('chunkDocument', () => {
  it('should chunk a code document with symbols', () => {
    const doc = makeDoc({
      symbols: [
        { name: 'myFunction', kind: 'function', startLine: 1, endLine: 10 },
        { name: 'anotherFn', kind: 'function', startLine: 12, endLine: 20 },
      ],
      rawText: Array(20).fill('const x = 1; // some code here that is long enough').join('\n'),
    });
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.documentId).toBe('doc_test');
  });

  it('should chunk a markdown document by sections', () => {
    const doc = makeDoc({
      type: 'documentation',
      language: 'markdown',
      sections: [
        { id: 's1', title: 'Introduction', level: 1, content: 'This is the introduction section with enough content to be meaningful and pass the minimum token threshold for chunking.', startLine: 1, endLine: 5 },
        { id: 's2', title: 'Usage', level: 2, content: 'This is the usage section with enough content to be meaningful for chunking purposes and also pass the minimum token threshold.', startLine: 6, endLine: 15 },
      ],
      rawText: 'This is the introduction section with enough content to be meaningful.\nThis is the usage section with enough content to be meaningful for chunking.',
    });
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.kind).toBe('section');
    expect(chunks[1]!.kind).toBe('paragraph');
  });

  it('should fallback to line blocks for empty documents', () => {
    const doc = makeDoc({
      rawText: Array(30).fill('some content line that is long enough to be meaningful here').join('\n'),
    });
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('should assign correct chunk kinds', () => {
    const doc = makeDoc({
      symbols: [
        { name: 'MyClass', kind: 'class', startLine: 1, endLine: 5 },
      ],
      rawText: Array(5).fill('class MyClass { constructor() {} someMethod() { return 42; } }').join('\n'),
    });
    const chunks = chunkDocument(doc);
    const classChunk = chunks.find(c => c.kind === 'class');
    expect(classChunk).toBeDefined();
  });
});
