import type { FastifyInstance } from 'fastify';
import { getStorageStats, getAllFingerprints } from '../../storage/sqlite.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('api:status-routes');

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function statusRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /health
  fastify.get('/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // GET /status
  fastify.get('/status', async (_request, reply) => {
    let indexed = false;
    let lastIndexedAt: string | null = null;

    try {
      const fingerprintsMap = getAllFingerprints();
      indexed = fingerprintsMap.size > 0;

      if (indexed) {
        const stats = getStorageStats();
        indexed = stats.fingerprints > 0;
        lastIndexedAt = indexed ? new Date().toISOString() : null;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to get status');
    }

    return reply.status(200).send({ indexed, lastIndexedAt });
  });

  // GET /stats
  fastify.get('/stats', async (_request, reply) => {
    const stats = getStorageStats();
    return reply.status(200).send(stats);
  });
}
