import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { PolicyError } from '../core/sandbox-service.js';
import type { ArtifactExtractor, PromoteContext, PromoteResult } from '../core/ports.js';

export class ArtifactsExtractor implements ArtifactExtractor {
  readonly kind = 'artifacts';

  async run(ctx: PromoteContext): Promise<PromoteResult> {
    if (!ctx.projectHostPath) throw new PolicyError('promote:artifacts requires a project mount');
    const rawTarget = typeof ctx.params.targetDir === 'string' ? ctx.params.targetDir : join(ctx.projectHostPath, 'artifacts');
    const target = resolve(rawTarget);
    const projectRoot = resolve(ctx.projectHostPath);
    if (!target.startsWith(projectRoot + sep)) {
      throw new PolicyError(`targetDir "${target}" is outside the project root — denied`);
    }
    const out = await ctx.sandbox.exec({ cmd: ['sh', '-c', 'cd /workspace && tar -cf - artifacts 2>/dev/null || tar -cf - .'] });
    if (out.exitCode !== 0) throw new PolicyError(`tar in guest failed: ${out.stderr}`);
    mkdirSync(target, { recursive: true });
    const buf = Buffer.from(out.stdout, 'binary');
    const x = spawnSync('tar', ['-xf', '-', '-C', target], { input: buf });
    if (x.status !== 0) throw new PolicyError(`host-side untar failed: ${x.stderr?.toString() ?? ''}`);
    return { kind: this.kind, detail: `artifacts extracted to ${target}` };
  }
}
