import { runQueryPipeline } from '../core/query-pipeline.js';
import { estimateTokens } from '../utils/tokens.js';
import type {
  QueryRequest,
  QueryResult,
  ContextPackage,
  RankedChunk,
} from '../types/index.js';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface AgentAdapterOptions {
  projectPath: string;
  maxTokens?: number;        // default: 8000
  includeRelations?: boolean; // default: true
  includeSummaries?: boolean; // default: true
}

// ─── buildContextPackage ──────────────────────────────────────────────────────

export function buildContextPackage(
  result: QueryResult,
  options: AgentAdapterOptions,
): ContextPackage {
  const maxTokens = options.maxTokens ?? 8000;
  const includeRelations = options.includeRelations ?? true;
  const includeSummaries = options.includeSummaries ?? true;

  // Truncate chunks to fit within maxTokens
  const keptChunks: RankedChunk[] = [];
  let accumulatedTokens = 0;
  let truncated = false;

  for (const chunk of result.chunks) {
    const text = chunk.compressed ?? chunk.content;
    const tokens = estimateTokens(text);
    if (accumulatedTokens + tokens > maxTokens) {
      truncated = true;
      break;
    }
    keptChunks.push(chunk);
    accumulatedTokens += tokens;
  }

  const chunksOmitted = result.chunks.length - keptChunks.length;

  const extraMetadata: Record<string, unknown> = {
    projectPath: options.projectPath,
    indexedAt: new Date().toISOString(),
  };

  if (truncated) {
    extraMetadata['truncated'] = true;
    extraMetadata['chunksOmitted'] = chunksOmitted;
  }

  return {
    query: result.query,
    summaries: includeSummaries ? result.summaries : {},
    chunks: keptChunks,
    relations: includeRelations ? result.relations : [],
    metadata: {
      ...result.metadata,
      ...(extraMetadata as { projectPath: string; indexedAt: string }),
    },
  };
}

// ─── queryAndBuildContext ─────────────────────────────────────────────────────

export async function queryAndBuildContext(
  request: QueryRequest,
  options: AgentAdapterOptions,
): Promise<ContextPackage> {
  const result = await runQueryPipeline(request);
  return buildContextPackage(result, options);
}

// ─── serializeContextPackage ──────────────────────────────────────────────────

export function serializeContextPackage(pkg: ContextPackage): string {
  const lines: string[] = [];

  lines.push(`# Context for: ${pkg.query}`);
  lines.push('');

  // Project summary
  if (pkg.summaries.project) {
    lines.push('## Project Summary');
    lines.push(pkg.summaries.project.summary);
    lines.push('');
  }

  // Relevant code chunks
  if (pkg.chunks.length > 0) {
    lines.push('## Relevant Code');
    for (let i = 0; i < pkg.chunks.length; i++) {
      const chunk = pkg.chunks[i];
      const location = `${chunk.path}:${chunk.startLine}`;
      const score = chunk.score.toFixed(2);
      lines.push(`### ${i + 1}. ${location} [score: ${score}]`);
      lines.push(chunk.compressed ?? chunk.content);
      lines.push('');
    }
  }

  // Relations
  if (pkg.relations.length > 0) {
    lines.push('## Relations');
    for (const rel of pkg.relations) {
      lines.push(`- ${rel.sourceId} --[${rel.kind}]--> ${rel.targetId}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
