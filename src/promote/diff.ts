import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolicyError } from '../core/sandbox-service.js';
import type { ArtifactExtractor, PromoteContext, PromoteResult } from '../core/ports.js';

export class DiffExtractor implements ArtifactExtractor {
  readonly kind = 'diff';

  async run(ctx: PromoteContext): Promise<PromoteResult> {
    if (!ctx.projectHostPath) throw new PolicyError('promote:diff requires a project mount');
    const out = await ctx.sandbox.exec({
      cmd: ['sh', '-c', 'cd /workspace && git add -A && git diff --cached --binary'],
    });
    if (out.exitCode !== 0) throw new PolicyError(`git diff failed in guest: ${out.stderr}`);
    const patchPath = join(ctx.projectHostPath, 'pisandbox-promote.patch');
    writeFileSync(patchPath, out.stdout);
    return { kind: this.kind, detail: `patch written to ${patchPath} (${out.stdout.length} bytes)` };
  }
}
