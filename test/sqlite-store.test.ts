import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/adapters/sqlite/store.js';

describe('sqlite store', () => {
  const dirs: string[] = [];
  function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'pisand-'));
    dirs.push(dir);
    return openStore(join(dir, 'test.db'));
  }
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  it('round-trips a sandbox row', () => {
    const s = fresh();
    s.sandboxes.insert({
      id: 'sb_abc', profile: 'dev', mode: 'ephemeral', state: 'running',
      machineName: 'sb_abc', project: '/tmp/p', createdAt: '2026-09-22T00:00:00Z',
      expiresAt: '2026-09-22T00:30:00Z', stoppedAt: null,
    });
    const row = s.sandboxes.get('sb_abc');
    expect(row?.profile).toBe('dev');
    s.sandboxes.updateState('sb_abc', 'stopped', '2026-09-22T00:10:00Z');
    expect(s.sandboxes.get('sb_abc')?.state).toBe('stopped');
    expect(s.sandboxes.listActive()).toEqual([]);
  });

  it('lists active rows by state', () => {
    const s = fresh();
    for (const id of ['sb_1', 'sb_2']) {
      s.sandboxes.insert({
        id, profile: 'dev', mode: 'ephemeral', state: 'running', machineName: id,
        project: null, createdAt: '2026-09-22T00:00:00Z', expiresAt: null, stoppedAt: null,
      });
    }
    expect(s.sandboxes.listByState('running').length).toBe(2);
  });

  it('appends and queries audit entries (newest first)', () => {
    const s = fresh();
    s.audit.append({ ts: 't1', event: 'sandbox.created', sandboxId: 'sb_1', payload: { x: 1 } });
    s.audit.append({ ts: 't2', event: 'exec.completed', sandboxId: 'sb_1', payload: { exitCode: 0 } });
    const rows = s.audit.query(10);
    expect(rows.length).toBe(2);
    expect(rows[0]!.event).toBe('exec.completed');
    expect(rows[0]!.payload).toEqual({ exitCode: 0 });
    expect(rows[1]!.event).toBe('sandbox.created');
  });
});
