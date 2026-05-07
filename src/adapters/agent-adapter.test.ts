import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildContextPackage, queryAndBuildContext, serializeContextPackage } from './agent-adapter.js';
import * as queryPipelineModule from '../core/query-pipeline.js';
import type { QueryResult, RankedChunk } from '../types/index.js';
import type { AgentAdapterOptions as AdapterOptions } from './agent-adapter.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<RankedChunk> = {}): RankedChunk {
  return {
    id: 'chunk-1',
    parentId: null,
    documentId: 'doc-1',
    path: 'src/foo.ts',
    relativePath: 'src/foo.ts',
    kind: 'function',
    language: 'typescript',
    title: 'foo',
    content: 'function foo() { return 42; }',
    summary: 'Returns 42',
    tags: [],
    dependencies: [],
    references: [],
    tokenEstimate: 10,
    startLine: 1,
    endLine: 3,
    embeddingRef: null,
    metadata: {},
    score: 0.95,
    scoreBreakdown: { vector: 0.9, fts: 0.8, rerank: 0.95, graph: 0.7 },
    ...overrides,
  };
}

function makeQueryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    query: 'find foo function',
    rewrittenQuery: 'find foo function implementation',
    intent: 'find-implementation',
    chunks: [makeChunk()],
    summaries: {
      project: {
        projectId: 'proj-1',
        name: 'TestProject',
        summary: 'A test project',
        purpose: 'Testing',
        modules: [],
        mainLanguages: ['typescript'],
        frameworks: [],
        architecturalPatterns: [],
        domains: [],
        entryPoints: [],
        tags: [],
      },
    },
    relations: [
      {
        id: 'edge-1',
        sourceId: 'chunk-1',
        targetId: 'chunk-2',
        kind: 'calls',
        weight: 1,
      },
    ],
    metadata: {
      totalTimeMs: 100,
      parseTimeMs: 10,
      vectorTimeMs: 20,
      ftsTimeMs: 15,
      rerankTimeMs: 30,
      compressionTimeMs: 5,
      cacheHit: false,
      candidatesBeforeRerank: 20,
      tokensBeforeCompression: 500,
      tokensAfterCompression: 300,
      tokensSaved: 200,
    },
    ...overrides,
  };
}

const defaultOptions: AdapterOptions = {
  projectPath: '/home/user/project',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildContextPackage', () => {
  it('returns correct ContextPackage shape', () => {
    const result = makeQueryResult();
    const pkg = buildContextPackage(result, defaultOptions);

    expect(pkg).toHaveProperty('query', 'find foo function');
    expect(pkg).toHaveProperty('summaries');
    expect(pkg).toHaveProperty('chunks');
    expect(pkg).toHaveProperty('relations');
    expect(pkg).toHaveProperty('metadata');
    expect(Array.isArray(pkg.chunks)).toBe(true);
    expect(Array.isArray(pkg.relations)).toBe(true);
  });

  it('includes metadata.projectPath and metadata.indexedAt', () => {
    const result = makeQueryResult();
    const pkg = buildContextPackage(result, defaultOptions);

    expect(pkg.metadata.projectPath).toBe('/home/user/project');
    expect(typeof pkg.metadata.indexedAt).toBe('string');
    expect(new Date(pkg.metadata.indexedAt).toISOString()).toBe(pkg.metadata.indexedAt);
  });

  it('truncates chunks when maxTokens is small', () => {
    // Each chunk content is ~30 chars = ~8 tokens; maxTokens=5 forces truncation
    const bigContent = 'x'.repeat(500); // ~125 tokens
    const chunks = [
      makeChunk({ id: 'c1', content: bigContent }),
      makeChunk({ id: 'c2', content: bigContent }),
      makeChunk({ id: 'c3', content: bigContent }),
    ];
    const result = makeQueryResult({ chunks });
    const pkg = buildContextPackage(result, { ...defaultOptions, maxTokens: 100 });

    expect(pkg.chunks.length).toBeLessThan(3);
    expect((pkg.metadata as unknown as Record<string, unknown>)['truncated']).toBe(true);
    expect((pkg.metadata as unknown as Record<string, unknown>)['chunksOmitted']).toBeGreaterThan(0);
  });

  it('returns empty relations when includeRelations=false', () => {
    const result = makeQueryResult();
    const pkg = buildContextPackage(result, { ...defaultOptions, includeRelations: false });

    expect(pkg.relations).toEqual([]);
  });

  it('returns empty summaries when includeSummaries=false', () => {
    const result = makeQueryResult();
    const pkg = buildContextPackage(result, { ...defaultOptions, includeSummaries: false });

    expect(pkg.summaries).toEqual({});
  });
});

describe('serializeContextPackage', () => {
  it('returns non-empty string containing the query', () => {
    const result = makeQueryResult();
    const pkg = buildContextPackage(result, defaultOptions);
    const serialized = serializeContextPackage(pkg);

    expect(typeof serialized).toBe('string');
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).toContain('find foo function');
  });

  it('includes chunk path and score in output', () => {
    const result = makeQueryResult();
    const pkg = buildContextPackage(result, defaultOptions);
    const serialized = serializeContextPackage(pkg);

    expect(serialized).toContain('src/foo.ts');
    expect(serialized).toContain('0.95');
  });

  it('includes project summary when present', () => {
    const result = makeQueryResult();
    const pkg = buildContextPackage(result, defaultOptions);
    const serialized = serializeContextPackage(pkg);

    expect(serialized).toContain('Project Summary');
    expect(serialized).toContain('A test project');
  });

  it('includes relations section when present', () => {
    const result = makeQueryResult();
    const pkg = buildContextPackage(result, defaultOptions);
    const serialized = serializeContextPackage(pkg);

    expect(serialized).toContain('Relations');
    expect(serialized).toContain('calls');
  });
});

describe('queryAndBuildContext', () => {
  it('calls runQueryPipeline and returns ContextPackage', async () => {
    const mockResult = makeQueryResult();
    const spy = vi.spyOn(queryPipelineModule, 'runQueryPipeline').mockResolvedValue(mockResult);

    const request = { query: 'find foo function' };
    const pkg = await queryAndBuildContext(request, defaultOptions);

    expect(spy).toHaveBeenCalledWith(request);
    expect(pkg).toHaveProperty('query', 'find foo function');
    expect(pkg).toHaveProperty('chunks');
    expect(pkg.metadata.projectPath).toBe('/home/user/project');

    spy.mockRestore();
  });
});
