import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'fs';
import { vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    sqlite: {
      path: '/tmp/superrag-test-graph/test.db',
      walMode: true,
      cacheSize: -1000,
    },
    logging: { level: 'error', pretty: false, traceEnabled: false },
  }),
}));

import { closeDb } from '../storage/sqlite.js';
import {
  initGraphSchema,
  upsertNode,
  upsertEdge,
  getNode,
  getEdgesFrom,
  expandNeighbors,
  getGraphStats,
} from './graph.js';

const TEST_DIR = '/tmp/superrag-test-graph';

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  initGraphSchema();
});

afterEach(() => {
  closeDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Graph nodes', () => {
  it('should upsert and retrieve a node', () => {
    upsertNode({ id: 'node_1', kind: 'chunk', label: 'myFunction', path: 'src/a.ts' });
    const node = getNode('node_1');
    expect(node).not.toBeNull();
    expect(node!.label).toBe('myFunction');
    expect(node!.kind).toBe('chunk');
  });

  it('should return null for missing node', () => {
    expect(getNode('nonexistent')).toBeNull();
  });
});

describe('Graph edges', () => {
  it('should upsert and retrieve edges', () => {
    upsertNode({ id: 'n1', kind: 'file', label: 'a.ts', path: 'src/a.ts' });
    upsertNode({ id: 'n2', kind: 'file', label: 'b.ts', path: 'src/b.ts' });
    upsertEdge({ id: 'e1', sourceId: 'n1', targetId: 'n2', kind: 'imports', weight: 1.0 });

    const edges = getEdgesFrom('n1');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe('imports');
    expect(edges[0]!.targetId).toBe('n2');
  });
});

describe('Graph traversal', () => {
  it('should expand neighbors', () => {
    upsertNode({ id: 'root', kind: 'file', label: 'root.ts' });
    upsertNode({ id: 'child1', kind: 'chunk', label: 'fn1' });
    upsertNode({ id: 'child2', kind: 'chunk', label: 'fn2' });
    upsertEdge({ id: 'e1', sourceId: 'root', targetId: 'child1', kind: 'contains' });
    upsertEdge({ id: 'e2', sourceId: 'root', targetId: 'child2', kind: 'contains' });

    const result = expandNeighbors(['root'], 1);
    expect(result.nodes.length).toBeGreaterThanOrEqual(2);
    expect(result.edges.length).toBe(2);
  });
});

describe('Graph stats', () => {
  it('should count nodes and edges', () => {
    upsertNode({ id: 'n1', kind: 'file', label: 'a.ts' });
    upsertNode({ id: 'n2', kind: 'chunk', label: 'fn' });
    upsertEdge({ id: 'e1', sourceId: 'n1', targetId: 'n2', kind: 'contains' });

    const stats = getGraphStats();
    expect(stats.nodes).toBe(2);
    expect(stats.edges).toBe(1);
  });
});
