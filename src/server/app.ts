import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { SandboxService } from '../core/sandbox-service.js';
import type { ArtifactExtractor, ModeManager, ProfileRegistry, SandboxBus } from '../core/ports.js';

export interface AppOptions {
  registry: ProfileRegistry;
  modes: Map<string, ModeManager>;
  bus: SandboxBus;
  token: string;
  extractors?: ArtifactExtractor[];
  auditQuery?: (limit: number) => unknown[];
}

function authorized(sent: string | undefined, expected: string): boolean {
  if (!sent?.startsWith('Bearer ')) return false;
  const a = Buffer.from(sent.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildApp(opts: AppOptions): FastifyInstance & { service: SandboxService } {
  const service = new SandboxService({ registry: opts.registry, modes: opts.modes, bus: opts.bus });
  const extractors = opts.extractors ?? [];
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    if (!authorized(req.headers.authorization, opts.token)) {
      return await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/sandboxes', async (req, reply) => {
    const body = (req.body ?? {}) as { profile?: string; mode?: string; project?: string; ttlMs?: number };
    try {
      const info = await service.create({
        profile: String(body.profile ?? ''),
        mode: (body.mode ?? 'ephemeral') as never,
        ...(body.project !== undefined ? { project: body.project } : {}),
        ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
      });
      return await reply.code(201).send(info);
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/sandboxes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try { return await service.get(id); }
    catch { return await reply.code(404).send({ error: 'not found' }); }
  });

  app.post('/sandboxes/:id/exec', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { cmd?: unknown; env?: Record<string, string> };
    if (!Array.isArray(body.cmd) || body.cmd.length === 0 || !body.cmd.every((c) => typeof c === 'string')) {
      return await reply.code(400).send({ error: 'cmd must be a non-empty string array' });
    }
    reply.header('content-type', 'text/event-stream');
    reply.header('cache-control', 'no-cache');
    const chunks: string[] = [];
    try {
      const out = await service.exec(id, {
        cmd: body.cmd as string[],
        ...(body.env !== undefined ? { env: body.env } : {}),
        onOutput: (c) => { chunks.push(`data: ${JSON.stringify(c)}\n\n`); },
      });
      chunks.push(`data: ${JSON.stringify({ result: { exitCode: out.exitCode } })}\n\n`);
      chunks.push('data: [DONE]\n\n');
    } catch (err) {
      chunks.push(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
    }
    return await reply.send(chunks.join(''));
  });

  app.post('/sandboxes/:id/promote', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { kind?: string; params?: Record<string, unknown> };
    try {
      const result = await service.promote(id, String(body.kind ?? ''), body.params ?? {}, extractors);
      return await reply.send(result);
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/sandboxes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await service.destroy(id);
    return await reply.code(204).send();
  });

  app.get('/profiles', async () => ({ profiles: await opts.registry.list() }));

  app.get('/audit', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 1000);
    return opts.auditQuery?.(limit) ?? [];
  });

  const instance = app as unknown as FastifyInstance & { service: SandboxService };
  instance.service = service;
  return instance;
}
