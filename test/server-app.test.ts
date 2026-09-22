import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { EventBus } from '../src/core/events.js';
import type { ModeManager, ProfileRegistry, ResolvedProfile } from '../src/core/ports.js';

const TOKEN = 'test-token-123';
const PROFILE: ResolvedProfile = {
  name: 'dev', image: 'img', cpus: 1, memoryMb: 512, ttlMs: 60_000, net: false,
  allowHosts: [], sshAgent: false, mounts: [],
};

function harness() {
  const registry: ProfileRegistry = { get: async () => PROFILE, list: async () => [PROFILE] };
  const mode: ModeManager = {
    mode: 'ephemeral',
    ids: () => [],
    create: async () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: 't', expiresAt: null }),
    get: async () => ({
      id: 'sb_1', mode: 'ephemeral',
      info: () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: 't', expiresAt: null }),
      exec: async (input) => { input.onOutput?.({ stream: 'stdout', data: 'hello\n' }); return { exitCode: 0, stdout: 'hello\n', stderr: '' }; },
      destroy: async () => {},
    }),
    destroy: async () => {},
    destroyAll: async () => {},
  };
  const app = buildApp({ registry, modes: new Map([['ephemeral', mode]]), bus: new EventBus(), token: TOKEN });
  return { app, mode };
}

describe('sandboxd HTTP API', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('401s without bearer token', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/sandboxes' });
    expect(res.statusCode).toBe(401);
  });

  it('401s with wrong token', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/sandboxes', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('healthz is open (no auth)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('POST /sandboxes creates and returns 201 with info', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/sandboxes',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { profile: 'dev', mode: 'ephemeral' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe('sb_1');
  });

  it('POST /sandboxes maps policy errors to 400', async () => {
    const registry: ProfileRegistry = { get: async () => undefined, list: async () => [] };
    const mode: ModeManager = { ...h.mode };
    const app = buildApp({ registry, modes: new Map([['ephemeral', mode]]), bus: new EventBus(), token: TOKEN });
    const res = await app.inject({
      method: 'POST', url: '/sandboxes',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { profile: 'ghost', mode: 'ephemeral' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown profile/i);
  });

  it('GET /sandboxes/:id returns info', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/sandboxes/sb_1', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('sb_1');
  });

  it('GET /profiles lists profiles', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/profiles', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.json().profiles.map((p: { name: string }) => p.name)).toEqual(['dev']);
  });

  it('exec returns SSE-shaped body with chunks and final result', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/sandboxes/sb_1/exec',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { cmd: ['echo', 'hello'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data: {"stream":"stdout","data":"hello\\n"}');
    expect(res.body).toContain('"exitCode":0');
    expect(res.body).toContain('data: [DONE]');
  });

  it('exec rejects empty cmd with 400', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/sandboxes/sb_1/exec',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { cmd: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /sandboxes/:id destroys with 204', async () => {
    const res = await h.app.inject({ method: 'DELETE', url: '/sandboxes/sb_1', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(204);
  });

  it('promote endpoint wires extractors through the service', async () => {
    const app = buildApp({
      registry: { get: async () => PROFILE, list: async () => [PROFILE] },
      modes: h.app === undefined ? new Map() : new Map([['ephemeral', (h as unknown as { mode: ModeManager }).mode]]),
      bus: new EventBus(), token: TOKEN,
      extractors: [{ kind: 'stub', run: async () => ({ kind: 'stub', detail: 'ok' }) }],
    });
    const res = await app.inject({
      method: 'POST', url: '/sandboxes/sb_1/promote',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { kind: 'stub', params: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'stub', detail: 'ok' });
  });

  it('GET /audit returns entries from the injected auditQuery', async () => {
    const app = buildApp({
      registry: { get: async () => PROFILE, list: async () => [PROFILE] },
      modes: new Map(), bus: new EventBus(), token: TOKEN,
      auditQuery: () => [{ ts: 't', event: 'sandbox.created', sandboxId: 'sb_1', payload: {} }],
    });
    const res = await app.inject({ method: 'GET', url: '/audit?limit=5', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});
