import { describe, expect, it } from 'vitest';
import { SandboxService, PolicyError } from '../src/core/sandbox-service.js';
import { EventBus } from '../src/core/events.js';
import type { CreateSandboxInput, ManagedSandbox, ModeManager, ProfileRegistry, ResolvedProfile, SandboxBus, SandboxInfo } from '../src/core/ports.js';

const PROFILE: ResolvedProfile = {
  name: 'dev', image: 'img', cpus: 2, memoryMb: 2048, ttlMs: 600_000, net: false,
  allowHosts: [], sshAgent: false,
  mounts: [{ host: '/h/{project}', guest: '/workspace', readWrite: true }],
};

function fakeMode(info?: Partial<SandboxInfo>): ModeManager & { created: CreateSandboxInput[]; destroyed: string[]; live: string[] } {
  const created: CreateSandboxInput[] = [];
  const destroyed: string[] = [];
  const live: string[] = [];
  return {
    mode: 'ephemeral',
    created, destroyed, live,
    ids: () => live.filter((id) => !destroyed.includes(id)),
    async create(input: CreateSandboxInput): Promise<SandboxInfo> {
      created.push(input);
      const sb: SandboxInfo = {
        id: 'sb_1', profile: input.profile, mode: 'ephemeral', state: 'running',
        project: input.project ?? null, createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), ...info,
      };
      live.push(sb.id);
      return sb;
    },
    async get() { return undefined; },
    async destroy(id: string) { destroyed.push(id); },
    async destroyAll() {},
  };
}

function setup(profile: ResolvedProfile = PROFILE) {
  const registry: ProfileRegistry = { get: async (n) => (n === profile.name ? profile : undefined), list: async () => [profile] };
  const mode = fakeMode();
  const modes = new Map([['ephemeral', mode]]);
  const bus: SandboxBus = new EventBus();
  const svc = new SandboxService({ registry, modes, bus, now: () => new Date('2026-09-22T00:00:00Z') });
  return { svc, mode, bus, registry };
}

describe('SandboxService.create — policy gate', () => {
  it('expands {project} placeholder and delegates to mode', async () => {
    const { svc, mode } = setup();
    const info = await svc.create({ profile: 'dev', mode: 'ephemeral', project: 'tmp/p' });
    expect(info.id).toBe('sb_1');
    const resolved = (svc as unknown as { lastResolved: ResolvedProfile }).lastResolved;
    expect(resolved.mounts[0]!.host).toBe('/h/tmp/p');
  });

  it('ABSOLUTE project path is used verbatim as mount host (no template prefix splicing)', async () => {
    const { svc } = setup();
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/home/genegulanesjr/Documents/GulanesKorp/repo' });
    const resolved = (svc as unknown as { lastResolved: ResolvedProfile }).lastResolved;
    expect(resolved.mounts[0]!.host).toBe('/home/genegulanesjr/Documents/GulanesKorp/repo');
  });

  it('RELATIVE project path substitutes into the template prefix', async () => {
    const { svc } = setup();
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: 'GulanesKorp/repo' });
    const resolved = (svc as unknown as { lastResolved: ResolvedProfile }).lastResolved;
    expect(resolved.mounts[0]!.host).toBe('/h/GulanesKorp/repo');
  });

  it('failed create emits sandbox.failed and rethrows (auditability)', async () => {
    const { svc, mode, bus } = setup();
    const failed: Array<{ error: string }> = [];
    bus.on('sandbox.failed', (e) => failed.push({ error: e.error }));
    (mode as unknown as { create: (input: CreateSandboxInput, profile: ResolvedProfile) => Promise<SandboxInfo> }).create =
      async () => { throw new Error('mount source not found: /x'); };
    await expect(svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p' })).rejects.toThrow(/mount source/);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toContain('mount source not found');
  });

  it('denies unknown profile and emits policy.denied', async () => {
    const { svc, bus } = setup();
    const denied: unknown[] = [];
    bus.on('policy.denied', (e) => denied.push(e.request));
    await expect(svc.create({ profile: 'ghost', mode: 'ephemeral' })).rejects.toThrow(PolicyError);
    expect(denied).toHaveLength(1);
  });

  it('denies when {project} placeholder present but no project given', async () => {
    const { svc } = setup();
    await expect(svc.create({ profile: 'dev', mode: 'ephemeral' })).rejects.toThrow(/project/i);
  });

  it('denies ttl that exceeds the profile ttl', async () => {
    const { svc } = setup();
    await expect(svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p', ttlMs: 999_999_999 }))
      .rejects.toThrow(/ttl/i);
  });

  it('denies unregistered mode', async () => {
    const { svc } = setup();
    await expect(svc.create({ profile: 'dev', mode: 'persistent' })).rejects.toThrow(/mode/i);
  });

  it('allows ttl shorter than profile ttl', async () => {
    const { svc, mode } = setup();
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p', ttlMs: 1_000 });
    expect(mode.created).toHaveLength(1);
  });

  it('denied requests never reach the mode', async () => {
    const { svc, mode } = setup();
    await expect(svc.create({ profile: 'ghost', mode: 'ephemeral' })).rejects.toThrow();
    expect(mode.created).toHaveLength(0);
  });
});

