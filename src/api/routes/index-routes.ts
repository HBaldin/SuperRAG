import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { indexProject } from '../../core/indexer.js';
import { getDb, deleteChunksByDocument, deleteFingerprint, getAllFingerprints } from '../../storage/sqlite.js';
import { deleteChunksByPath } from '../../storage/qdrant.js';
import { deleteNodesByPath } from '../../graph/graph.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('api:index-routes');

// ─── Schemas ──────────────────────────────────────────────────────────────────

const IndexBodySchema = z.object({
  projectPath: z.string().min(1, 'projectPath is required'),
  force: z.boolean().optional().default(false),
});

const RefreshBodySchema = z.object({
  projectPath: z.string().min(1, 'projectPath is required'),
});

const DeleteBodySchema = z.object({
  projectPath: z.string().min(1, 'projectPath is required'),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function indexRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /index
  fastify.post('/index', async (request, reply) => {
    const parsed = IndexBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.errors.map(e => e.message).join(', '),
        statusCode: 400,
      });
    }

    const { projectPath, force } = parsed.data;
    logger.info({ projectPath, force }, 'POST /index');

    const result = await indexProject({ projectPath, force });
    return reply.status(200).send(result);
  });

  // POST /refresh
  fastify.post('/refresh', async (request, reply) => {
    const parsed = RefreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.errors.map(e => e.message).join(', '),
        statusCode: 400,
      });
    }

    const { projectPath } = parsed.data;
    logger.info({ projectPath }, 'POST /refresh');

    const result = await indexProject({ projectPath, force: false });
    return reply.status(200).send(result);
  });

  // DELETE /index
  fastify.delete('/index', async (request, reply) => {
    const parsed = DeleteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.errors.map(e => e.message).join(', '),
        statusCode: 400,
      });
    }

    const { projectPath } = parsed.data;
    logger.info({ projectPath }, 'DELETE /index');

    // Remove all fingerprints and chunks for this project
    const fingerprintsMap = getAllFingerprints();
    for (const fp of fingerprintsMap.values()) {
      try {
        deleteChunksByDocument(fp.path);
        deleteFingerprint(fp.path);
        await deleteChunksByPath(fp.path);
        deleteNodesByPath(fp.path);
      } catch (err) {
        logger.warn({ path: fp.path, err }, 'Error deleting file from index');
      }
    }

    return reply.status(200).send({ deleted: true });
  });
}
