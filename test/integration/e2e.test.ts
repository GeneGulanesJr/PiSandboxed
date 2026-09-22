import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { ProfileRegistryImpl } from '../../src/adapters/profiles/registry.js';
import { SmolvmBackend } from '../../src/adapters/smolvm/backend.js';
import { EphemeralMode } from '../../src/modes/ephemeral.js';
import { SandboxService } from '../../src/core/sandbox-service.js';
import { openStore } from '../../src/adapters/sqlite/store.js';

const enabled = process.env.RUN_VM_TESTS === '1' && existsSync(process.env.SMOLVM_BIN ?? join(homedir(), '.local/bin/smolvm'));
// Builtin profiles template mounts as /home/<user>/Documents/{project} — the same
// convention production sandd relies on (identity resolveProject). The E2E project
// therefore lives under ~/Documents and is passed BY NAME, like the API consumers do.
const d = enabled ? mkdtempSync(join(homedir(), 'Documents', 'pisand-e2e-')) : '';

describe.skipIf(!enabled)('E2E: fake subagent flow against real smolvm', () => {
  const store = openStore(join(d, 'state.db'));
  const registry = new ProfileRegistryImpl([resolve('profiles')]);
  const backend = new SmolvmBackend({ binPath: process.env.SMOLVM_BIN ?? join(homedir(), '.local/bin/smolvm') });
  const modes = new Map([['ephemeral', new EphemeralMode(backend, store.sandboxes)]]);
  const svc = new SandboxService({ registry, modes, bus: { emit() {}, on() { return () => {}; } } as never });

  afterAll(async () => {
    await svc.destroyAll('test end');
    store.close();
    rmSync(d, { recursive: true, force: true });
  });

  it('untrusted profile: net is off, exec works, guest is a real VM kernel', { timeout: 120_000 }, async () => {
    const info = await svc.create({ profile: 'untrusted', mode: 'ephemeral', project: basename(d) });
    expect(info.state).toBe('running');
    const uname = await svc.exec(info.id, { cmd: ['uname', '-a'] });
    expect(uname.stdout).toContain('Linux');
    const wget = await svc.exec(info.id, { cmd: ['sh', '-c', 'wget -q -T 3 -O /dev/null https://example.com; echo exit=$?'] });
    expect(wget.stdout).toContain('exit=1');
    const write = await svc.exec(info.id, { cmd: ['sh', '-c', 'touch /workspace/e2e-ro 2>/dev/null; echo wrote=$?'] });
    expect(write.stdout).toContain('wrote=1');
    await svc.destroy(info.id);
  });

  it('dev profile: pack boots, rw workspace, file written in guest appears on host', { timeout: 120_000 }, async () => {
    const info = await svc.create({ profile: 'dev', mode: 'ephemeral', project: basename(d) });
    await svc.exec(info.id, { cmd: ['sh', '-c', 'echo from-vm > /workspace/e2e.txt'] });
    expect(readFileSync(join(d, 'e2e.txt'), 'utf8')).toContain('from-vm');
    const node = await svc.exec(info.id, { cmd: ['node', '--version'] });
    expect(node.stdout).toMatch(/v26\./);
    await svc.destroy(info.id);
    expect(existsSync(join(d, 'e2e.txt'))).toBe(true);
  });

  it('policy gate denies profile override attempts', async () => {
    await expect(svc.create({ profile: 'nope', mode: 'ephemeral', project: basename(d) })).rejects.toThrow(/unknown profile/);
    await expect(svc.create({ profile: 'dev', mode: 'persistent', project: basename(d) })).rejects.toThrow(/mode/);
  });
});
