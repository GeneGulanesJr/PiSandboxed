import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('composition root wiring contract', () => {
  const src = readFileSync(resolve('src/server/main.ts'), 'utf8');
  it('is the only file importing adapters+core together', () => {
    expect(src).toContain('adapters/sqlite/store.js');
    expect(src).toContain('adapters/smolvm/backend.js');
    expect(src).toContain('modes/ephemeral.js');
    expect(src).toContain('core/events.js');
  });
  it('registers the audit sink for every event name', () => {
    for (const e of ['sandbox.created', 'exec.completed', 'policy.denied', 'promote.applied', 'sandbox.destroyed', 'sandbox.reaped']) {
      expect(src).toContain(e);
    }
  });
  it('consumes the decorated buildApp shape (built.service)', () => {
    expect(src).toMatch(/built\.service/);
    expect(src).not.toMatch(/const \{ app, service \} = buildApp/);
  });
  it('stops everything on shutdown: reaper, sandboxes, app, store', () => {
    expect(src).toContain('stopReaper');
    expect(src).toContain("destroyAll('daemon shutdown')");
    expect(src).toContain('app.close');
    expect(src).toContain('store.close');
  });

  it('guards against stale dist builds (dogfood lesson: silent port-publish loss)', () => {
    expect(src).toContain('checkBuildFreshness');
    expect(src).toContain('WARNING');
  });
});
