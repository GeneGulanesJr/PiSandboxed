import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileRegistryImpl } from '../src/adapters/profiles/registry.js';

const VALID = `
image = "node:26-alpine"
cpus = 2
memory = 2048
ttl = "10m"
net = false

[network]
allow_hosts = []

[[mounts]]
host = "/home/me/Documents/{project}"
guest = "/workspace"
mode = "rw"

[secrets]
ssh_agent = false
`;

describe('ProfileRegistry', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } });

  function setup(builtin: Record<string, string>, user: Record<string, string> = {}) {
    dir = mkdtemp();
    const b = join(dir, 'builtin'); const u = join(dir, 'user');
    mkdirSync(b); mkdirSync(u);
    for (const [name, content] of Object.entries(builtin)) writeFileSync(join(b, `${name}.toml`), content);
    for (const [name, content] of Object.entries(user)) writeFileSync(join(u, `${name}.toml`), content);
    return new ProfileRegistryImpl([b, u]);
  }

  it('parses a valid profile with mounts', async () => {
    const reg = setup({ dev: VALID });
    const p = await reg.get('dev');
    expect(p?.image).toBe('node:26-alpine');
    expect(p?.ttlMs).toBe(10 * 60_000);
    expect(p?.mounts[0]).toEqual({ host: '/home/me/Documents/{project}', guest: '/workspace', readWrite: true });
  });

  it('rejects invalid toml (bad field)', async () => {
    const reg = setup({ bad: 'cpus = "four"' });
    await expect(reg.get('bad')).rejects.toThrow(/cpus/);
  });

  it('user profile cannot shadow a builtin — fails loudly at construction', () => {
    expect(() => setup({ dev: VALID }, { dev: VALID })).toThrow(/shadow/);
  });

  it('lists all profiles from all sources', async () => {
    const reg = setup({ dev: VALID, untrusted: VALID }, { extra: VALID });
    await expect(reg.list()).resolves.toHaveLength(3);
  });

  it('unknown profile returns undefined', async () => {
    const reg = setup({});
    await expect(reg.get('nope')).resolves.toBeUndefined();
  });
});

function mkdtemp(): string {
  const dir = join(tmpdir(), `pisand-profiles-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