describe('SandboxService — events, exec, destroy', () => {
  it('emits sandbox.created on create', async () => {
    const { svc, bus } = setup();
    const events: string[] = [];
    bus.on('sandbox.created', () => events.push('created'));
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p' });
    expect(events).toEqual(['created']);
  });

  it('exec streams through the managed sandbox and emits exec.completed', async () => {
    const { svc, mode, bus } = setup();
    const done: Array<{ id: string; exitCode: number }> = [];
    bus.on('exec.completed', (e) => done.push({ id: e.id, exitCode: e.exitCode }));
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p' });
    // make mode.get return a working ManagedSandbox for sb_1
    const handle: ManagedSandbox = {
      id: 'sb_1', mode: 'ephemeral',
      info: () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: '', expiresAt: null }),
      exec: async (input) => { input.onOutput?.({ stream: 'stdout', data: 'hi' }); return { exitCode: 0, stdout: 'hi', stderr: '' }; },
      destroy: async () => {},
    };
    (mode as unknown as { get: (id: string) => Promise<ManagedSandbox | undefined> }).get = async () => handle;
    const out = await svc.exec('sb_1', { cmd: ['echo', 'hi'] });
    expect(out.stdout).toBe('hi');
    expect(done).toEqual([{ id: 'sb_1', exitCode: 0 }]);
  });

  it('destroy emits sandbox.destroyed', async () => {
    const { svc, mode, bus } = setup();
    const gone: string[] = [];
    bus.on('sandbox.destroyed', (e) => gone.push(e.id));
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p' });
    (mode as unknown as { get: (id: string) => Promise<ManagedSandbox | undefined> }).get = async () => ({
      id: 'sb_1', mode: 'ephemeral',
      info: () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: '', expiresAt: null }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      destroy: async () => {},
    });
    await svc.destroy('sb_1', 'test');
    expect(mode.destroyed).toEqual(['sb_1']);
    expect(gone).toEqual(['sb_1']);
  });

  it('destroy of unknown sandbox is silent no-op (no event)', async () => {
    const { svc, bus } = setup();
    const gone: string[] = [];
    bus.on('sandbox.destroyed', (e) => gone.push(e.id));
    await svc.destroy('sb_ghost', 'test');
    expect(gone).toEqual([]);
  });
});

describe('SandboxService — reaper', () => {
  it('reaps expired sandboxes and emits sandbox.reaped with actual expiry', async () => {
    const { svc, mode, bus } = setup();
    const reaped: string[] = [];
    bus.on('sandbox.reaped', (e) => reaped.push(e.id));
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p' });
    const expired: ManagedSandbox = {
      id: 'sb_1', mode: 'ephemeral',
      info: () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: '', expiresAt: '2026-09-21T23:00:00Z' }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      destroy: async () => {},
    };
    (mode as unknown as { get: (id: string) => Promise<ManagedSandbox | undefined> }).get = async () => expired;
    await svc.reapOnce();
    expect(mode.destroyed).toEqual(['sb_1']);
    expect(reaped).toEqual(['sb_1']);
  });

  it('skips unexpired sandboxes', async () => {
    const { svc, mode } = setup();
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p' });
    const fresh: ManagedSandbox = {
      id: 'sb_1', mode: 'ephemeral',
      info: () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: '', expiresAt: '2026-09-23T00:00:00Z' }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      destroy: async () => {},
    };
    (mode as unknown as { get: (id: string) => Promise<ManagedSandbox | undefined> }).get = async () => fresh;
    await svc.reapOnce();
    expect(mode.destroyed).toEqual([]);
  });
});
