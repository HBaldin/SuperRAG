import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { getLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { indexRoutes } from './routes/index-routes.js';
import { queryRoutes } from './routes/query-routes.js';
import { statusRoutes } from './routes/status-routes.js';

const logger = getLogger('api:server');

// ─── buildServer ──────────────────────────────────────────────────────────────

export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  // CORS
  await fastify.register(cors, { origin: true });

  // Routes
  await fastify.register(indexRoutes);
  await fastify.register(queryRoutes);
  await fastify.register(statusRoutes);

  // Error handler
  fastify.setErrorHandler((error: any, _request, reply) => {
    const statusCode = error?.statusCode ?? 500;
    logger.error({ err: error, statusCode }, 'Request error');
    return reply.status(statusCode).send({
      error: error?.message ?? 'Internal server error',
      statusCode,
    });
  });

  // Not found handler
  fastify.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      error: 'Not found',
      statusCode: 404,
    });
  });

  return fastify;
}

// ─── startServer ──────────────────────────────────────────────────────────────

export async function startServer(port?: number, host?: string): Promise<void> {
  const config = getConfig();
  const serverPort = port ?? 3000;
  const serverHost = host ?? '0.0.0.0';

  const fastify = await buildServer();

  try {
    const address = await fastify.listen({ port: serverPort, host: serverHost });
    logger.info({ address }, 'SuperRAG API server started');
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

// Run if executed directly
const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  const port = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3000;
  const host = process.env['HOST'] ?? '0.0.0.0';
  startServer(port, host).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
