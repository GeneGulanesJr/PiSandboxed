#!/usr/bin/env node
/**
 * sand — CLI client for the sandboxd REST API.
 *
 * Module rule `cli-is-a-pure-http-client`: this file imports NOTHING from
 * src/{core,adapters,modes,promote,server} — it only talks HTTP.
 */
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SandCliIo {
  baseUrl?: string;
  tokenFile?: string;
  out?: (s: string) => void;
}

interface HttpResult {
  status: number;
  ok: boolean;
  body: string;
}

const DEFAULT_BASE = 'http://127.0.0.1:7331';

export async function runCli(argv: string[], io?: SandCliIo): Promise<number> {
  const out = io?.out ?? ((s: string) => { process.stdout.write(s); });
  let code = 0;
  const fail = (msg: string): void => { out(`error: ${msg}\n`); code = 1; };

  // Token: io.tokenFile ?? ~/.pisandboxed/token (read lazily so --help
  // works on machines without a daemon bootstrap; every command needs it).
  const tokenFile = io?.tokenFile ?? join(homedir(), '.pisandboxed', 'token');
  let cachedToken: string | null = null;
  const token = async (): Promise<string | null> => {
    if (cachedToken !== null) return cachedToken;
    try {
      cachedToken = (await readFile(tokenFile, 'utf8')).trim();
      return cachedToken;
    } catch (err) {
      fail(`cannot read token at ${tokenFile}: ${(err as Error).message}`);
      return null;
    }
  };

  // Base URL: io.baseUrl ?? env SAND_URL ?? http://127.0.0.1:7331
  const base = (io?.baseUrl ?? process.env.SAND_URL ?? DEFAULT_BASE).replace(/\/+$/, '');

  const request = async (method: string, path: string, body?: unknown): Promise<HttpResult | null> => {
    const t = await token();
    if (t === null) return null;
    try {
      const res = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${t}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, ok: res.ok, body: await res.text() };
    } catch (err) {
      fail(`request failed: ${(err as Error).message}`);
      return null;
    }
  };

  const bodyError = (r: HttpResult): string => {
    try {
      const parsed = JSON.parse(r.body) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
    } catch {
      /* not JSON */
    }
    return `HTTP ${r.status}`;
  };

  const parseBody = (r: HttpResult): unknown | null => {
    try {
      return JSON.parse(r.body) as unknown;
    } catch {
      fail('malformed response body');
      return null;
    }
  };

  const program = new Command();
  program.name('sand').description('client for the sandboxd API');
  const outputCfg = {
    writeOut: out,
    writeErr: out,
    outputError: (str: string, write: (s: string) => void): void => write(str),
  } as const;
  program.configureOutput(outputCfg);

  // exitOverride on every subcommand: usage errors must yield an exit code,
  // never process.exit() from library context.
  const sub = (name: string, description: string): Command =>
    program.command(name).description(description).exitOverride().configureOutput(outputCfg);

  sub('profiles', 'list available profiles')
    .action(async () => {
      const r = await request('GET', '/profiles');
      if (!r) return;
      if (!r.ok) { fail(bodyError(r)); return; }
      const parsed = parseBody(r);
      if (parsed === null) return;
      const profiles = (parsed as { profiles?: unknown }).profiles;
      if (!Array.isArray(profiles)) { fail('malformed response body'); return; }
      for (const p of profiles) {
        const row = p as { name?: unknown; image?: unknown };
        out(`${String(row.name ?? '').padEnd(12)}${String(row.image ?? '')}\n`);
      }
    });

  sub('create', 'create a sandbox')
    .requiredOption('--profile <name>', 'profile to create the sandbox from')
    .option('--mode <mode>', 'sandbox mode', 'ephemeral')
    .option('--project <dir>', 'project directory to attach')
    .option('--ttl-ms <ms>', 'time-to-live in milliseconds', (v: string) => Number(v))
    .action(async (opts: { profile: string; mode: string; project?: string; ttlMs?: number }) => {
      const payload: Record<string, unknown> = { profile: opts.profile, mode: opts.mode };
      if (opts.project !== undefined) payload.project = opts.project;
      if (opts.ttlMs !== undefined && Number.isFinite(opts.ttlMs)) payload.ttlMs = opts.ttlMs;
      const r = await request('POST', '/sandboxes', payload);
      if (!r) return;
      if (r.status !== 201) { fail(bodyError(r)); return; }
      const parsed = parseBody(r);
      if (parsed === null) return;
      const id = (parsed as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) { fail('malformed response body'); return; }
      out(`${id}\n`);
    });

  sub('exec', 'run a command inside a sandbox (streams output). Prefix the command with -- so its own flags pass through: sand exec <id> -- sh -c "..."')
    .argument('<id>', 'sandbox id')
    .argument('<cmd...>', 'command and arguments to run')
    .action(async (id: string, cmd: string[]) => {
      const r = await request('POST', `/sandboxes/${encodeURIComponent(id)}/exec`, { cmd });
      if (!r) return;
      if (!r.ok) { fail(bodyError(r)); return; }
      // SSE frames separated by a blank line; each frame: `data: <json>` or `data: [DONE]`.
      for (const frame of r.body.split('\n\n')) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0 || payload === '[DONE]') continue;
          let evt: unknown;
          try {
            evt = JSON.parse(payload) as unknown;
          } catch {
            continue;
          }
          const obj = evt as { data?: unknown; error?: unknown; result?: unknown };
          if (typeof obj.error === 'string') {
            fail(obj.error);
          } else if (
            typeof obj.result === 'object' && obj.result !== null &&
            typeof (obj.result as { exitCode?: unknown }).exitCode === 'number'
          ) {
            code = (obj.result as { exitCode: number }).exitCode;
          } else if (typeof obj.data === 'string') {
            out(obj.data);
          }
        }
      }
    });

  sub('status', 'show sandbox status')
    .argument('<id>', 'sandbox id')
    .action(async (id: string) => {
      const r = await request('GET', `/sandboxes/${encodeURIComponent(id)}`);
      if (!r) return;
      if (!r.ok) { fail(bodyError(r)); return; }
      const parsed = parseBody(r);
      if (parsed === null) return;
      out(`${JSON.stringify(parsed, null, 2)}\n`);
    });

  sub('rm', 'destroy a sandbox')
    .argument('<id>', 'sandbox id')
    .action(async (id: string) => {
      const r = await request('DELETE', `/sandboxes/${encodeURIComponent(id)}`);
      if (!r) return;
      if (r.status !== 204) { fail(bodyError(r)); return; }
    });

  sub('audit', 'show audit log rows')
    .option('-n, --limit <rows>', 'maximum rows to fetch', (v: string) => Number(v), 50)
    .action(async (opts: { limit: number }) => {
      const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 50;
      const r = await request('GET', `/audit?limit=${encodeURIComponent(String(limit))}`);
      if (!r) return;
      if (!r.ok) { fail(bodyError(r)); return; }
      const parsed = parseBody(r);
      if (parsed === null) return;
      if (!Array.isArray(parsed)) { fail('malformed response body'); return; }
      for (const rowUnknown of parsed) {
        const row = rowUnknown as { ts?: unknown; event?: unknown; sandboxId?: unknown };
        out(`${String(row.ts ?? '')} ${String(row.event ?? '').padEnd(18)} ${String(row.sandboxId ?? '')}\n`);
      }
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    // CommanderError messages are already routed to io.out via configureOutput;
    // anything else is an unexpected failure we must report, never throw.
    if ((err as { name?: string }).name !== 'CommanderError') {
      fail((err as Error).message ?? String(err));
    }
    code = 1;
  }
  return code;
}

// Direct-run guard: fires for `tsx src/cli/sand.ts`, `node dist/cli/sand.js`
// and `node bin/sand.mjs` (which imports dist/cli/sand.js) — compares the
// filename stem so .ts/.js/.mjs all match; never fires under test runners.
const selfBase = import.meta.url.slice(import.meta.url.lastIndexOf('/') + 1);
const arg1Base = (process.argv[1] ?? '').slice((process.argv[1] ?? '').lastIndexOf('/') + 1);
const stemOf = (name: string): string => name.replace(/\.(m|c)?js$|\.ts$/, '');
if (arg1Base.length > 0 && stemOf(selfBase) === stemOf(arg1Base)) {
  void runCli(process.argv.slice(2)).then((c) => { process.exit(c); });
}
