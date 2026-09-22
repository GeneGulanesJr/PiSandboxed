import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli/sand.js';
import { buildApp } from '../src/server/app.js';
import { EventBus } from '../src/core/events.js';
import type { ModeManager, ProfileRegistry, ResolvedProfile } from '../src/core/ports.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pisand-cli-'));
  writeFileSync(join(dir, 'token'), 'tok123\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PROFILE: ResolvedProfile = {
  name: 'dev', image: 'img', cpus: 1, memoryMb: 1, ttlMs: 1, net: false, allowHosts: [], sshAgent: false, mounts: [],
};

function harnessWithDaemon() {
  const registry: ProfileRegistry = { get: async () => PROFILE, list: async () => [PROFILE] };
  const mode: ModeManager = {
    mode: 'ephemeral', ids: () => [],
    create: async () => ({ id: 'sb_cli1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: 't', expiresAt: null }),
    get: async () => ({
      id: 'sb_cli1', mode: 'ephemeral',
      info: () => ({ id: 'sb_cli1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: 't', expiresAt: null }),
      exec: async (input) => { input.onOutput?.({ stream: 'stdout', data: 'cli-ok\n' }); return { exitCode: 0, stdout: 'cli-ok\n', stderr: '' }; },
      destroy: async () => {},
    }),
    destroy: async () => {}, destroyAll: async () => {},
  };
  const app = buildApp({ registry, modes: new Map([['ephemeral', mode]]), bus: new EventBus(), token: 'tok123', auditQuery: () => [{ ts: 't', event: 'sandbox.created', sandboxId: 'sb_cli1', payload: {} }] });
  return app;
}

async function listen(app: Awaited<ReturnType<typeof harnessWithDaemon>>): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

describe('sand CLI', () => {
  it('profiles lists via API', async () => {
    const app = harnessWithDaemon();
    const base = await listen(app);
    const out: string[] = [];
    const code = await runCli(['profiles'], { baseUrl: base, tokenFile: join(dir, 'token'), out: (s) => out.push(s) });
    await app.close();
    expect(code).toBe(0);
    expect(out.join('')).toContain('dev');
  });

  it('create prints the sandbox id', async () => {
    const app = harnessWithDaemon();
    const base = await listen(app);
    const out: string[] = [];
    const code = await runCli(['create', '--profile', 'dev'], { baseUrl: base, tokenFile: join(dir, 'token'), out: (s) => out.push(s) });
    await app.close();
    expect(code).toBe(0);
    expect(out.join('')).toContain('sb_cli1');
  });

  it('exec returns the guest exit code and prints streamed output', async () => {
    const app = harnessWithDaemon();
    const base = await listen(app);
    const out: string[] = [];
    const code = await runCli(['exec', 'sb_cli1', 'echo', 'hi'], { baseUrl: base, tokenFile: join(dir, 'token'), out: (s) => out.push(s) });
    await app.close();
    expect(code).toBe(0);
    expect(out.join('')).toContain('cli-ok');
  });

  it('status prints info', async () => {
    const app = harnessWithDaemon();
    const base = await listen(app);
    const out: string[] = [];
    const code = await runCli(['status', 'sb_cli1'], { baseUrl: base, tokenFile: join(dir, 'token'), out: (s) => out.push(s) });
    await app.close();
    expect(code).toBe(0);
    expect(out.join('')).toContain('sb_cli1');
  });

  it('rm succeeds with 0', async () => {
    const app = harnessWithDaemon();
    const base = await listen(app);
    const code = await runCli(['rm', 'sb_cli1'], { baseUrl: base, tokenFile: join(dir, 'token'), out: () => {} });
    await app.close();
    expect(code).toBe(0);
  });

  it('audit lists rows', async () => {
    const app = harnessWithDaemon();
    const base = await listen(app);
    const out: string[] = [];
    const code = await runCli(['audit'], { baseUrl: base, tokenFile: join(dir, 'token'), out: (s) => out.push(s) });
    await app.close();
    expect(code).toBe(0);
    expect(out.join('')).toContain('sandbox.created');
  });

  it('fails non-zero on bad token', async () => {
    const app = harnessWithDaemon();
    const base = await listen(app);
    writeFileSync(join(dir, 'token'), 'WRONG\n');
    const code = await runCli(['profiles'], { baseUrl: base, tokenFile: join(dir, 'token'), out: () => {} });
    await app.close();
    expect(code).not.toBe(0);
  });
});
