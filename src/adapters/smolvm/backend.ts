import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BackendHandle, BootOptions, ExecInput, ExecOutput, IsolationBackend } from '../../core/ports.js';

export class BackendError extends Error {}

export interface SmolvmBackendOptions {
  binPath: string;
  logPath?: string; // when set, every invocation line is appended (debugging/tests)
}

export class SmolvmBackend implements IsolationBackend {
  #binPath: string;
  #logPath: string;
  constructor(opts: SmolvmBackendOptions) {
    this.#binPath = opts.binPath;
    this.#logPath = opts.logPath ?? '';
  }

  async boot(opts: BootOptions): Promise<BackendHandle> {
    // IMAGE SOURCING (smolvm 1.17.0, verified): baked packs load via `--from <path>`
    // (`pack:NAME` resolves to $SMOLVM_IMAGES_DIR/NAME.smolmachine, default
    // ~/.pisandboxed/images). `--image`/-I is ONLY for registry refs, docker-save
    // tars, and rootfs dirs — a .smolmachine path under --image is not the blessed form.
    const packMatch = /^pack:(.+)$/.exec(opts.image);
    const rawPath = opts.image.endsWith('.smolmachine') ? opts.image : undefined;
    const args = [
      'machine', 'create',
      '--name', opts.machineName,
      '--cpus', String(opts.cpus),
      '--mem', String(opts.memoryMb),
    ];
    if (packMatch) {
      const imagesDir = process.env.SMOLVM_IMAGES_DIR ?? join(homedir(), '.pisandboxed', 'images');
      args.push('--from', join(imagesDir, `${packMatch[1]!}.smolmachine`));
    } else if (rawPath) {
      args.push('--from', rawPath);
    } else {
      args.push('--image', opts.image);
    }
    // EGRESS + PORT MODEL (smolvm 1.17.0, verified — backend-aware sealing matrix):
    // - bare `--net` is allow-ALL — only for an explicit full-outbound request.
    // - `--allow-host` (repeatable) implies net and gives deny-by-default allowlist.
    // - Port publishing needs `-p <mapping>` plus `--net-backend virtio-net` (tsi
    //   cannot forward inbound with net disabled; virtio-net hosts the forward in
    //   the host-side stack). CORRECTION (Task 2 spike): on virtio-net, `update
    //   --no-net` does NOT seal outbound — egress stays open. A sealed port VM is
    //   sealed at CREATE time with `--outbound-localhost-only` (host loopback stays
    //   reachable for CDP; all other egress denied). NEVER `update --no-net` when
    //   ports are present.
    if (opts.ports.length > 0) {
      for (const mapping of opts.ports) args.push('-p', mapping);
      args.push('--net-backend', 'virtio-net');
    }
    if (opts.allowHosts.length > 0) {
      for (const host of opts.allowHosts) args.push('--allow-host', host);
    } else if (opts.net) {
      args.push('--net'); // explicit full-outbound request — no builtin profile does this
    } else if (opts.ports.length > 0) {
      args.push('--outbound-localhost-only'); // the ONLY real egress seal on virtio-net
    }
    for (const m of opts.mounts) {
      args.push('--volume', `${m.host}:${m.guest}${m.readWrite ? '' : ':ro'}`);
    }
    if (opts.sshAgent) args.push('--ssh-agent');
    // workload parks via a long-lived init so exec sessions attach to a running machine
    args.push('--', '/bin/sh', '-c', 'exec sleep infinity');

    await this.#run(args, { timeoutMs: 30_000 });
    if (!opts.net && opts.allowHosts.length === 0 && opts.ports.length === 0) {
      // Sealed non-port boot: override any net=true baked into a pack/checkpoint
      // manifest. (Port VMs must NEVER take this path — see matrix above.)
      await this.#run(['machine', 'update', '--name', opts.machineName, '--no-net'], { timeoutMs: 30_000 });
    }
    await this.#run(['machine', 'start', '--name', opts.machineName], { timeoutMs: 30_000 });

    return {
      machineName: opts.machineName,
      exec: (input: ExecInput) => this.#exec(opts.machineName, input),
      stop: async () => { await this.#run(['machine', 'stop', '--name', opts.machineName], { timeoutMs: 30_000 }); },
      remove: async () => { await this.#run(['machine', 'delete', '--force', '--name', opts.machineName], { timeoutMs: 30_000 }); },
    };
  }

  async #exec(machine: string, input: ExecInput): Promise<ExecOutput> {
    return this.#run(['machine', 'exec', '--name', machine, '--', ...input.cmd], {
      timeoutMs: 600_000,
      env: input.env,
      onOutput: input.onOutput,
    });
  }

  #run(
    args: string[],
    opts: {
      timeoutMs: number;
      env?: Record<string, string> | undefined;
      onOutput?: ((c: { stream: 'stdout' | 'stderr'; data: string }) => void) | undefined;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.#log(args);
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binPath, args, {
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new BackendError(`smolvm timed out: ${args.join(' ')}`)); }, opts.timeoutMs);
      child.stdout.on('data', (d: Buffer) => { const s = d.toString(); stdout += s; opts.onOutput?.({ stream: 'stdout', data: s }); });
      child.stderr.on('data', (d: Buffer) => { const s = d.toString(); stderr += s; opts.onOutput?.({ stream: 'stderr', data: s }); });
      child.on('error', (err) => { clearTimeout(timer); reject(new BackendError(`smolvm spawn failed: ${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && args[0] === 'machine' && args[1] === 'exec') {
          resolve({ exitCode: code ?? -1, stdout, stderr }); // exec exit codes belong to the workload
          return;
        }
        if (code !== 0) { reject(new BackendError(`smolvm failed (${code}): ${args.join(' ')}\n${stderr}`)); return; }
        resolve({ exitCode: 0, stdout, stderr });
      });
    });
  }

  #log(args: string[]): void {
    if (this.#logPath) appendFileSync(this.#logPath, args.join(' ') + '\n');
  }
}
