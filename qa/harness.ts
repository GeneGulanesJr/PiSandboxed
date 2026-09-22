import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface HarnessOptions {
  cdpUrl: string; // http://127.0.0.1:<hostPort> (BU_CDP_URL)
  task: string; // python code using pre-imported helpers
  workspaceDir: string; // per-task helper workspace (consumer project dir)
  pythonBin?: string; // default: <repoRoot>/.venv-qa/bin/browser-harness (repoRoot = resolve(import.meta.dirname, '..'))
  timeoutMs?: number; // default 300_000
  /** Extra env injected into the harness process (wins over the defaults below).
   *  Use for per-run daemon isolation, e.g. BH_HOME — browser-harness keeps daemon
   *  sockets/state under BH_HOME and a live daemon ignores later BU_CDP_URL changes. */
  extraEnv?: Record<string, string>;
}

export interface HarnessResult {
  ok: boolean;
  transcript: string;
  helperFiles: string[];
  error?: string;
}

export type HarnessRunner = (
  cmd: string[],
  o: { env: Record<string, string>; stdin: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export async function runHarnessTask(
  opts: HarnessOptions,
  run: HarnessRunner = realRun,
): Promise<HarnessResult> {
  const workspace = resolve(opts.workspaceDir);
  mkdirSync(workspace, { recursive: true });
  const bin = opts.pythonBin ?? defaultBin();
  const env = {
    ...process.env,
    BU_CDP_URL: opts.cdpUrl,
    BH_AGENT_WORKSPACE: workspace,
    BH_TAB_MARKER: '0',
    ...(opts.extraEnv ?? {}),
  } as Record<string, string>;
  // Best-effort daemon bounce: a live daemon ignores later BU_CDP_URL changes
  // (browser-harness notes §7.1). `--reload` is a STANDALONE stop-daemon command
  // (verified: exits 0 and never executes stdin), so the task itself runs in a
  // second, flag-free invocation whose daemon auto-starts with our env.
  await run([bin, '--reload'], { env, stdin: '', timeoutMs: 15_000 });
  const r = await run([bin], {
    env,
    stdin: opts.task,
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  let helperFiles: string[] = [];
  try {
    helperFiles = readdirSync(workspace).filter((f) => f.endsWith('.py'));
  } catch {
    /* gone */
  }
  if (r.exitCode !== 0) {
    return { ok: false, transcript: r.stdout, helperFiles, error: r.stderr || `exit ${r.exitCode}` };
  }
  return { ok: true, transcript: r.stdout, helperFiles };
}

function defaultBin(): string {
  return join(resolve(import.meta.dirname ?? '.', '..'), '.venv-qa', 'bin', 'browser-harness');
}

function realRun(cmd: string[], o: { env: Record<string, string>; stdin: string; timeoutMs: number }) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((res) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: o.env });
    let stdout = '';
    let stderr = '';
    let stdinWritten = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('spawn', () => {
      if (!stdinWritten) {
        stdinWritten = true;
        child.stdin.write(o.stdin);
        child.stdin.end();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      res({ stdout, stderr: stderr + err.message, exitCode: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
