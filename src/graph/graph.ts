import Database from 'better-sqlite3';
import { getDb } from '../storage/sqlite.js';
import { getLogger } from '../utils/logger.js';
import { generateId } from '../utils/hash.js';
import type { GraphNode, GraphEdge, GraphNodeKind, GraphEdgeKind } from '../types/index.js';

const logger = getLogger('graph');

// ─── Schema ───────────────────────────────────────────────────────────────────

export function initGraphSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      path TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_path ON graph_nodes(path);

    CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_kind ON graph_edges(kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_unique
      ON graph_edges(source_id, target_id, kind);
  `);
  logger.debug('Graph schema initialized');
}

// ─── Node Operations ──────────────────────────────────────────────────────────

export function upsertNode(node: GraphNode): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO graph_nodes (id, kind, label, path, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(node.id, node.kind, node.label, node.path ?? null, JSON.stringify(node.metadata ?? {}));
}

export function upsertNodes(nodes: GraphNode[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO graph_nodes (id, kind, label, path, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction((items: GraphNode[]) => {
    for (const node of items) {
      stmt.run(node.id, node.kind, node.label, node.path ?? null, JSON.stringify(node.metadata ?? {}));
    }
  });
  insertAll(nodes);
}

export function getNode(id: string): GraphNode | null {
  const row = getDb().prepare('SELECT * FROM graph_nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToNode(row);
}

export function getNodesByPath(path: string): GraphNode[] {
  const rows = getDb().prepare('SELECT * FROM graph_nodes WHERE path = ?').all(path) as Array<Record<string, unknown>>;
  return rows.map(rowToNode);
}

export function deleteNodesByPath(path: string): void {
  const db = getDb();
  const nodes = db.prepare('SELECT id FROM graph_nodes WHERE path = ?').all(path) as Array<{ id: string }>;
  for (const { id } of nodes) {
    db.prepare('DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?').run(id, id);
    db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(id);
  }
}

// ─── Edge Operations ──────────────────────────────────────────────────────────

export function upsertEdge(edge: GraphEdge): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO graph_edges (id, source_id, target_id, kind, weight, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    edge.id, edge.sourceId, edge.targetId, edge.kind,
    edge.weight ?? 1.0, JSON.stringify(edge.metadata ?? {})
  );
}

export function upsertEdges(edges: GraphEdge[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO graph_edges (id, source_id, target_id, kind, weight, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction((items: GraphEdge[]) => {
    for (const edge of items) {
      stmt.run(
        edge.id, edge.sourceId, edge.targetId, edge.kind,
        edge.weight ?? 1.0, JSON.stringify(edge.metadata ?? {})
      );
    }
  });
  insertAll(edges);
}

export function getEdgesFrom(nodeId: string, kinds?: GraphEdgeKind[]): GraphEdge[] {
  const db = getDb();
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM graph_edges WHERE source_id = ? AND kind IN (${placeholders})`
    ).all(nodeId, ...kinds) as Array<Record<string, unknown>>;
    return rows.map(rowToEdge);
  }
  const rows = db.prepare('SELECT * FROM graph_edges WHERE source_id = ?').all(nodeId) as Array<Record<string, unknown>>;
  return rows.map(rowToEdge);
}

