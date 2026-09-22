// sandd — daemon entry point / composition root.
// This is the ONLY module allowed to import core and adapters together
// (dependency-cruiser rule: only-composition-root-wires-everything).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../adapters/sqlite/store.js';
import { ProfileRegistryImpl } from '../adapters/profiles/registry.js';
import { SmolvmBackend } from '../adapters/smolvm/backend.js';
import { EphemeralMode } from '../modes/ephemeral.js';
import { DiffExtractor } from '../promote/diff.js';
import { ArtifactsExtractor } from '../promote/artifacts.js';
import { buildApp } from './app.js';
import type { SandboxBus, SandboxEventMap } from '../core/ports.js';
import { EventBus } from '../core/events.js';

const STATE_DIR = join(homedir(), '.pisandboxed');
const PORT = Number(process.env.SANDD_PORT ?? 7331);

function loadOrCreateToken(): string {
  const path = join(STATE_DIR, 'token');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = randomBytes(32).toString('hex');
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return token;
}

/** Warn loudly when dist/ is older than src/ — stale builds caused a silent
 *  port-publishing failure in dogfooding (backend rewrite missing from dist). */
export function checkBuildFreshness(selfPath: string, srcRoot: string): string | undefined {
  try {
    if (!selfPath.endsWith('.js')) return undefined; // running from src (tsx) — always fresh
    const built = statSync(selfPath).mtimeMs;
    let newest = 0;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) newest = Math.max(newest, statSync(p).mtimeMs);
      }
    };
    walk(srcRoot);
    if (newest > built + 1000) {
      return `dist/ is OLDER than src/ — rebuild: npm run build && restart sandd (stale builds silently lose behavior, e.g. port publishing)`;
    }
  } catch { /* best-effort guard */ }
  return undefined;
}

export async function main(): Promise<{ stop: () => Promise<void> }> {
  const stale = checkBuildFreshness(fileURLToPath(import.meta.url), resolve(import.meta.dirname ?? '.', '..', '..', 'src'));
  if (stale) console.warn(`[sandd] WARNING: ${stale}`);
  const token = loadOrCreateToken();
  const store = openStore(join(STATE_DIR, 'state.db'));
  const registry = new ProfileRegistryImpl([join(process.cwd(), 'profiles'), join(STATE_DIR, 'profiles')]);
  const backend = new SmolvmBackend({ binPath: process.env.SMOLVM_BIN ?? join(homedir(), '.local', 'bin', 'smolvm') });
  const modes = new Map([['ephemeral', new EphemeralMode(backend, store.sandboxes)]]);
  const bus: SandboxBus = new EventBus<SandboxEventMap>();

  const events = ['sandbox.created', 'exec.completed', 'policy.denied', 'promote.applied', 'sandbox.destroyed', 'sandbox.reaped', 'sandbox.failed'] as const;
  for (const event of events) {
    bus.on(event, (e) => {
      store.audit.append({
        ts: new Date().toISOString(),
        event,
        sandboxId: 'id' in e ? String((e as { id: unknown }).id) : null,
        payload: e as Record<string, unknown>,
      });
    });
  }

  const built = buildApp({
    registry, modes, bus, token,
    extractors: [new DiffExtractor(), new ArtifactsExtractor()],
    auditQuery: (limit) => store.audit.query(limit),
  });
  // buildApp returns the FastifyInstance itself, decorated with `.service`.
  const app = built;
  built.service.startReaper();

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`[sandd] listening on http://127.0.0.1:${PORT} (token: ${join(STATE_DIR, 'token')})`);

  return {
    stop: async () => {
      built.service.stopReaper();
      await built.service.destroyAll('daemon shutdown').catch(() => {});
      await app.close();
      store.close();
    },
  };
}

// direct-run entry (tsx src/server/main.ts or node dist/server/main.js)
const invoked = process.argv[1] ? process.argv[1].replace(/\\$/, '') : '';
if (invoked && (invoked.endsWith('main.ts') || invoked.endsWith('main.js')) && import.meta.url.endsWith(invoked.split('/').pop() ?? '##')) {
  void main().then(({ stop }) => {
    const shutdown = (signal: string) => {
      console.log(`[sandd] ${signal}, cleaning up…`);
      void stop().then(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}
