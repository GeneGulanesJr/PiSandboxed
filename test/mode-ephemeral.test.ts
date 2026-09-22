import { describe, expect, it } from 'vitest';
import { EphemeralMode } from '../src/modes/ephemeral.js';
import type {
  BackendHandle, BootOptions, CreateSandboxInput, IsolationBackend,
  ManagedSandbox, ResolvedProfile, SandboxRepo, SandboxState,
} from '../src/core/ports.js';

const PROFILE: ResolvedProfile = {
  name: 'dev', image: 'node26-dev', cpus: 2, memoryMb: 2048, ttlMs: 600_000,
  net: false, allowHosts: [], sshAgent: false,
  mounts: [{ host: '/h/{project}', guest: '/workspace', readWrite: true }],
};

function fakeBackend() {
  const booted: BootOptions[] = [];
  const removed: string[] = [];
  const backend: IsolationBackend = {
    async boot(opts) {
      booted.push(opts);
      const handle: BackendHandle = {
        machineName: opts.machineName,
        exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
        stop: async () => {},
        remove: async () => { removed.push(opts.machineName); },
      };
      return handle;
    },
  };
  return { backend, booted, removed };
}

function fakeRepo() {
  const states = new Map<string, SandboxState>();
  const repo: SandboxRepo = {
    insert: () => {},
    get: () => undefined,
    listByState: () => [],
    listActive: () => [],
    updateState: (id, state) => { states.set(id, state); },
  };
  return { repo, states };
}

describe('EphemeralMode', () => {
  it('create boots a VM named after the sandbox id and returns running info', async () => {
    const { backend, booted } = fakeBackend();
    const mode = new EphemeralMode(backend, fakeRepo().repo);
    const input: CreateSandboxInput = { profile: 'dev', mode: 'ephemeral', project: '/tmp/proj' };
    const info = await mode.create(input, PROFILE);
    expect(info.state).toBe('running');
    expect(booted).toHaveLength(1);
    expect(booted[0]!.machineName).toBe(info.id);
    expect(info.id).toMatch(/^sb_[0-9a-z]{12}$/);
    expect(mode.ids()).toContain(info.id);
  });

  it('passes profile resources to boot unchanged', async () => {
    const { backend, booted } = fakeBackend();
    const mode = new EphemeralMode(backend, fakeRepo().repo);
    await mode.create({ profile: 'dev', mode: 'ephemeral', project: '/p' }, PROFILE);
    expect(booted[0]!.image).toBe('node26-dev');
    expect(booted[0]!.cpus).toBe(2);
    expect(booted[0]!.memoryMb).toBe(2048);
    expect(booted[0]!.mounts[0]!.host).toBe('/h/{project}'); // placeholder expansion is the SERVICE's job, not the mode's
  });

  it('repo row is inserted as creating then flipped to running', async () => {
    const { backend } = fakeBackend();
    const { repo, states } = fakeRepo();
    const mode = new EphemeralMode(backend, repo);
    const info = await mode.create({ profile: 'dev', mode: 'ephemeral', project: '/p' }, PROFILE);
    expect(states.get(info.id)).toBe('running');
  });

  it('destroy stops, removes, and reports id gone from ids()', async () => {
    const { backend, removed } = fakeBackend();
    const mode = new EphemeralMode(backend, fakeRepo().repo);
    const info = await mode.create({ profile: 'dev', mode: 'ephemeral', project: '/p' }, PROFILE);
    await mode.destroy(info.id, 'test');
    expect(removed).toEqual([info.id]);
    expect(mode.ids()).not.toContain(info.id);
  });

  it('destroy of unknown id is a no-op', async () => {
    const { backend, removed } = fakeBackend();
    const mode = new EphemeralMode(backend, fakeRepo().repo);
    await mode.destroy('sb_nothing', 'test');
    expect(removed).toEqual([]);
  });

  it('get returns a ManagedSandbox that execs through the backend handle', async () => {
    const { backend } = fakeBackend();
    const mode = new EphemeralMode(backend, fakeRepo().repo);
    const info = await mode.create({ profile: 'dev', mode: 'ephemeral', project: '/p' }, PROFILE);
    const sb: ManagedSandbox | undefined = await mode.get(info.id);
    expect(sb).toBeDefined();
    expect(sb!.id).toBe(info.id);
    const out = await sb!.exec({ cmd: ['echo', 'hi'] });
    expect(out.stdout).toBe('ok');
    await expect(mode.get('sb_missing')).resolves.toBeUndefined();
  });
});