export function getEdgesTo(nodeId: string, kinds?: GraphEdgeKind[]): GraphEdge[] {
  const db = getDb();
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM graph_edges WHERE target_id = ? AND kind IN (${placeholders})`
    ).all(nodeId, ...kinds) as Array<Record<string, unknown>>;
    return rows.map(rowToEdge);
  }
  const rows = db.prepare('SELECT * FROM graph_edges WHERE target_id = ?').all(nodeId) as Array<Record<string, unknown>>;
  return rows.map(rowToEdge);
}

// ─── Graph Traversal ──────────────────────────────────────────────────────────

export interface TraversalResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function expandNeighbors(
  nodeIds: string[],
  depth: number,
  edgeKinds?: GraphEdgeKind[],
  maxNodes = 50
): TraversalResult {
  const visitedNodes = new Map<string, GraphNode>();
  const visitedEdges = new Map<string, GraphEdge>();
  const queue: Array<{ id: string; depth: number }> = nodeIds.map(id => ({ id, depth: 0 }));

  while (queue.length > 0 && visitedNodes.size < maxNodes) {
    const item = queue.shift()!;
    if (visitedNodes.has(item.id)) continue;

    const node = getNode(item.id);
    if (node) visitedNodes.set(item.id, node);

    if (item.depth >= depth) continue;

    const outEdges = getEdgesFrom(item.id, edgeKinds);
    const inEdges = getEdgesTo(item.id, edgeKinds);

    for (const edge of [...outEdges, ...inEdges]) {
      visitedEdges.set(edge.id, edge);
      const neighborId = edge.sourceId === item.id ? edge.targetId : edge.sourceId;
      if (!visitedNodes.has(neighborId)) {
        queue.push({ id: neighborId, depth: item.depth + 1 });
      }
    }
  }

  return {
    nodes: [...visitedNodes.values()],
    edges: [...visitedEdges.values()],
  };
}

export function findPath(
  fromId: string,
  toId: string,
  maxDepth = 5
): GraphNode[] | null {
  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.id === toId) {
      return item.path.map(id => getNode(id)).filter(Boolean) as GraphNode[];
    }
    if (item.path.length >= maxDepth) continue;
    if (visited.has(item.id)) continue;
    visited.add(item.id);

    const edges = getEdgesFrom(item.id);
    for (const edge of edges) {
      if (!visited.has(edge.targetId)) {
        queue.push({ id: edge.targetId, path: [...item.path, edge.targetId] });
      }
    }
  }

  return null;
}

// ─── Graph Builder from Documents ────────────────────────────────────────────

export function buildGraphFromChunks(
  chunks: Array<{ chunk: import('../types/index.js').Chunk; documentId: string }>
): void {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const { chunk } of chunks) {
    // Node for each chunk
    nodes.push({
      id: chunk.id,
      kind: 'chunk',
      label: chunk.title,
      path: chunk.relativePath,
      metadata: {
        kind: chunk.kind,
        language: chunk.language,
        domain: chunk.metadata.domain,
      },
    });

    // Node for the file
    const fileNodeId = `file:${chunk.relativePath}`;
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      label: chunk.relativePath,
      path: chunk.relativePath,
    });

    // Edge: file contains chunk
    edges.push({
      id: generateId('edge', fileNodeId, chunk.id, 'contains'),
      sourceId: fileNodeId,
      targetId: chunk.id,
      kind: 'contains',
      weight: 1.0,
    });

    // Edges for dependencies (imports)
    for (const dep of chunk.dependencies) {
      const depNodeId = `dep:${dep}`;
      nodes.push({
        id: depNodeId,
        kind: 'file',
        label: dep,
        path: dep,
      });
      edges.push({
        id: generateId('edge', chunk.id, depNodeId, 'imports'),
        sourceId: chunk.id,
        targetId: depNodeId,
        kind: 'imports',
        weight: 0.8,
      });
    }
  }

  // Deduplicate nodes by id
  const uniqueNodes = [...new Map(nodes.map(n => [n.id, n])).values()];
  const uniqueEdges = [...new Map(edges.map(e => [e.id, e])).values()];

  upsertNodes(uniqueNodes);
  upsertEdges(uniqueEdges);

  logger.debug({ nodes: uniqueNodes.length, edges: uniqueEdges.length }, 'Graph built from chunks');
}

export function getGraphStats(): { nodes: number; edges: number } {
  const db = getDb();
  const nodes = (db.prepare('SELECT COUNT(*) as n FROM graph_nodes').get() as { n: number }).n;
  const edges = (db.prepare('SELECT COUNT(*) as n FROM graph_edges').get() as { n: number }).n;
  return { nodes, edges };
}

// ─── Row Mappers ──────────────────────────────────────────────────────────────

function rowToNode(row: Record<string, unknown>): GraphNode {
  return {
    id: row['id'] as string,
    kind: row['kind'] as GraphNodeKind,
    label: row['label'] as string,
    path: row['path'] as string | undefined,
    metadata: JSON.parse(row['metadata'] as string) as Record<string, unknown>,
  };
}

function rowToEdge(row: Record<string, unknown>): GraphEdge {
  return {
    id: row['id'] as string,
    sourceId: row['source_id'] as string,
    targetId: row['target_id'] as string,
    kind: row['kind'] as GraphEdgeKind,
    weight: row['weight'] as number,
    metadata: JSON.parse(row['metadata'] as string) as Record<string, unknown>,
  };
}
