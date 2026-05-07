import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { runQueryPipeline } from '../../core/query-pipeline.js';
import { queryAndBuildContext } from '../../adapters/agent-adapter.js';
import { getLogger } from '../../utils/logger.js';
import type { SemanticDomain, ChunkKind, QueryRequest } from '../../types/index.js';

const logger = getLogger('api:query-routes');

// ─── Schemas ──────────────────────────────────────────────────────────────────

const SemanticDomainValues = [
  'backend', 'frontend', 'infra', 'database', 'security', 'auth',
  'messaging', 'logging', 'config', 'tests', 'docs', 'utils', 'unknown',
] as const;

const ChunkKindValues = [
  'function', 'method', 'class', 'class-body', 'interface', 'module',
  'section', 'paragraph', 'code-block', 'config-block', 'table', 'list', 'fallback',
] as const;

const QueryFiltersSchema = z.object({
  languages: z.array(z.string()).optional(),
  domains: z.array(z.enum(SemanticDomainValues)).optional(),
  paths: z.array(z.string()).optional(),
  kinds: z.array(z.enum(ChunkKindValues)).optional(),
  tags: z.array(z.string()).optional(),
}).optional();

const QueryBodySchema = z.object({
  query: z.string().min(1, 'query is required'),
  projectPath: z.string().optional(),
  topK: z.number().int().positive().optional(),
  includeGraph: z.boolean().optional(),
  includeCompressed: z.boolean().optional(),
  filters: QueryFiltersSchema,
});

const AgentQueryBodySchema = QueryBodySchema.extend({
  maxTokens: z.number().int().positive().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function queryRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /query
  fastify.post('/query', async (request, reply) => {
    const parsed = QueryBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.errors.map(e => e.message).join(', '),
        statusCode: 400,
      });
    }

    const body = parsed.data;
    logger.info({ query: body.query.slice(0, 80) }, 'POST /query');

    const result = await runQueryPipeline(body);
    return reply.status(200).send(result);
  });

  // POST /query/agent
  fastify.post('/query/agent', async (request, reply) => {
    const parsed = AgentQueryBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.errors.map(e => e.message).join(', '),
        statusCode: 400,
      });
    }

    const { maxTokens, ...queryRequest } = parsed.data;
    const projectPath = queryRequest.projectPath ?? '.';
    logger.info({ query: queryRequest.query.slice(0, 80) }, 'POST /query/agent');

    const pkg = await queryAndBuildContext(queryRequest, {
      projectPath,
      maxTokens,
    });
    return reply.status(200).send(pkg);
  });
}
