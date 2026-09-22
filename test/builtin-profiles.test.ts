import { describe, expect, it } from 'vitest';
import { ProfileRegistryImpl } from '../src/adapters/profiles/registry.js';
import { resolve } from 'node:path';

const reg = new ProfileRegistryImpl([resolve('profiles')]);

describe('builtin profiles (spec §5)', () => {
  it('untrusted: no net, RO mount, no secrets, 2cpu/2GB, 10m', async () => {
    const p = await reg.get('untrusted');
    expect(p).toMatchObject({ net: false, allowHosts: [], sshAgent: false, cpus: 2, memoryMb: 2048, ttlMs: 600_000 });
    expect(p?.mounts[0]?.readWrite).toBe(false);
  });

  it('dev: allowlisted net, rw mount, no secrets, 4cpu/8GB, 30m', async () => {
    const p = await reg.get('dev');
    expect(p).toMatchObject({ net: true, sshAgent: false, cpus: 4, memoryMb: 8192, ttlMs: 1_800_000 });
    expect(p?.allowHosts).toEqual(expect.arrayContaining(['registry.npmjs.org', 'github.com']));
    expect(p?.mounts[0]?.readWrite).toBe(true);
  });

  it('build: ssh agent, narrow net, rw mount, 1h', async () => {
    const p = await reg.get('build');
    expect(p).toMatchObject({ net: true, sshAgent: true, ttlMs: 3_600_000 });
    expect(p?.allowHosts).not.toContain('*');
  });

  it('all builtins carry exactly one {project} mount at /workspace', async () => {
    for (const p of await reg.list()) {
      const ws = p.mounts.filter((m) => m.guest === '/workspace');
      expect(ws, p.name).toHaveLength(1);
      expect(ws[0]!.host).toContain('{project}');
    }
  });

  it('browser-test: chromium-cdp pack, exactly one CDP port, sealed net, rw workspace', async () => {
    const p = await reg.get('browser-test');
    expect(p).toMatchObject({ image: 'pack:chromium-cdp', net: false, sshAgent: false, ttlMs: 3_600_000 });
    expect(p?.ports).toEqual(['9222:9222']);
    expect(p?.allowHosts).toEqual([]);
    expect(p?.mounts[0]?.readWrite).toBe(true);
  });
});
