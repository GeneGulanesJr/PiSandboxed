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
      net: false, allowHosts: [], sshAgent: false, ports: [],
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
    await backend.boot({ machineName: 'sb_n', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, ports: [], mounts: [] });
    await backend.boot({ machineName: 'sb_y', image: 'alpine', cpus: 1, memoryMb: 512, net: true, allowHosts: ['pypi.org'], sshAgent: false, ports: [], mounts: [] });
    const calls = readFileSync(log, 'utf8');
    // boot() emits create + start per machine; compare the two `machine create` lines
    const [off, on] = calls.trim().split('\n').filter((l) => l.includes('create'));
    expect(off).not.toMatch(/--net|--allow-host/);        // sealed: no network flags at all
    expect(on).not.toMatch(/--net(?![-\w])/);             // allowlist mode: NO bare --net (it's allow-all!)
    expect(on).toMatch(/--allow-host pypi\.org/);
  });

  it('exec surfaces stdout and stderr', async () => {
    const { backend } = stubBackend();
    const h = await backend.boot({ machineName: 'sb_e', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, ports: [], mounts: [] });
    const out = await h.exec({ cmd: ['false'] });
    expect(out.stdout).toContain('stub-stdout');
    expect(out.stderr).toContain('stub-stderr');
  });

  it('boot failure (missing binary) throws BackendError mentioning smolvm', async () => {
    const backend = new SmolvmBackend({ binPath: '/nonexistent/smolvm', logPath: join(tmpdir(), 'nope.log') });
    await expect(backend.boot({ machineName: 'sb_z', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, ports: [], mounts: [] }))
      .rejects.toThrow(/smolvm/);
  });

  it('pack: scheme resolves to the images dir and boots with --from', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_p1', image: 'pack:node26-dev', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, ports: [], mounts: [] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('--from');
    expect(calls).toMatch(/node26-dev\.smolmachine/);
    expect(calls).not.toMatch(/--image/);
  });

  it('raw .smolmachine paths also boot with --from; registry refs keep --image', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_p2', image: '/tmp/x.smolmachine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, ports: [], mounts: [] });
    await backend.boot({ machineName: 'sb_p3', image: 'alpine:3.20', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, ports: [], mounts: [] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('--from /tmp/x.smolmachine');
    expect(calls).toContain('--image alpine:3.20');
  });

  it('sealed boot enforces machine update --no-net (pack manifests can bake net=true)', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_s', image: 'pack:alpine3', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, ports: [], mounts: [] });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const createIdx = calls.findIndex((c) => c.includes('create'));
    const updateIdx = calls.findIndex((c) => c.includes('update') && c.includes('--no-net'));
    const startIdx = calls.findIndex((c) => c.includes('start'));
    expect(updateIdx).toBeGreaterThan(createIdx);
    expect(startIdx).toBeGreaterThan(updateIdx);
  });

  it('mounts pass through with :ro suffix for read-only', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_m', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, ports: [],
      mounts: [ { host: '/a', guest: '/w', readWrite: true }, { host: '/b', guest: '/x', readWrite: false } ] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('/a:/w');
    expect(calls).toContain('/b:/x:ro');
  });

  it('port-publishing boot: -p flags + virtio-net + --outbound-localhost-only when sealed (never update --no-net)', async () => {
    const { backend, log } = stubBackend();
    const h = await backend.boot({ machineName: 'sb_port', image: 'pack:chromium-cdp', cpus: 2, memoryMb: 2048,
      net: false, allowHosts: [], sshAgent: false, ports: ['9222:9222'], mounts: [] });
    await h.stop(); await h.remove();
    const calls = readFileSync(log, 'utf8');
    const create = calls.split('\n').find((l) => l.includes('create'))!;
    expect(create).toContain('-p 9222:9222');
    expect(create).toContain('--net-backend virtio-net');
    expect(create).toContain('--outbound-localhost-only');
    expect(calls).not.toMatch(/--no-net/); // NEVER the update-seal on a port VM (does not seal virtio-net egress)
  });

  it('sealed non-port boot keeps Phase 1 behavior: update --no-net, no port flags', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_sealed', image: 'alpine', cpus: 1, memoryMb: 512,
      net: false, allowHosts: [], sshAgent: false, ports: [], mounts: [] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toMatch(/machine update --name sb_sealed --no-net/);
    expect(calls).not.toMatch(/-p 9222|--net-backend|--outbound-localhost-only/);
  });

  it('allowlisted boot (net=true, hosts>0) is unchanged: --allow-host, no ports', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_allow', image: 'alpine', cpus: 1, memoryMb: 512,
      net: true, allowHosts: ['pypi.org'], sshAgent: false, ports: [], mounts: [] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toMatch(/--allow-host pypi\.org/);
    expect(calls).not.toMatch(/-p \d+:\d+|--outbound-localhost-only/);
  });

  it('ports on a net=true VM still publish without the localhost-only seal', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_pn', image: 'alpine', cpus: 1, memoryMb: 512,
      net: true, allowHosts: [], sshAgent: false, ports: ['8080:8080'], mounts: [] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('-p 8080:8080');
    expect(calls).toContain('--net-backend virtio-net');
    expect(calls).not.toContain('--outbound-localhost-only');
    expect(calls).not.toMatch(/--no-net/);
  });
});
