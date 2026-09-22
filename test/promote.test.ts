import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffExtractor } from '../src/promote/diff.js';
import { ArtifactsExtractor } from '../src/promote/artifacts.js';
import type { ManagedSandbox, PromoteContext } from '../src/core/ports.js';

function fakeSandbox(execImpl: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>): ManagedSandbox {
  return {
    id: 'sb_p', mode: 'ephemeral',
    info: () => ({ id: 'sb_p', profile: 'dev', mode: 'ephemeral', state: 'running', project: '/tmp/proj', createdAt: '', expiresAt: null }),
    exec: (input) => execImpl(input.cmd),
    destroy: async () => {},
  };
}

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('DiffExtractor', () => {
  it('runs git diff in-guest and writes patch under project path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pisand-promote-'));
    const sb = fakeSandbox(async (cmd) =>
      cmd.join(' ').includes('git diff') ? { exitCode: 0, stdout: 'diff --git a/x b/x', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' });
    const ctx: PromoteContext = { sandbox: sb, projectHostPath: dir, params: {} };
    const res = await new DiffExtractor().run(ctx);
    expect(res.kind).toBe('diff');
    const patch = join(dir, 'pisandbox-promote.patch');
    expect(existsSync(patch)).toBe(true);
    expect(readFileSync(patch, 'utf8')).toContain('diff --git');
  });

  it('denies when project path is not set', async () => {
    const sb = fakeSandbox(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await expect(new DiffExtractor().run({ sandbox: sb, projectHostPath: null, params: {} }))
      .rejects.toThrow(/project/i);
  });
});

describe('ArtifactsExtractor', () => {
  it('tars /workspace/artifacts in-guest and untars to host target', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pisand-promote-'));
    const sb = fakeSandbox(async (cmd) => {
      if (!cmd.join(' ').includes('tar -cf')) return { exitCode: 1, stdout: '', stderr: '' };
      const src = join(dir, 'srcartifacts');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'shot.txt'), 'PNGDATA');
      const tar = execSync(`tar -C ${JSON.stringify(src)} -cf - .`);
      return { exitCode: 0, stdout: tar.toString('binary'), stderr: '' };
    });
    const target = join(dir, 'out');
    const res = await new ArtifactsExtractor().run({ sandbox: sb, projectHostPath: dir, params: { targetDir: target } });
    expect(res.kind).toBe('artifacts');
    expect(readFileSync(join(target, 'shot.txt'), 'utf8')).toBe('PNGDATA');
  });

  it('denies targetDir outside the project path', async () => {
    const sb = fakeSandbox(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await expect(new ArtifactsExtractor().run({ sandbox: sb, projectHostPath: '/tmp/proj', params: { targetDir: '/etc/evil' } }))
      .rejects.toThrow(/outside/i);
  });

  it('defaults targetDir to <project>/artifacts when params omit it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pisand-promote-'));
    const sb = fakeSandbox(async (cmd) => {
      if (!cmd.join(' ').includes('tar -cf')) return { exitCode: 1, stdout: '', stderr: '' };
      const src = join(dir, 'srcartifacts');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'a.txt'), 'A');
      const tar = execSync(`tar -C ${JSON.stringify(src)} -cf - .`);
      return { exitCode: 0, stdout: tar.toString('binary'), stderr: '' };
    });
    const res = await new ArtifactsExtractor().run({ sandbox: sb, projectHostPath: dir, params: {} });
    expect(res.detail).toContain(join(dir, 'artifacts'));
  });
});
