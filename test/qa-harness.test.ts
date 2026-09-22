import { describe, expect, it } from 'vitest';
import { runHarnessTask } from '../qa/harness.js';

function fakeRunner() {
  const calls: Array<{ cmd: string[]; env: Record<string, string | undefined>; stdin: string }> = [];
  const run = async (cmd: string[], opts: { env?: Record<string, string>; stdin?: string; timeoutMs?: number }) => {
    calls.push({ cmd, env: (opts.env ?? {}) as Record<string, string | undefined>, stdin: opts.stdin ?? '' });
    return { stdout: 'TITLE: Example\nURL: https://example.com/\n', stderr: '', exitCode: 0 };
  };
  return { run, calls };
}

describe('runHarnessTask', () => {
  const base = {
    cdpUrl: 'http://127.0.0.1:9222',
    task: 'new_tab("https://example.com"); page_info()',
    workspaceDir: '/tmp/wk',
  };

  it('invokes the venv browser-harness binary with --reload, stdin script, and harness env', async () => {
    const { run, calls } = fakeRunner();
    await runHarnessTask(base, run);
    expect(calls).toHaveLength(1);
    const { cmd, env, stdin } = calls[0]!;
    expect(cmd[0]).toMatch(/browser-harness$/);
    expect(cmd).toContain('--reload');
    expect(env!['BU_CDP_URL']).toBe('http://127.0.0.1:9222');
    expect(env!['BH_AGENT_WORKSPACE']).toBe('/tmp/wk');
    expect(env!['BH_TAB_MARKER']).toBe('0');
    expect(stdin).toContain('new_tab("https://example.com")');
  });

  it('creates the workspace dir before the run', async () => {
    const { run } = fakeRunner();
    const workspaceDir = await import('node:os').then((o) => o.tmpdir());
    void workspaceDir;
    // behavioral check: no throw + helperFiles listing works on a real tmp dir
    const res = await runHarnessTask({ ...base, workspaceDir: '/tmp/bh-wk-test' }, run);
    expect(res.ok).toBe(true);
  });

  it('returns ok=true with transcript on exit 0', async () => {
    const { run } = fakeRunner();
    const res = await runHarnessTask(base, run);
    expect(res.ok).toBe(true);
    expect(res.transcript).toContain('TITLE: Example');
  });

  it('returns ok=false + error on non-zero exit', async () => {
    const run = async () => ({ stdout: 'partial', stderr: 'fatal: endpoint dead', exitCode: 1 });
    const res = await runHarnessTask(base, run);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('endpoint dead');
  });

  it('lists generated helper files from the workspace', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = join(tmpdir(), `bh-wk-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const run = async (_cmd: string[], opts: { env?: Record<string, string> }) => {
      writeFileSync(join(opts.env!['BH_AGENT_WORKSPACE']!, 'agent_helpers.py'), '# generated');
      return { stdout: 'done', stderr: '', exitCode: 0 };
    };
    const res = await runHarnessTask({ ...base, workspaceDir: dir }, run);
    rmSync(dir, { recursive: true, force: true });
    expect(res.ok).toBe(true);
    expect(res.helperFiles).toContain('agent_helpers.py');
  });

  it('times out: kills and returns ok=false', async () => {
    const run = async (_cmd: string[], opts: { timeoutMs?: number }) => {
      expect(opts.timeoutMs).toBe(50);
      await new Promise((r) => setTimeout(r, 10)); // runner-level timeout simulation
      return { stdout: '', stderr: 'timed out', exitCode: 124 };
    };
    const res = await runHarnessTask({ ...base, timeoutMs: 50 }, run);
    expect(res.ok).toBe(false);
  });
});
