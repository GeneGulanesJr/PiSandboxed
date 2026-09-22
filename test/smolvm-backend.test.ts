import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SmolvmBackend } from '../src/adapters/smolvm/backend.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function stubBackend() {
  dir = mkdtempSync(join(tmpdir(), 'pisand-smolvm-'));
  const bin = join(dir, 'smolvm');
  const src = new URL('./helpers/stub-smolvm.sh', import.meta.url);
  writeFileSync(bin, readFileSync(src, 'utf8'));
  chmodSync(bin, 0o755);
  const log = join(dir, 'invocations.log');
  return { backend: new SmolvmBackend({ binPath: bin, logPath: log }), log, dir };
}

describe('SmolvmBackend', () => {
  it('boot → exec → stop → remove issues the right CLI sequence', async () => {
    const { backend, log } = stubBackend();
    const h = await backend.boot({
      machineName: 'sb_x1', image: 'alpine', cpus: 2, memoryMb: 2048,
      net: false, allowHosts: [], sshAgent: false,
      mounts: [{ host: '/tmp/h', guest: '/workspace', readWrite: false }],
    });
    await h.exec({ cmd: ['uname', '-a'] });
    await h.stop();
    await h.remove();
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.some((c) => c.includes('machine') && c.includes('create') && c.includes('sb_x1'))).toBe(true);
    expect(calls.some((c) => c.includes('exec') && c.includes('uname'))).toBe(true);
    expect(calls.some((c) => c.includes('stop'))).toBe(true);
    expect(calls.some((c) => c.includes('delete') || c.includes('rm'))).toBe(true);
  });

  it('net-off boot never passes network flags; allowlist boot passes --allow-host and NEVER bare --net', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_n', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] });
    await backend.boot({ machineName: 'sb_y', image: 'alpine', cpus: 1, memoryMb: 512, net: true, allowHosts: ['pypi.org'], sshAgent: false, mounts: [] });
    const calls = readFileSync(log, 'utf8');
    // boot() emits create + start per machine; compare the two `machine create` lines
    const [off, on] = calls.trim().split('\n').filter((l) => l.includes('create'));
    expect(off).not.toMatch(/--net|--allow-host/);        // sealed: no network flags at all
    expect(on).not.toMatch(/--net(?![-\w])/);             // allowlist mode: NO bare --net (it's allow-all!)
    expect(on).toMatch(/--allow-host pypi\.org/);
  });

  it('exec surfaces stdout and stderr', async () => {
    const { backend } = stubBackend();
    const h = await backend.boot({ machineName: 'sb_e', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] });
    const out = await h.exec({ cmd: ['false'] });
    expect(out.stdout).toContain('stub-stdout');
    expect(out.stderr).toContain('stub-stderr');
  });

  it('boot failure (missing binary) throws BackendError mentioning smolvm', async () => {
    const backend = new SmolvmBackend({ binPath: '/nonexistent/smolvm', logPath: join(tmpdir(), 'nope.log') });
    await expect(backend.boot({ machineName: 'sb_z', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] }))
      .rejects.toThrow(/smolvm/);
  });

  it('pack: scheme resolves to the images dir and boots with --from', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_p1', image: 'pack:node26-dev', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('--from');
    expect(calls).toMatch(/node26-dev\.smolmachine/);
    expect(calls).not.toMatch(/--image/);
  });

  it('raw .smolmachine paths also boot with --from; registry refs keep --image', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_p2', image: '/tmp/x.smolmachine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] });
    await backend.boot({ machineName: 'sb_p3', image: 'alpine:3.20', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('--from /tmp/x.smolmachine');
    expect(calls).toContain('--image alpine:3.20');
  });

  it('mounts pass through with :ro suffix for read-only', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_m', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false,
      mounts: [ { host: '/a', guest: '/w', readWrite: true }, { host: '/b', guest: '/x', readWrite: false } ] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('/a:/w');
    expect(calls).toContain('/b:/x:ro');
  });
});
