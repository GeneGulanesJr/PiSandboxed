# PiSandboxed Phase 1 (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use Sequential mode for planned tasks or Direct mode if subagents aren't available. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sandboxd — a localhost daemon that gives subagents hardware-isolated smolvm microVMs behind a policy-checked REST API, with a `sand` CLI client.

**Architecture:** Ports-and-adapters in a single TypeScript package. `core/` (SandboxService + event bus) depends only on interfaces in `core/ports.ts`; `adapters/smolvm`, `adapters/sqlite`, `adapters/profiles`, `modes/ephemeral`, `promote/` implement ports; `server/main.ts` is the composition root. Dependency direction `server → core → ports ← adapters` enforced by dependency-cruiser.

**Tech Stack:** Node 26 + TypeScript (strict), Fastify 5, better-sqlite3, zod 4, smol-toml, commander, vitest 3 + @vitest/coverage-v8, dependency-cruiser, tsx (dev runner).

**Spec:** `docs/superpowers/specs/2026-09-22-pisandboxed-sandbox-service-design.md`

**Conventions:**
- Repo root: `/home/genegulanesjr/Documents/GulanesKorp/PiSandboxed`
- Every task ends with a commit. Tests run before implementation (TDD).
- Integration tests that need real smolvm/KVM are gated behind `RUN_VM_TESTS=1` and skipped otherwise.
- NO `sudo` on this host. smolvm installs user-level.

---

### Task 1: Project scaffold + tooling gates

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.dependency-cruiser.cjs`, `.gitignore`, `bin/sandd.mjs`, `bin/sand.mjs`, `src/core/ports.ts` (placeholder type only)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "pisandboxed",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=26" },
  "bin": {
    "sandd": "./bin/sandd.mjs",
    "sand": "./bin/sand.mjs"
  },
  "scripts": {
    "build": "tsc -p .",
    "typecheck": "tsc -p . --noEmit",
    "test": "vitest run --exclude 'test/integration/**'",
    "test:vm": "RUN_VM_TESTS=1 vitest run test/integration",
    "cruise": "depcruise src --config .dependency-cruiser.cjs",
    "sandd": "tsx src/server/main.ts",
    "sand": "tsx src/cli/sand.ts"
  },
  "dependencies": {
    "@fastify/sse": "^3.0.0",
    "better-sqlite3": "^12.4.1",
    "commander": "^14.0.2",
    "fastify": "^5.6.1",
    "nanoid": "^5.1.6",
    "smol-toml": "^1.4.2",
    "zod": "^4.1.12"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^26.0.0",
    "@vitest/coverage-v8": "^3.2.7",
    "dependency-cruiser": "^17.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.7"
  }
}
```

Note: if `npm install` resolves newer majors of any package, pin to what installs — do NOT silently upgrade Node or vitest major lines (platform convention: vitest 3.x).

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vitest.config.ts with coverage gate**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 80, branches: 70, functions: 80, statements: 80 },
    },
  },
});
```

- [ ] **Step 4: Create .dependency-cruiser.cjs — the modularity guard**

```js
/** Enforces: server -> core -> ports <- adapters. See spec §3 Modularity rules. */
module.exports = {
  forbidden: [
    {
      name: 'core-cannot-import-adapters',
      comment: 'core depends ONLY on ports and its own module',
      from: { path: '^src/core/' },
      to: { path: '^src/(adapters|modes|promote|server|cli)/' },
    },
    {
      name: 'adapters-cannot-import-server',
      from: { path: '^src/(adapters|modes|promote)/' },
      to: { path: '^src/server/' },
    },
    {
      name: 'cli-is-a-pure-http-client',
      from: { path: '^src/cli/' },
      to: { path: '^src/(core|adapters|modes|promote|server)/' },
    },
    {
      name: 'only-composition-root-wires-everything',
      comment: 'only main.ts may import core AND adapters together',
      from: { path: '^src/server/', pathNot: '^src/server/main\\.ts$' },
      to: { path: '^src/(adapters|modes|promote)/' },
    },
  ],
};
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
profiles.user/
*.smolmachine
*.smolcheckpoint
.pisandboxed-local/
coverage/
```

- [ ] **Step 6: Create thin bin wrappers**

`bin/sandd.mjs`:
```js
#!/usr/bin/env node
import '../dist/server/main.js';
```

`bin/sand.mjs`:
```js
#!/usr/bin/env node
import '../dist/cli/sand.js';
```

`chmod +x bin/*.mjs`

- [ ] **Step 7: Placeholder ports file (Task 4 replaces it)**

`src/core/ports.ts`:
```ts
export const PORTS_DEFINED_IN_TASK_4 = true;
```

- [ ] **Step 8: Install + verify all gates pass on empty project**

Run: `npm install && npm run typecheck && npm test && npm run cruise`
Expected: install OK; typecheck OK; vitest reports "no test files found" is OK — add `--passWithNoTests` to the `test` script if vitest exits non-zero; depcruise reports "no violations".

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: scaffold pisandboxed package with vitest + dependency-cruiser gates"
```

---

### Task 2: Host prep — install smolvm, capture CLI reference

**Files:**
- Create: `docs/smolvm-cli-reference.md`

This is a host task (no repo code). The smolvm adapter (Task 8) is written against the captured reference, NOT against guessed flags.

- [ ] **Step 1: Install smolvm user-level**

```bash
curl -sSL https://smolmachines.com/install.sh | bash
```

- [ ] **Step 2: Verify binary + KVM**

```bash
smolvm --version
smolvm machine --help
test -w /dev/kvm && echo KVM_OK
```
Expected: version prints; help lists `machine` subcommands; KVM_OK.

- [ ] **Step 3: Capture exact flags into docs/smolvm-cli-reference.md**

Run and paste full output into the doc:
```bash
smolvm machine create --help
smolvm machine start --help
smolvm machine exec --help
smolvm machine stop --help
smolvm machine remove --help || smolvm machine rm --help
smolvm machine run --help
smolvm pack create --help
```

The doc MUST record, verbatim: the volume flag (`-v`/`--volume`?), egress allow flag (`--allow-host`?), ssh-agent flag (`--ssh-agent`?), memory flag (`--mem`?), cpu flag (`--cpus`?), image flag (`--image`?), net flag (`--net`?), branchable flag, and whether flags are repeatable.

- [ ] **Step 4: Smoke an ephemeral VM**

```bash
smolvm machine run --image alpine -- sh -c "uname -a"
```
Expected: prints Linux guest kernel line.

- [ ] **Step 5: Commit the reference**

```bash
git add docs/smolvm-cli-reference.md && git commit -m "docs: capture smolvm CLI reference from installed binary"
```

---

### Task 3: Event bus (`core/events.ts`)

**Files:**
- Create: `src/core/events.ts`
- Test: `test/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events.js';

describe('EventBus', () => {
  it('delivers typed events to subscribers', () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const got: number[] = [];
    bus.on('ping', (e) => got.push(e.n));
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(got).toEqual([1, 2]);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const got: number[] = [];
    const off = bus.on('ping', (e) => got.push(e.n));
    bus.emit('ping', { n: 1 });
    off();
    bus.emit('ping', { n: 2 });
    expect(got).toEqual([1]);
  });

  it('subscriber errors do not break other subscribers', () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const got: number[] = [];
    bus.on('ping', () => { throw new Error('boom'); });
    bus.on('ping', (e) => got.push(e.n));
    bus.emit('ping', { n: 7 });
    expect(got).toEqual([7]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `../src/core/events.js`.

- [ ] **Step 3: Implement**

`src/core/events.ts`:
```ts
export type EventHandler<E> = (event: E) => void;

export class EventBus<M extends Record<string, unknown>> {
  #handlers = new Map<keyof M, Set<EventHandler<never>>>();

  on<K extends keyof M>(key: K, handler: EventHandler<M[K]>): () => void {
    let set = this.#handlers.get(key);
    if (!set) { set = new Set(); this.#handlers.set(key, set); }
    set.add(handler as EventHandler<never>);
    return () => { set!.delete(handler as EventHandler<never>); };
  }

  emit<K extends keyof M>(key: K, event: M[K]): void {
    const set = this.#handlers.get(key);
    if (!set) return;
    for (const h of set) {
      try { (h as EventHandler<M[K]>)(event); }
      catch (err) { console.error(`[events] handler for "${String(key)}" threw:`, err); }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): typed event bus"
```

---

### Task 4: Ports (`core/ports.ts`) — the seams everything plugs into

**Files:**
- Modify: `src/core/ports.ts` (replace placeholder)
- Test: `test/ports.typecheck.test.ts`

No runtime behavior — this task locks the vocabulary. The test pins compile-time shape (guards against later silent renames breaking adapters).

- [ ] **Step 1: Write the types**

`src/core/ports.ts`:
```ts
import type { EventBus } from './events.js';

export type SandboxId = string;
export type SandboxMode = 'ephemeral' | 'pooled' | 'persistent';
export type SandboxState = 'creating' | 'running' | 'stopped' | 'error';

export interface MountSpec {
  host: string;
  guest: string;
  readWrite: boolean;
}

/** A profile after parsing/validation — what core is allowed to know. */
export interface ResolvedProfile {
  name: string;
  image: string;
  cpus: number;
  memoryMb: number;
  ttlMs: number;
  net: boolean;
  allowHosts: string[];
  mounts: MountSpec[];
  sshAgent: boolean;
}

export interface CreateSandboxInput {
  profile: string;
  mode: SandboxMode;
  /** fills the profile's {project} mount placeholder; required iff profile has one */
  project?: string;
  /** may only SHORTEN the profile ttl */
  ttlMs?: number;
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecInput {
  cmd: string[];
  env?: Record<string, string>;
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; data: string }) => void;
}

export interface SandboxInfo {
  id: SandboxId;
  profile: string;
  mode: SandboxMode;
  state: SandboxState;
  project: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface BootOptions {
  machineName: string;
  image: string;
  cpus: number;
  memoryMb: number;
  net: boolean;
  allowHosts: string[];
  mounts: MountSpec[];
  sshAgent: boolean;
}

/** Isolation seam. Phase 1 impl: adapters/smolvm (CLI). */
export interface IsolationBackend {
  boot(opts: BootOptions): Promise<BackendHandle>;
}

export interface BackendHandle {
  readonly machineName: string;
  exec(input: ExecInput): Promise<ExecOutput>;
  stop(): Promise<void>;
  remove(): Promise<void>;
}

/** Lifecycle seam. Phase 1 impl: modes/ephemeral. */
export interface ModeManager {
  readonly mode: SandboxMode;
  ids(): string[];
  create(input: CreateSandboxInput, profile: ResolvedProfile): Promise<SandboxInfo>;
  get(id: SandboxId): Promise<ManagedSandbox | undefined>;
  destroy(id: SandboxId, reason: string): Promise<void>;
  /** destroy every sandbox this mode owns (daemon shutdown) */
  destroyAll(reason: string): Promise<void>;
}

export interface ManagedSandbox {
  readonly id: SandboxId;
  readonly mode: SandboxMode;
  info(): SandboxInfo;
  exec(input: ExecInput): Promise<ExecOutput>;
  destroy(reason: string): Promise<void>;
}

/** Profile seam. Phase 1 impl: adapters/profiles (builtin TOML + profiles.user). */
export interface ProfileRegistry {
  get(name: string): Promise<ResolvedProfile | undefined>;
  list(): Promise<ResolvedProfile[]>;
}

export interface SandboxRow {
  id: SandboxId;
  profile: string;
  mode: SandboxMode;
  state: SandboxState;
  machineName: string;
  project: string | null;
  createdAt: string;
  expiresAt: string | null;
  stoppedAt: string | null;
}

/** Storage seams. Phase 1 impl: adapters/sqlite. */
export interface SandboxRepo {
  insert(row: SandboxRow): void;
  get(id: SandboxId): SandboxRow | undefined;
  listByState(state: SandboxState): SandboxRow[];
  listActive(): SandboxRow[];
  updateState(id: SandboxId, state: SandboxState, stoppedAt?: string): void;
}

export interface AuditEntry {
  ts: string;
  event: string;
  sandboxId: string | null;
  payload: Record<string, unknown>;
}

export interface AuditRepo {
  append(entry: AuditEntry): void;
  query(limit: number): AuditEntry[];
}

/** Promotion seam. Phase 1 impls: promote/ strategies. */
export interface PromoteContext {
  sandbox: ManagedSandbox;
  projectHostPath: string | null;
  params: Record<string, unknown>;
}

export interface PromoteResult {
  kind: string;
  detail: string;
}

export interface ArtifactExtractor {
  readonly kind: string;
  run(ctx: PromoteContext): Promise<PromoteResult>;
}

/** Canonical event names (consumed by audit sink now; metrics/webhooks later). */
export interface SandboxEventMap {
  'sandbox.created': { id: SandboxId; profile: string; mode: SandboxMode };
  'exec.completed': { id: SandboxId; cmd: string[]; exitCode: number; durationMs: number };
  'policy.denied': { reason: string; request: unknown };
  'promote.applied': { id: SandboxId; kind: string; detail: string };
  'sandbox.destroyed': { id: SandboxId; reason: string };
  'sandbox.reaped': { id: SandboxId; expiresAt: string };
}

export type SandboxBus = EventBus<SandboxEventMap>;
```

- [ ] **Step 2: Compile-pin test**

`test/ports.typecheck.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { IsolationBackend, ModeManager, ProfileRegistry, SandboxRepo, AuditRepo, ArtifactExtractor } from '../src/core/ports.js';

describe('ports vocabulary', () => {
  it('exposes the six seams', () => {
    const probe = {
      backend: null as IsolationBackend | null,
      mode: null as ModeManager | null,
      registry: null as ProfileRegistry | null,
      sandboxes: null as SandboxRepo | null,
      audit: null as AuditRepo | null,
      extractor: null as ArtifactExtractor | null,
    };
    expect(Object.values(probe).length).toBe(6);
  });
});
```

- [ ] **Step 3: Run gates**

Run: `npm run typecheck && npm test`
Expected: typecheck PASS, test PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(core): six ports + sandbox event map (spec §3 modularity rules)"
```

---

### Task 5: SQLite adapter — repos + audit event sink

**Files:**
- Create: `src/adapters/sqlite/store.ts`
- Test: `test/sqlite-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/adapters/sqlite/store.ts`:
```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry, AuditRepo, SandboxRepo, SandboxRow, SandboxState } from '../../core/ports.js';

export interface Store { sandboxes: SandboxRepo; audit: AuditRepo; close(): void; }

export function openStore(dbPath: string): Store {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sandboxes (
      id TEXT PRIMARY KEY, profile TEXT NOT NULL, mode TEXT NOT NULL,
      state TEXT NOT NULL, machine_name TEXT NOT NULL, project TEXT,
      created_at TEXT NOT NULL, expires_at TEXT, stopped_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL,
      sandbox_id TEXT, payload TEXT NOT NULL
    );
  `);

  const sandboxes: SandboxRepo = {
    insert(row: SandboxRow): void {
      db.prepare(`INSERT INTO sandboxes
        (id, profile, mode, state, machine_name, project, created_at, expires_at, stopped_at)
        VALUES (@id, @profile, @mode, @state, @machineName, @project, @createdAt, @expiresAt, @stoppedAt)`).run(row);
    },
    get(id: string): SandboxRow | undefined {
      const r = db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(id) as RawRow | undefined;
      return r ? toRow(r) : undefined;
    },
    listByState(state: SandboxState): SandboxRow[] {
      return (db.prepare('SELECT * FROM sandboxes WHERE state = ? ORDER BY created_at').all(state) as RawRow[]).map(toRow);
    },
    listActive(): SandboxRow[] {
      return (db.prepare("SELECT * FROM sandboxes WHERE state IN ('running','creating') ORDER BY created_at").all() as RawRow[]).map(toRow);
    },
    updateState(id: string, state: SandboxState, stoppedAt?: string): void {
      db.prepare('UPDATE sandboxes SET state = ?, stopped_at = COALESCE(?, stopped_at) WHERE id = ?').run(state, stoppedAt ?? null, id);
    },
  };

  const audit: AuditRepo = {
    append(e: AuditEntry): void {
      db.prepare('INSERT INTO audit (ts, event, sandbox_id, payload) VALUES (?, ?, ?, ?)')
        .run(e.ts, e.event, e.sandboxId, JSON.stringify(e.payload));
    },
    query(limit: number): AuditEntry[] {
      return (db.prepare('SELECT ts, event, sandbox_id, payload FROM audit ORDER BY id DESC LIMIT ?').all(limit) as RawAudit[])
        .map((r) => ({ ts: r.ts, event: r.event, sandboxId: r.sandbox_id, payload: JSON.parse(r.payload) as Record<string, unknown> }));
    },
  };

  return { sandboxes, audit, close: () => db.close() };
}

interface RawRow { id: string; profile: string; mode: SandboxRow['mode']; state: SandboxRow['state']; machine_name: string; project: string | null; created_at: string; expires_at: string | null; stopped_at: string | null; }
function toRow(r: RawRow): SandboxRow {
  return { id: r.id, profile: r.profile, mode: r.mode, state: r.state, machineName: r.machine_name, project: r.project, createdAt: r.created_at, expiresAt: r.expires_at, stoppedAt: r.stopped_at };
}
interface RawAudit { ts: string; event: string; sandbox_id: string | null; payload: string; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(adapters/sqlite): sandbox repo + audit repo (WAL)"
```

---

### Task 6: Profile registry adapter (TOML + zod)

**Files:**
- Create: `src/adapters/profiles/registry.ts`
- Test: `test/profiles-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileRegistryImpl } from '../src/adapters/profiles/registry.js';

const VALID = `
image = "node:26-alpine"
cpus = 2
memory = 2048
ttl = "10m"
net = false

[network]
allow_hosts = []

[[mounts]]
host = "/home/me/Documents/{project}"
guest = "/workspace"
mode = "rw"

[secrets]
ssh_agent = false
`;

describe('ProfileRegistry', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } });

  function setup(builtin: Record<string, string>, user: Record<string, string> = {}) {
    dir = mkdtemp();
    const b = join(dir, 'builtin'); const u = join(dir, 'user');
    mkdirSync(b); mkdirSync(u);
    for (const [name, content] of Object.entries(builtin)) writeFileSync(join(b, `${name}.toml`), content);
    for (const [name, content] of Object.entries(user)) writeFileSync(join(u, `${name}.toml`), content);
    return new ProfileRegistryImpl([b, u]);
  }

  it('parses a valid profile with mounts', async () => {
    const reg = setup({ dev: VALID });
    const p = await reg.get('dev');
    expect(p?.image).toBe('node:26-alpine');
    expect(p?.ttlMs).toBe(10 * 60_000);
    expect(p?.mounts[0]).toEqual({ host: '/home/me/Documents/{project}', guest: '/workspace', readWrite: true });
  });

  it('rejects invalid toml (bad field)', async () => {
    const reg = setup({ bad: 'cpus = "four"' });
    await expect(reg.get('bad')).rejects.toThrow(/cpus/);
  });

  it('user profile cannot shadow a builtin — fails loudly at construction', () => {
    expect(() => setup({ dev: VALID }, { dev: VALID })).toThrow(/shadow/);
  });

  it('lists all profiles from all sources', async () => {
    const reg = setup({ dev: VALID, untrusted: VALID }, { extra: VALID });
    await expect(reg.list()).resolves.toHaveLength(3);
  });

  it('unknown profile returns undefined', async () => {
    const reg = setup({});
    await expect(reg.get('nope')).resolves.toBeUndefined();
  });
});

function mkdtemp(): string {
  const dir = join(tmpdir(), `pisand-profiles-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/adapters/profiles/registry.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import type { MountSpec, ProfileRegistry, ResolvedProfile } from '../../core/ports.js';

const profileSchema = z.object({
  image: z.string().min(1),
  cpus: z.number().int().min(1).max(16),
  memory: z.number().int().min(256),          // MiB
  ttl: z.string().regex(/^\d+[smh]$/),
  net: z.boolean().default(false),
  workdir: z.string().optional(),
  network: z.object({ allow_hosts: z.array(z.string()).default([]) }).default({ allow_hosts: [] }),
  mounts: z.array(z.object({
    host: z.string().startsWith('/'),
    guest: z.string().startsWith('/'),
    mode: z.enum(['ro', 'rw']),
  })).default([]),
  secrets: z.object({ ssh_agent: z.boolean().default(false) }).default({ ssh_agent: false }),
});

type RawProfile = z.infer<typeof profileSchema>;

function ttlToMs(ttl: string): number {
  const n = Number(ttl.slice(0, -1));
  const unit = ttl.slice(-1);
  const mult = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  return n * mult;
}

function toResolved(name: string, raw: RawProfile): ResolvedProfile {
  return {
    name,
    image: raw.image,
    cpus: raw.cpus,
    memoryMb: raw.memory,
    ttlMs: ttlToMs(raw.ttl),
    net: raw.net,
    allowHosts: raw.network.allow_hosts,
    mounts: raw.mounts.map((m): MountSpec => ({ host: m.host, guest: m.guest, readWrite: m.mode === 'rw' })),
    sshAgent: raw.secrets.ssh_agent,
  };
}

export class ProfileRegistryImpl implements ProfileRegistry {
  #profiles = new Map<string, ResolvedProfile>();

  /** dirs are ordered: builtins first (immutable), user dirs after (may not shadow). */
  constructor(dirs: readonly string[]) {
    dirs.forEach((dir, i) => this.#loadDir(dir, i === 0));
  }

  #loadDir(dir: string, isBuiltin: boolean): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const file of entries) {
      if (!file.endsWith('.toml')) continue;
      const name = file.replace(/\.toml$/, '');
      let raw: RawProfile;
      try {
        raw = profileSchema.parse(parse(readFileSync(join(dir, file), 'utf8')));
      } catch (err) {
        throw new Error(`profile "${name}" (${isBuiltin ? 'builtin' : 'user'}) is invalid: ${(err as Error).message}`);
      }
      if (!isBuiltin && this.#profiles.has(name)) {
        throw new Error(`user profile "${name}" may not shadow a builtin`);
      }
      this.#profiles.set(name, toResolved(name, raw));
    }
  }

  async get(name: string): Promise<ResolvedProfile | undefined> { return this.#profiles.get(name); }
  async list(): Promise<ResolvedProfile[]> { return [...this.#profiles.values()]; }
}
```

Note: if the zod version installed rejects `.default()` chaining on object schemas (zod 4 changed some ergonomics), adapt the schema minimally and record the deviation in the task report — validation behavior must stay identical.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(adapters/profiles): TOML profile registry with builtin priority (spec §5)"
```

---

### Task 7: Builtin profiles (`profiles/*.toml`) matching the spec table

**Files:**
- Create: `profiles/untrusted.toml`, `profiles/dev.toml`, `profiles/build.toml`
- Test: `test/builtin-profiles.test.ts`

- [ ] **Step 1: Write the profiles**

`profiles/untrusted.toml`:
```toml
image = "alpine:3.20"
cpus = 2
memory = 2048
ttl = "10m"
net = false

[network]
allow_hosts = []

[[mounts]]
host = "/home/genegulanesjr/Documents/{project}"
guest = "/workspace"
mode = "ro"

[secrets]
ssh_agent = false
```

`profiles/dev.toml`:
```toml
image = "node26-dev"
cpus = 4
memory = 8192
ttl = "30m"
net = true

[network]
allow_hosts = ["registry.npmjs.org", "github.com"]

[[mounts]]
host = "/home/genegulanesjr/Documents/{project}"
guest = "/workspace"
mode = "rw"

[secrets]
ssh_agent = false
```

`profiles/build.toml`:
```toml
image = "node26-dev"
cpus = 4
memory = 8192
ttl = "1h"
net = true

[network]
allow_hosts = ["github.com", "registry.npmjs.org"]

[[mounts]]
host = "/home/genegulanesjr/Documents/{project}"
guest = "/workspace"
mode = "rw"

[secrets]
ssh_agent = true
```

- [ ] **Step 2: Write the failing test (spec §5 table as executable assertions)**

`test/builtin-profiles.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProfileRegistryImpl } from '../src/adapters/profiles/registry.js';
import { resolve } from 'node:path';

const reg = new ProfileRegistryImpl([resolve('profiles')]);

describe('builtin profiles (spec §5)', () => {
  it('untrusted: no net, RO mount, no secrets, 2cpu/2GB, 10m', async () => {
    const p = await reg.get('untrusted');
    expect(p).toMatchObject({ net: false, allowHosts: [], sshAgent: false, cpus: 2, memoryMb: 2048, ttlMs: 600_000 });
    expect(p?.mounts[0]?.readWrite).toBe(false);
  });

  it('dev: allowlisted net, rw mount, no secrets, 4cpu/8GB, 30m', async () => {
    const p = await reg.get('dev');
    expect(p).toMatchObject({ net: true, sshAgent: false, cpus: 4, memoryMb: 8192, ttlMs: 1_800_000 });
    expect(p?.allowHosts).toEqual(expect.arrayContaining(['registry.npmjs.org', 'github.com']));
    expect(p?.mounts[0]?.readWrite).toBe(true);
  });

  it('build: ssh agent, narrow net, rw mount, 1h', async () => {
    const p = await reg.get('build');
    expect(p).toMatchObject({ net: true, sshAgent: true, ttlMs: 3_600_000 });
    expect(p?.allowHosts).not.toContain('*');
  });

  it('all builtins carry exactly one {project} mount at /workspace', async () => {
    for (const p of await reg.list()) {
      const ws = p.mounts.filter((m) => m.guest === '/workspace');
      expect(ws, p.name).toHaveLength(1);
      expect(ws[0]!.host).toContain('{project}');
    }
  });
});
```

- [ ] **Step 3: Run test to verify it passes** (registry already exists — this task validates data, not new code)

Run: `npm test`
Expected: PASS (4 tests). If a profile fails parsing, fix the TOML, not the test.

- [ ] **Step 4: Commit**

```bash
git add profiles/ test/builtin-profiles.test.ts && git commit -m "feat(profiles): untrusted/dev/build builtins pinned by tests (spec §5)"
```

---

### Task 8: smolvm isolation backend (unit-tested against a stub binary)

**Files:**
- Create: `src/adapters/smolvm/backend.ts`
- Test: `test/smolvm-backend.test.ts`
- Test helper: `test/helpers/stub-smolvm.sh`

The stub keeps unit tests KVM-free. Real-CLI behavior is verified in Task 15's integration test. **Cross-check every flag against `docs/smolvm-cli-reference.md` from Task 2 and adjust `#args` mappings if the real flags differ — the interface stays fixed, only the flag map may change.**

- [ ] **Step 1: Create the stub binary**

`test/helpers/stub-smolvm.sh`:
```bash
#!/usr/bin/env bash
# Records invocations to $SMOLVM_STUB_LOG, emulates enough of the CLI for tests.
LOG="${SMOLVM_STUB_LOG:?}" && echo "$@" >> "$LOG"
cmd="${1:-}" sub="${2:-}" ; shift 2 2>/dev/null || shift $# 2>/dev/null
case "$cmd/$sub" in
  machine/create|machine/start) exit 0 ;;
  machine/exec) echo "stub-stdout"; echo "stub-stderr" >&2; exit 0 ;;
  machine/stop|machine/remove|machine/rm) exit 0 ;;
  *) exit 0 ;;
esac
```

- [ ] **Step 2: Write the failing test**

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SmolvmBackend } from '../src/adapters/smolvm/backend.js';

let dir: string;
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stubBackend() {
  dir = mkdtempSync(join(tmpdir(), 'pisand-smolvm-'));
  const bin = join(dir, 'smolvm');
  const src = new URL('./helpers/stub-smolvm.sh', import.meta.url);
  const real = readFileSync(src, 'utf8');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(bin, real);
  chmodSync(bin, 0o755);
  const log = join(dir, 'invocations.log');
  return { backend: new SmolvmBackend({ binPath: bin, logPath: log }), log };
}

describe('SmolvmBackend', () => {
  it('boot → exec → stop → remove issues the right CLI sequence', async () => {
    const { backend, log } = stubBackend();
    const h = await backend.boot({
      machineName: 'sb_x1', image: 'alpine', cpus: 2, memoryMb: 2048,
      net: false, allowHosts: [], sshAgent: false,
      mounts: [{ host: '/tmp/h', guest: '/workspace', readWrite: false }],
    });
    await h.exec({ cmd: ['uname', '-a'] });
    await h.stop();
    await h.remove();
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.some((c) => c.includes('machine') && c.includes('create') && c.includes('sb_x1'))).toBe(true);
    expect(calls.some((c) => c.includes('exec') && c.includes('uname'))).toBe(true);
    expect(calls.some((c) => c.includes('stop'))).toBe(true);
    expect(calls.some((c) => c.includes('remove') || c.includes('rm'))).toBe(true);
  });

  it('net-off boot never passes a network flag; net-on passes --net and allow-hosts', async () => {
    const { backend, log } = stubBackend();
    await backend.boot({ machineName: 'sb_n', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] });
    await backend.boot({ machineName: 'sb_y', image: 'alpine', cpus: 1, memoryMb: 512, net: true, allowHosts: ['pypi.org'], sshAgent: false, mounts: [] });
    const calls = readFileSync(log, 'utf8');
    const [off, on] = calls.trim().split('\n');
    expect(off).not.toMatch(/--net/);
    expect(on).toMatch(/--net/);
    expect(on).toMatch(/pypi\.org/);
  });

  it('exec surfaces exit code, stdout, stderr', async () => {
    const { backend } = stubBackend();
    const h = await backend.boot({ machineName: 'sb_e', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] });
    const out = await h.exec({ cmd: ['false'] });
    expect(out.stdout).toContain('stub-stdout');
    expect(out.stderr).toContain('stub-stderr');
  });

  it('boot failure (missing binary) throws BackendError', async () => {
    const backend = new SmolvmBackend({ binPath: '/nonexistent/smolvm', logPath: join(tmpdir(), 'nope.log') });
    await expect(backend.boot({ machineName: 'sb_z', image: 'alpine', cpus: 1, memoryMb: 512, net: false, allowHosts: [], sshAgent: false, mounts: [] }))
      .rejects.toThrow(/smolvm/);
  });
});
```

Note: the first helper uses top-level `await` inside a non-async function — fix by making `stubBackend` async and awaiting it in tests. Final code must typecheck under strict mode; adjust mechanically.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/adapters/smolvm/backend.ts`:
```ts
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import type { BackendHandle, BootOptions, ExecInput, ExecOutput, IsolationBackend } from '../../core/ports.js';

export class BackendError extends Error {}

export interface SmolvmBackendOptions {
  binPath: string;      // default: env SMOLVM_BIN || '~/.local/bin/smolvm'
  logPath?: string;     // when set, every invocation line is appended (debugging/tests)
}

export class SmolvmBackend implements IsolationBackend {
  #opts: Required<SmolvmBackendOptions>;
  constructor(opts: SmolvmBackendOptions) {
    this.#opts = {
      binPath: opts.binPath,
      logPath: opts.logPath ?? '',
    };
  }

  async boot(opts: BootOptions): Promise<BackendHandle> {
    const args = [
      'machine', 'create',
      '--name', opts.machineName,
      '--image', opts.image,
      '--cpus', String(opts.cpus),
      '--mem', String(opts.memoryMb),
    ];
    if (opts.net) {
      args.push('--net');
      for (const host of opts.allowHosts) args.push('--allow-host', host);
    }
    for (const m of opts.mounts) {
      args.push('--volume', `${m.host}:${m.guest}${m.readWrite ? '' : ':ro'}`);
    }
    if (opts.sshAgent) args.push('--ssh-agent');
    // workloads park via a long-lived init so exec sessions attach to a running machine
    args.push('--', '/bin/sh', '-c', 'exec sleep infinity');

    await this.#run(args, { timeoutMs: 30_000 });
    await this.#run(['machine', 'start', '--name', opts.machineName], { timeoutMs: 30_000 });

    return {
      machineName: opts.machineName,
      exec: (input: ExecInput) => this.#exec(opts.machineName, input),
      stop: async () => { await this.#run(['machine', 'stop', '--name', opts.machineName], { timeoutMs: 30_000 }); },
      remove: async () => { await this.#run(['machine', 'remove', '--name', opts.machineName], { timeoutMs: 30_000 }); },
    };
  }

  async #exec(machine: string, input: ExecInput): Promise<ExecOutput> {
    const started = Date.now();
    const res = await this.#run(['machine', 'exec', '--name', machine, '--', ...input.cmd], {
      timeoutMs: 600_000,
      env: input.env,
      onOutput: input.onOutput,
    });
    void started;
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  }

  #run(
    args: string[],
    opts: { timeoutMs: number; env?: Record<string, string>; onOutput?: (c: { stream: 'stdout' | 'stderr'; data: string }) => void },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.#log(args);
    return new Promise((resolve, reject) => {
      const child = spawn(this.#opts.binPath, args, {
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
          // exec exit codes belong to the workload — resolve, don't throw
          resolve({ exitCode: code ?? -1, stdout, stderr });
          return;
        }
        if (code !== 0) { reject(new BackendError(`smolvm failed (${code}): ${args.join(' ')}\n${stderr}`)); return; }
        resolve({ exitCode: 0, stdout, stderr });
      });
    });
  }

  #log(args: string[]): void {
    if (this.#opts.logPath) appendFileSync(this.#opts.logPath, args.join(' ') + '\n');
  }
}
```

**IMPORTANT — flag verification gate:** before marking this task complete, run `smolvm machine create --help` and confirm `--name --image --cpus --mem --net --allow-host --volume --ssh-agent --` exist as used. Where the real CLI differs (e.g., `--memory` vs `--mem`, `rm` vs `remove`), fix ONLY the flag strings in this file and the stub expectations, and note the correction in `docs/smolvm-cli-reference.md`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests). Then `npm run typecheck` PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(adapters/smolvm): IsolationBackend over CLI with invocation log + stub-tested unit suite"
```

---

### Task 9: Ephemeral mode manager

**Files:**
- Create: `src/modes/ephemeral.ts`
- Test: `test/mode-ephemeral.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { EphemeralMode } from '../src/modes/ephemeral.js';
import type { BackendHandle, BootOptions, CreateSandboxInput, ExecOutput, IsolationBackend, ResolvedProfile, SandboxRepo } from '../src/core/ports.js';

const PROFILE: ResolvedProfile = {
  name: 'dev', image: 'node26-dev', cpus: 2, memoryMb: 2048, ttlMs: 600_000,
  net: false, allowHosts: [], sshAgent: false,
  mounts: [{ host: '/h/{project}', guest: '/workspace', readWrite: true }],
};

function fakeBackend() {
  const booted: BootOptions[] = [];
  const removed: string[] = [];
  const backend: IsolationBackend = {
    async boot(opts) {
      booted.push(opts);
      const handle: BackendHandle = {
        machineName: opts.machineName,
        exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
        stop: async () => {},
        remove: async () => { removed.push(opts.machineName); },
      };
      return handle;
    },
  };
  return { backend, booted, removed };
}

function fakeRepo(): SandboxRepo & { rows: Map<string, { id: string; state: string }> } {
  const rows = new Map<string, { id: string; state: string }>();
  return {
    rows,
    insert() { /* covered by service tests */ },
    get(id) { const r = rows.get(id); return r ? ({ ...r, profile: 'dev', mode: 'ephemeral', machineName: id, project: null, createdAt: '', expiresAt: null, stoppedAt: null } as never) : undefined; },
    listByState: () => [], listActive: () => [], updateState() {},
  };
}

describe('EphemeralMode', () => {
  it('create boots a VM named after the sandbox id and returns running info', async () => {
    const { backend, booted } = fakeBackend();
    const mode = new EphemeralMode(backend, fakeRepo());
    const input: CreateSandboxInput = { profile: 'dev', mode: 'ephemeral', project: '/tmp/proj' };
    const info = await mode.create(input, PROFILE);
    expect(info.state).toBe('running');
    expect(booted).toHaveLength(1);
    expect(booted[0]!.machineName).toBe(info.id);
    expect(booted[0]!.mounts[0]!.host).toBe('/h//tmp/proj'); // placeholder expanded by caller
  });

  it('destroy stops, removes, and flips repo state', async () => {
    const { backend, removed } = fakeBackend();
    const repo = fakeRepo();
    const mode = new EphemeralMode(backend, repo);
    const info = await mode.create({ profile: 'dev', mode: 'ephemeral', project: '/p' }, PROFILE);
    await mode.destroy(info.id, 'test');
    expect(removed).toEqual([info.id]);
  });

  it('get returns a ManagedSandbox that execs through the backend handle', async () => {
    const { backend } = fakeBackend();
    const mode = new EphemeralMode(backend, fakeRepo());
    const info = await mode.create({ profile: 'dev', mode: 'ephemeral', project: '/p' }, PROFILE);
    const sb = await mode.get(info.id);
    expect(sb).toBeDefined();
    const out: ExecOutput = await sb!.exec({ cmd: ['echo', 'hi'] });
    expect(out.stdout).toBe('ok');
    await expect(mode.get('sb_missing')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/modes/ephemeral.ts`:
```ts
import { customAlphabet } from 'nanoid';
import type {
  BackendHandle, CreateSandboxInput, ExecInput, ExecOutput, IsolationBackend,
  ManagedSandbox, ModeManager, ResolvedProfile, SandboxId, SandboxInfo, SandboxRepo,
} from '../core/ports.js';

const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

interface Entry { handle: BackendHandle; info: SandboxInfo; }

export class EphemeralMode implements ModeManager {
  readonly mode = 'ephemeral' as const;
  #live = new Map<SandboxId, Entry>();

  constructor(
    private readonly backend: IsolationBackend,
    private readonly repo: SandboxRepo,
  ) {}

  async create(input: CreateSandboxInput, profile: ResolvedProfile): Promise<SandboxInfo> {
    const id = `sb_${newId()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + profile.ttlMs).toISOString();
    this.repo.insert({
      id, profile: profile.name, mode: this.mode, state: 'creating', machineName: id,
      project: input.project ?? null, createdAt: now.toISOString(), expiresAt, stoppedAt: null,
    });
    const handle = await this.backend.boot({
      machineName: id,
      image: profile.image,
      cpus: profile.cpus,
      memoryMb: profile.memoryMb,
      net: profile.net,
      allowHosts: profile.allowHosts,
      mounts: profile.mounts,
      sshAgent: profile.sshAgent,
    });
    const info: SandboxInfo = {
      id, profile: profile.name, mode: this.mode, state: 'running',
      project: input.project ?? null, createdAt: now.toISOString(), expiresAt,
    };
    this.#live.set(id, { handle, info });
    this.repo.updateState(id, 'running');
    return info;
  }

  async get(id: SandboxId): Promise<ManagedSandbox | undefined> {
    const entry = this.#live.get(id);
    if (!entry) return undefined;
    const self = this;
    return {
      id,
      mode: this.mode,
      info: () => ({ ...entry.info }),
      exec: (input: ExecInput): Promise<ExecOutput> => entry.handle.exec(input),
      destroy: (reason: string) => self.destroy(id, reason),
    };
  }

  ids(): string[] { return [...this.#live.keys()]; }

  async destroy(id: SandboxId, reason: string): Promise<void> {
    const entry = this.#live.get(id);
    if (!entry) return;
    this.#live.delete(id);
    try { await entry.handle.stop(); } catch { /* already stopped */ }
    try { await entry.handle.remove(); } catch { /* best effort */ }
    this.repo.updateState(id, 'stopped', new Date().toISOString());
    void reason; // caller (service) owns event emission
  }

  async destroyAll(reason: string): Promise<void> {
    for (const id of [...this.#live.keys()]) await this.destroy(id, reason);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(modes): ephemeral ModeManager (boot/exec/destroy over backend)"
```

---

### Task 10: Sandbox service — policy gate, events, reaper

**Files:**
- Create: `src/core/sandbox-service.ts`
- Test: `test/sandbox-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { SandboxService } from '../src/core/sandbox-service.js';
import type { CreateSandboxInput, ModeManager, ProfileRegistry, ResolvedProfile, SandboxBus, SandboxInfo } from '../src/core/ports.js';
import { EventBus } from '../src/core/events.js';

const PROFILE: ResolvedProfile = {
  name: 'dev', image: 'img', cpus: 2, memoryMb: 2048, ttlMs: 600_000, net: false,
  allowHosts: [], sshAgent: false,
  mounts: [{ host: '/h/{project}', guest: '/workspace', readWrite: true }],
};

function fakeMode(info?: Partial<SandboxInfo>): ModeManager & { created: CreateSandboxInput[]; destroyed: string[]; live: string[] } {
  const created: CreateSandboxInput[] = [];
  const destroyed: string[] = [];
  const live: string[] = [];
  return {
    mode: 'ephemeral',
    created, destroyed, live,
    ids: () => live.filter((id) => !destroyed.includes(id)),
    async create(input: CreateSandboxInput): Promise<SandboxInfo> {
      created.push(input);
      const sb: SandboxInfo = {
        id: 'sb_1', profile: input.profile, mode: 'ephemeral', state: 'running',
        project: input.project ?? null, createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), ...info,
      };
      live.push(sb.id);
      return sb;
    },
    async get() { return undefined; },
    async destroy(id: string) { destroyed.push(id); },
    async destroyAll() {},
  };
}

function setup(profile: ResolvedProfile = PROFILE) {
  const registry: ProfileRegistry = { get: async (n) => (n === profile.name ? profile : undefined), list: async () => [profile] };
  const mode = fakeMode();
  const modes = new Map([['ephemeral', mode]]);
  const bus: SandboxBus = new EventBus();
  const svc = new SandboxService({ registry, modes, bus, now: () => new Date('2026-09-22T00:00:00Z') });
  return { svc, mode, bus, registry };
}

describe('SandboxService.create — policy gate', () => {
  it('expands {project} placeholder and delegates to mode', async () => {
    const { svc, mode } = setup();
    const info = await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/tmp/p' });
    expect(info.id).toBe('sb_1');
    expect(mode.created[0]!.project).toBe('/tmp/p');
    const resolved = (svc as never as { lastResolved: ResolvedProfile }).lastResolved;
    expect(resolved.mounts[0]!.host).toBe('/h//tmp/p');
  });

  it('denies unknown profile and emits policy.denied', async () => {
    const { svc, bus } = setup();
    const denied: unknown[] = [];
    bus.on('policy.denied', (e) => denied.push(e.request));
    await expect(svc.create({ profile: 'ghost', mode: 'ephemeral' })).rejects.toThrow(/unknown profile/i);
    expect(denied).toHaveLength(1);
  });

  it('denies when {project} placeholder present but no project given', async () => {
    const { svc } = setup();
    await expect(svc.create({ profile: 'dev', mode: 'ephemeral' })).rejects.toThrow(/project/i);
  });

  it('denies ttl that exceeds the profile ttl', async () => {
    const { svc } = setup();
    await expect(svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p', ttlMs: 999_999_999 }))
      .rejects.toThrow(/ttl/i);
  });

  it('denies unregistered mode', async () => {
    const { svc } = setup();
    await expect(svc.create({ profile: 'dev', mode: 'persistent' })).rejects.toThrow(/mode/i);
  });

  it('allows ttl shorter than profile ttl', async () => {
    const { svc, mode } = setup();
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p', ttlMs: 1_000 });
    expect(mode.created).toHaveLength(1);
  });
});

describe('SandboxService — events & reaper', () => {
  it('emits sandbox.created and exec.completed', async () => {
    const { svc, bus } = setup();
    const events: string[] = [];
    bus.on('sandbox.created', () => events.push('created'));
    bus.on('exec.completed', () => events.push('exec'));
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p' });
    // exec path covered through service in Task 12 HTTP tests; here assert via mode handle:
    expect(events).toEqual(['created']);
  });

  it('reaper destroys expired sandboxes and emits sandbox.reaped', async () => {
    const { svc, mode, bus } = setup();
    const reaped: string[] = [];
    bus.on('sandbox.reaped', (e) => reaped.push(e.id));
    await svc.create({ profile: 'dev', mode: 'ephemeral', project: '/p' });
    // force the fake mode to report sb_1 as live-with-expired-expiry via get()
    const expired: ManagedSandbox = {
      id: 'sb_1', mode: 'ephemeral',
      info: () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: '', expiresAt: '2026-09-21T23:00:00Z' }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      destroy: async () => {},
    };
    (mode as unknown as { get: (id: string) => Promise<unknown> }).get = async () => expired;
    await svc.reapOnce();
    expect(mode.destroyed).toEqual(['sb_1']);
    expect(reaped).toEqual(['sb_1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/core/sandbox-service.ts`:
```ts
import type {
  CreateSandboxInput, ExecInput, ExecOutput, ManagedSandbox, ModeManager,
  ProfileRegistry, PromoteResult, ResolvedProfile, SandboxBus, SandboxId,
  SandboxInfo, ArtifactExtractor,
} from './ports.js';

export interface SandboxServiceOptions {
  registry: ProfileRegistry;
  modes: Map<string, ModeManager>;
  bus: SandboxBus;
  /** injectable clock for tests */
  now?: () => Date;
  /** injectable id generator for tests */
  resolveProject?: (p: string) => string;
}

export class PolicyError extends Error {}

export class SandboxService {
  #registry: ProfileRegistry;
  #modes: Map<string, ModeManager>;
  #bus: SandboxBus;
  #now: () => Date;
  #resolveProject: (p: string) => string;
  #reaper: NodeJS.Timeout | undefined;
  lastResolved: ResolvedProfile | undefined;

  constructor(opts: SandboxServiceOptions) {
    this.#registry = opts.registry;
    this.#modes = opts.modes;
    this.#bus = opts.bus;
    this.#now = opts.now ?? (() => new Date());
    this.#resolveProject = opts.resolveProject ?? ((p) => p);
  }

  async create(input: CreateSandboxInput): Promise<SandboxInfo> {
    const profile = await this.#registry.get(input.profile);
    if (!profile) return this.#deny(`unknown profile "${input.profile}"`, input);
    const mode = this.#modes.get(input.mode);
    if (!mode) return this.#deny(`unsupported mode "${input.mode}" (registered: ${[...this.#modes.keys()].join(', ')})`, input);
    if (input.ttlMs !== undefined && input.ttlMs > profile.ttlMs) {
      return this.#deny(`ttl ${input.ttlMs}ms exceeds profile "${profile.name}" ttl ${profile.ttlMs}ms`, input);
    }
    const needsProject = profile.mounts.some((m) => m.host.includes('{project}'));
    if (needsProject && !input.project) return this.#deny(`profile "${profile.name}" mounts {project} — "project" is required`, input);

    const resolved: ResolvedProfile = needsProject
      ? { ...profile, mounts: profile.mounts.map((m) => ({ ...m, host: m.host.replace('{project}', this.#resolveProject(input.project!)) })) }
      : profile;
    this.lastResolved = resolved;

    const info = await mode.create(input, resolved);
    this.#bus.emit('sandbox.created', { id: info.id, profile: info.profile, mode: info.mode });
    return info;
  }

  async #managed(id: SandboxId): Promise<{ sb: ManagedSandbox; mode: ModeManager }> {
    const rows = await Promise.all([...this.#modes.values()].map(async (m) => ({ m, sb: await m.get(id) })));
    const hit = rows.find((r) => r.sb !== undefined);
    if (!hit?.sb) throw new PolicyError(`sandbox "${id}" not found or not running`);
    return { sb: hit.sb, mode: hit.m };
  }

  async get(id: SandboxId): Promise<SandboxInfo> {
    const { sb } = await this.#managed(id);
    return sb.info();
  }

  async exec(id: SandboxId, input: ExecInput): Promise<ExecOutput> {
    const { sb } = await this.#managed(id);
    const started = Date.now();
    const out = await sb.exec(input);
    this.#bus.emit('exec.completed', { id, cmd: input.cmd, exitCode: out.exitCode, durationMs: Date.now() - started });
    return out;
  }

  async destroy(id: SandboxId, reason = 'requested'): Promise<void> {
    const { mode } = await this.#managed(id).catch(() => ({ mode: undefined }));
    if (!mode) return;
    await mode.destroy(id, reason);
    this.#bus.emit('sandbox.destroyed', { id, reason });
  }

  async promote(id: SandboxId, kind: string, params: Record<string, unknown>, extractors: ArtifactExtractor[]): Promise<PromoteResult> {
    const { sb } = await this.#managed(id);
    const extractor = extractors.find((e) => e.kind === kind);
    if (!extractor) throw new PolicyError(`unknown promote kind "${kind}" (known: ${extractors.map((e) => e.kind).join(', ')})`);
    const info = sb.info();
    const result = await extractor.run({ sandbox: sb, projectHostPath: info.project, params });
    this.#bus.emit('promote.applied', { id, kind: result.kind, detail: result.detail });
    return result;
  }

  startReaper(intervalMs = 60_000): void {
    this.#reaper = setInterval(() => { void this.reapOnce(); }, intervalMs);
    this.#reaper.unref();
  }

  stopReaper(): void { if (this.#reaper) clearInterval(this.#reaper); }

  async reapOnce(): Promise<void> {
    const now = this.#now().getTime();
    for (const mode of this.#modes.values()) {
      for (const id of mode.ids()) {
        const sb = await mode.get(id).catch(() => undefined);
        if (!sb) continue;
        const exp = sb.info().expiresAt;
        if (exp && new Date(exp).getTime() <= nowMs) {
          await mode.destroy(id, 'ttl expired');
          this.#bus.emit('sandbox.reaped', { id, expiresAt: exp });
        }
      }
    }
  }

  #deny(reason: string, request: unknown): never {
    this.#bus.emit('policy.denied', { reason, request });
    throw new PolicyError(reason);
  }

  async destroyAll(reason = 'daemon shutdown'): Promise<void> {
    for (const mode of this.#modes.values()) await mode.destroyAll(reason);
  }
}
```

**Design correction while implementing (do this):** `ModeManager` already carries
`ids(): string[]` (Task 4) and `EphemeralMode` implements it from its live map —
the reaper iterates `mode.ids()` directly. No internal reaching.

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites, including Task 9's.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): SandboxService with policy gate, event emission, TTL reaper"
```

---

### Task 11: Promote strategies (diff + artifacts)

**Files:**
- Create: `src/promote/diff.ts`, `src/promote/artifacts.ts`
- Test: `test/promote.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    // stub exec returns a real tar stream on stdout
    const sb = fakeSandbox(async (cmd) => {
      if (!cmd.join(' ').includes('tar -cf')) return { exitCode: 1, stdout: '', stderr: '' };
      const { execSync } = await import('node:child_process');
      const src = join(dir, 'srcartifacts');
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'shot.png'), 'PNGDATA');
      const tar = execSync(`tar -C ${JSON.stringify(src)} -cf - .`);
      return { exitCode: 0, stdout: tar.toString('binary'), stderr: '' };
    });
    const target = join(dir, 'out');
    const res = await new ArtifactsExtractor().run({ sandbox: sb, projectHostPath: dir, params: { targetDir: target } });
    expect(res.kind).toBe('artifacts');
    expect(readFileSync(join(target, 'shot.png'), 'utf8')).toBe('PNGDATA');
  });

  it('denies targetDir outside the project path', async () => {
    const sb = fakeSandbox(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await expect(new ArtifactsExtractor().run({ sandbox: sb, projectHostPath: '/tmp/proj', params: { targetDir: '/etc/evil' } }))
      .rejects.toThrow(/outside/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/promote/diff.ts`:
```ts
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
```

`src/promote/artifacts.ts`:
```ts
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve, sep } from 'node:path';
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
    // binary-safe extraction: re-encode the captured string into bytes
    const buf = Buffer.from(out.stdout, 'binary');
    spawnSync('tar', ['-xf', '-', '-C', target], { input: buf });
    return { kind: this.kind, detail: `artifacts extracted to ${target}` };
  }
}
```

Note: tar-over-exec-stdout is binary-through-UTF8 lossy in theory; acceptable for Phase 1 text artifacts. The integration test (Task 16) verifies PNG survival; if corrupted, switch `#exec` plumbing to base64 (`tar -cf - . | base64`) and decode host-side — a 3-line change contained in this file + guest command.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(promote): diff + artifacts extractors with project-root confinement"
```

---

### Task 12: HTTP server — routes, auth, SSE exec

**Files:**
- Create: `src/server/app.ts`
- Test: `test/server-app.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { EventBus } from '../src/core/events.js';
import type { ModeManager, ProfileRegistry, ResolvedProfile } from '../src/core/ports.js';

const TOKEN = 'test-token-123';
const PROFILE: ResolvedProfile = {
  name: 'dev', image: 'img', cpus: 1, memoryMb: 512, ttlMs: 60_000, net: false,
  allowHosts: [], sshAgent: false, mounts: [],
};

function harness() {
  const registry: ProfileRegistry = { get: async () => PROFILE, list: async () => [PROFILE] };
  const mode: ModeManager = {
    mode: 'ephemeral',
    ids: () => [],
    create: async () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: 't', expiresAt: null }),
    get: async () => ({
      id: 'sb_1', mode: 'ephemeral',
      info: () => ({ id: 'sb_1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: 't', expiresAt: null }),
      exec: async (input) => { input.onOutput?.({ stream: 'stdout', data: 'hello\n' }); return { exitCode: 0, stdout: 'hello\n', stderr: '' }; },
      destroy: async () => {},
    }),
    destroy: async () => {},
    destroyAll: async () => {},
  };
  const app = buildApp({ registry, modes: new Map([['ephemeral', mode]]), bus: new EventBus(), token: TOKEN });
  return { app, mode };
}

describe('sandboxd HTTP API', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('401s without bearer token', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/sandboxes' });
    expect(res.statusCode).toBe(401);
  });

  it('healthz is open', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('POST /sandboxes validates and returns info', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/sandboxes',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { profile: 'dev', mode: 'ephemeral' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe('sb_1');
  });

  it('GET /sandboxes/:id returns info', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/sandboxes/sb_1', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('sb_1');
  });

  it('GET /profiles lists profiles', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/profiles', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.json().map((p: { name: string }) => p.name)).toEqual(['dev']);
  });

  it('exec streams SSE then final result', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/sandboxes/sb_1/exec',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { cmd: ['echo', 'hello'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hello');
    expect(res.body).toContain('"exitCode":0');
  });

  it('DELETE /sandboxes/:id destroys', async () => {
    const res = await h.app.inject({ method: 'DELETE', url: '/sandboxes/sb_1', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(204);
  });

  it('GET /audit returns entries', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/audit?limit=5', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/app.ts`:
```ts
import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { SandboxService } from '../core/sandbox-service.js';
import type { ArtifactExtractor, ModeManager, ProfileRegistry, SandboxBus } from '../core/ports.js';

export interface AppOptions {
  registry: ProfileRegistry;
  modes: Map<string, ModeManager>;
  bus: SandboxBus;
  token: string;
  extractors?: ArtifactExtractor[];
  auditQuery?: (limit: number) => unknown[];
}

function authorized(sent: string | undefined, expected: string): boolean {
  if (!sent?.startsWith('Bearer ')) return false;
  const a = Buffer.from(sent.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildApp(opts: AppOptions) {
  const service = new SandboxService({ registry: opts.registry, modes: opts.modes, bus: opts.bus });
  const extractors = opts.extractors ?? [];
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    if (!authorized(req.headers.authorization, opts.token)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/sandboxes', async (req, reply) => {
    const body = req.body as { profile?: string; mode?: string; project?: string; ttlMs?: number };
    try {
      const info = await service.create({
        profile: String(body.profile),
        mode: (body.mode ?? 'ephemeral') as never,
        project: body.project,
        ttlMs: body.ttlMs,
      });
      return await reply.code(201).send(info);
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/sandboxes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try { return await service.get(id); }
    catch { return await reply.code(404).send({ error: 'not found' }); }
  });

  app.post('/sandboxes/:id/exec', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { cmd?: string[]; env?: Record<string, string> };
    if (!Array.isArray(body.cmd) || body.cmd.length === 0) {
      return await reply.code(400).send({ error: 'cmd must be a non-empty string array' });
    }
    reply.header('content-type', 'text/event-stream');
    reply.header('cache-control', 'no-cache');
    const chunks: string[] = [];
    try {
      const out = await service.exec(id, {
        cmd: body.cmd.map(String),
        env: body.env,
        onOutput: (c) => { chunks.push(`data: ${JSON.stringify(c)}\n\n`); },
      });
      chunks.push(`data: ${JSON.stringify({ result: { exitCode: out.exitCode } })}\n\n`);
      chunks.push('data: [DONE]\n\n');
    } catch (err) {
      chunks.push(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
    }
    return await reply.send(chunks.join(''));
  });

  app.post('/sandboxes/:id/promote', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { kind?: string; params?: Record<string, unknown> };
    try {
      const result = await service.promote(id, String(body.kind), body.params ?? {}, extractors);
      return await reply.send(result);
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/sandboxes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await service.destroy(id);
    return await reply.code(204).send();
  });

  app.get('/profiles', async () => ({ profiles: await opts.registry.list() }));

  app.get('/audit', async (req) => {
    const q = req.query as { limit?: string };
    return opts.auditQuery?.(Math.min(Number(q.limit ?? 50), 1000)) ?? [];
  });

  return { app, service };
}
```

Note: keep `service` exported from `buildApp` — `main.ts` (Task 13) needs it for reaper + shutdown wiring without reaching into the Fastify instance. If SSE response semantics with `inject()` need adjustment (fastify may buffer), assert on the buffered body exactly as the test does — do not switch to websockets in Phase 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): fastify API with bearer auth, SSE exec, audit endpoint"
```

---

### Task 13: Daemon entry (`server/main.ts`) — composition root

**Files:**
- Create: `src/server/main.ts`
- Test: `test/main-wiring.test.ts` (composition unit test with fakes; live smoke is manual)

This file is the ONLY place allowed to import core and adapters together (dependency-cruiser rule `only-composition-root-wires-everything`).

- [ ] **Step 1: Implement**

`src/server/main.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export async function main(): Promise<{ stop: () => Promise<void> }> {
  const token = loadOrCreateToken();
  const store = openStore(join(STATE_DIR, 'state.db'));
  const registry = new ProfileRegistryImpl([join(process.cwd(), 'profiles'), join(STATE_DIR, 'profiles')]);
  const backend = new SmolvmBackend({ binPath: process.env.SMOLVM_BIN ?? join(homedir(), '.local', 'bin', 'smolvm') });
  const modes = new Map([['ephemeral', new EphemeralMode(backend, store.sandboxes)]]);
  const bus: SandboxBus = new EventBus<SandboxEventMap>();

  // audit sink: every event lands in sqlite (spec §3 modularity rule 3)
  for (const event of ['sandbox.created', 'exec.completed', 'policy.denied', 'promote.applied', 'sandbox.destroyed', 'sandbox.reaped'] as const) {
    bus.on(event, (e) => store.audit.append({ ts: new Date().toISOString(), event, sandboxId: ('id' in e ? (e as { id: string }).id : null), payload: e as Record<string, unknown> }));
  }

  const { app, service } = buildApp({
    registry, modes, bus, token,
    extractors: [new DiffExtractor(), new ArtifactsExtractor()],
    auditQuery: (limit) => store.audit.query(limit),
  });
  service.startReaper();

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`[sandd] listening on http://127.0.0.1:${PORT} (token: ${join(STATE_DIR, 'token')})`);

  return {
    stop: async () => {
      service.stopReaper();
      await service.destroyAll('daemon shutdown').catch(() => {});
      await app.close();
      store.close();
    },
  };
}

// direct-run entry (tsx src/server/main.ts)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '##')) {
  main().then(({ stop }) => {
    const shutdown = (signal: string) => { console.log(`[sandd] ${signal}, cleaning up…`); void stop().then(() => process.exit(0)); };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}
```

- [ ] **Step 2: Composition smoke test (fakes only, no daemon start)**

`test/main-wiring.test.ts`:
```ts
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
});
```

- [ ] **Step 3: Live smoke (manual, after `npm run build`)**

```bash
npm run build
node dist/server/main.js &        # starts daemon
sleep 1
TOKEN=$(cat ~/.pisandboxed/token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7331/healthz
kill %1
```
Expected: `{"ok":true}`. Then verify `~/.pisandboxed/token` has mode 0600.

- [ ] **Step 4: All gates**

Run: `npm run typecheck && npm test && npm run cruise`
Expected: all PASS, no dependency violations (main.ts exception active).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): sandd composition root — token bootstrap, audit sink, reaper, graceful shutdown"
```

---

### Task 14: `sand` CLI

**Files:**
- Create: `src/cli/sand.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli/sand.js';
import { buildApp } from '../src/server/app.js';
import { EventBus } from '../src/core/events.js';
import type { ModeManager, ProfileRegistry } from '../src/core/ports.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pisand-cli-'));
  writeFileSync(join(dir, 'token'), 'tok123\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harnessWithDaemon() {
  const registry: ProfileRegistry = {
    get: async () => undefined, list: async () => [{ name: 'dev', image: 'i', cpus: 1, memoryMb: 1, ttlMs: 1, net: false, allowHosts: [], sshAgent: false, mounts: [] }],
  };
  const mode: ModeManager = {
    mode: 'ephemeral', ids: () => [],
    create: async () => ({ id: 'sb_cli1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: 't', expiresAt: null }),
    get: async () => ({
      id: 'sb_cli1', mode: 'ephemeral',
      info: () => ({ id: 'sb_cli1', profile: 'dev', mode: 'ephemeral', state: 'running', project: null, createdAt: 't', expiresAt: null }),
      exec: async () => ({ exitCode: 0, stdout: 'cli-ok\n', stderr: '' }),
      destroy: async () => {},
    }),
    destroy: async () => {}, destroyAll: async () => {},
  };
  const { app } = buildApp({ registry, modes: new Map([['ephemeral', mode]]), bus: new EventBus(), token: 'tok123', auditQuery: () => [{ ts: 't', event: 'sandbox.created', sandboxId: 'sb_cli1', payload: {} }] });
  return app;
}

describe('sand CLI', () => {
  it('profiles lists via API', async () => {
    const app = harnessWithDaemon();
    await app.listen({ port: 0 });
    const addr = app.server.address();
    const out: string[] = [];
    const code = await runCli(['profiles'], {
      baseUrl: `http://127.0.0.1:${addr!.port}`,
      tokenFile: join(dir, 'token'),
      out: (s) => out.push(s),
    });
    await app.close();
    expect(code).toBe(0);
    expect(out.join('')).toContain('dev');
  });

  it('create + exec + rm round-trip', async () => {
    const app = harnessWithDaemon();
    await app.listen({ port: 0 });
    const addr = app.server.address();
    const base = { baseUrl: `http://127.0.0.1:${addr!.port}`, tokenFile: join(dir, 'token'), out: () => {} };
    expect(await runCli(['create', '--profile', 'dev'], base)).toBe(0);
    expect(await runCli(['exec', 'sb_cli1', '--', 'echo', 'hi'], { ...base, out: (s) => s })).toBe(0);
    expect(await runCli(['rm', 'sb_cli1'], base)).toBe(0);
    await app.close();
  });

  it('fails with clear error on bad token', async () => {
    const app = harnessWithDaemon();
    await app.listen({ port: 0 });
    const addr = app.server.address();
    writeFileSync(join(dir, 'token'), 'WRONG\n');
    const code = await runCli(['profiles'], {
      baseUrl: `http://127.0.0.1:${addr!.port}`,
      tokenFile: join(dir, 'token'),
      out: () => {},
    });
    await app.close();
    expect(code).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/cli/sand.ts`:
```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

export interface CliIo {
  baseUrl?: string;
  tokenFile?: string;
  out?: (s: string) => void;
}

function ctx(io: CliIo): { base: string; token: string; out: (s: string) => void } {
  const base = io.baseUrl ?? process.env.SAND_URL ?? 'http://127.0.0.1:7331';
  const tokenFile = io.tokenFile ?? join(homedir(), '.pisandboxed', 'token');
  const token = readFileSync(tokenFile, 'utf8').trim();
  return { base, token, out: io.out ?? ((s: string) => process.stdout.write(s)) };
}

async function api(base: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const { base, token, out } = ctx(io);
  const program = new Command('sand');
  program.exitDefault(false).configureOutput({ writeOut: (s) => out(s), writeErr: (s) => out(s) });
  let code = 0;

  program
    .command('profiles').description('list available security profiles')
    .action(async () => {
      const r = await api(base, token, 'GET', '/profiles');
      if (r.status !== 200) { out(`error: HTTP ${r.status}\n`); code = 1; return; }
      for (const p of JSON.parse(r.text).profiles as { name: string; image: string }[]) out(`${p.name.padEnd(12)} ${p.image}\n`);
    });

  program
    .command('create').description('create a sandbox')
    .requiredOption('--profile <name>')
    .option('--mode <mode>', 'ephemeral | pooled | persistent', 'ephemeral')
    .option('--project <path>')
    .option('--ttl-ms <n>', 'shorten ttl (ms)', Number)
    .action(async (o: { profile: string; mode: string; project?: string; ttlMs?: number }) => {
      const r = await api(base, token, 'POST', '/sandboxes', { profile: o.profile, mode: o.mode, project: o.project, ttlMs: o.ttlMs });
      if (r.status !== 201) { out(`error: ${r.text}\n`); code = 1; return; }
      out(`${JSON.parse(r.text).id}\n`);
    });

  program
    .command('exec').description('run a command in a sandbox (streams output)')
    .argument('<id>')
    .argument('[cmd...]')
    .action(async (id: string, cmd: string[]) => {
      const r = await api(base, token, 'POST', `/sandboxes/${id}/exec`, { cmd });
      if (r.status !== 200) { out(`error: ${r.text}\n`); code = 1; return; }
      for (const line of r.text.split('\n\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') break;
        const evt = JSON.parse(payload) as { stream?: string; data?: string; result?: { exitCode: number }; error?: string };
        if (evt.data) out(evt.data);
        if (evt.error) { out(`error: ${evt.error}\n`); code = 1; return; }
        if (evt.result) code = evt.result.exitCode;
      }
    });

  program
    .command('status').description('sandbox status').argument('<id>')
    .action(async (id: string) => {
      const r = await api(base, token, 'GET', `/sandboxes/${id}`);
      if (r.status !== 200) { out(`error: HTTP ${r.status}\n`); code = 1; return; }
      out(`${r.text}\n`);
    });

  program
    .command('rm').description('destroy a sandbox').argument('<id>')
    .action(async (id: string) => {
      const r = await api(base, token, 'DELETE', `/sandboxes/${id}`);
      if (r.status !== 204) { out(`error: HTTP ${r.status}\n`); code = 1; }
    });

  program
    .command('audit').description('tail the audit log')
    .option('-n, --limit <n>', 'rows', Number, 50)
    .action(async (o: { limit: number }) => {
      const r = await api(base, token, 'GET', `/audit?limit=${o.limit}`);
      if (r.status !== 200) { out(`error: HTTP ${r.status}\n`); code = 1; return; }
      for (const e of JSON.parse(r.text) as { ts: string; event: string; sandboxId: string | null }[]) {
        out(`${e.ts} ${e.event.padEnd(18)} ${e.sandboxId ?? '-'}\n`);
      }
    });

  await program.parseAsync(argv, { from: 'user' });
  return code;
}

// direct-run entry
if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
```

Note: commander actions cannot return exit codes — `runCli` collects them in the closure `code` variable and returns it after `parseAsync`. Tests (`code === 0` / `!== 0`) are the contract.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): sand — profiles/create/exec/status/rm/audit over the REST API"
```

---

### Task 15: Baked image `node26-dev`

**Files:**
- Create: `images/node26-dev.toml`, `images/build-image.sh`

- [ ] **Step 1: Write the Smolfile**

`images/node26-dev.toml`:
```toml
image = "node:26-alpine"
cpus = 4
memory = 4096
net = true

init = [
  "apk add --no-cache git python3 make g++ curl bash",
  "npm install -g pnpm@latest",
  "pnpm config set store-dir /workspace/.pnpm-store",
]
```

- [ ] **Step 2: Write the build script**

`images/build-image.sh`:
```bash
#!/usr/bin/env bash
# Builds a .smolmachine pack from a Smolfile. Usage: ./build-image.sh node26-dev
set -euo pipefail
NAME="${1:?usage: build-image.sh <name>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${2:-$HOME/.pisandboxed/images/$NAME.smolmachine}"
VM="imgbuild-$NAME-$$"

smolvm machine create --name "$VM" -s "$DIR/$NAME.toml"
smolvm machine start --name "$VM"
smolvm machine exec --name "$VM" -- node --version
smolvm machine stop  --name "$VM"
mkdir -p "$(dirname "$OUT")"
smolvm pack create --from-vm "$VM" -o "${OUT%.smolmachine}"
smolvm machine remove --name "$VM" || smolvm machine rm --name "$VM"
echo "built: $OUT"
```

`chmod +x images/build-image.sh`

- [ ] **Step 3: Build and verify (requires smolvm from Task 2)**

```bash
./images/build-image.sh node26-dev
ls -lh ~/.pisandboxed/images/
```
Expected: a multi-hundred-MB `.smolmachine`; script printed node's version from inside the guest.

**IMPORTANT:** if the profile `image` field must reference the pack differently than a plain OCI ref (e.g., a local file path vs registry tag), verify with `smolvm machine run --image ~/.pisandboxed/images/node26-dev.smolmachine -- node --version` and record the exact working form in `docs/smolvm-cli-reference.md`; then update `profiles/dev.toml` + `profiles/build.toml` `image` values to that form.

- [ ] **Step 4: Commit**

```bash
git add images/ && git commit -m "feat(images): node26-dev Smolfile + reproducible build script"
```

---

### Task 16: E2E integration test + README + final gates

**Files:**
- Create: `test/integration/e2e.test.ts`, `README.md`

- [ ] **Step 1: Write the E2E test (gated on real smolvm + KVM)**

`test/integration/e2e.test.ts`:
```ts
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProfileRegistryImpl } from '../../src/adapters/profiles/registry.js';
import { SmolvmBackend } from '../../src/adapters/smolvm/backend.js';
import { EphemeralMode } from '../../src/modes/ephemeral.js';
import { SandboxService } from '../../src/core/sandbox-service.js';
import { openStore } from '../../src/adapters/sqlite/store.js';
import { resolve } from 'node:path';

const enabled = process.env.RUN_VM_TESTS === '1' && existsSync(process.env.SMOLVM_BIN ?? join(homedir(), '.local/bin/smolvm'));
const d = enabled ? mkdtempSync(join(tmpdir(), 'pisand-e2e-')) : '';

describe.skipIf(!enabled)('E2E: fake subagent flow against real smolvm', () => {
  const store = openStore(join(d, 'state.db'));
  const registry = new ProfileRegistryImpl([resolve('profiles')]);
  const backend = new SmolvmBackend({ binPath: process.env.SMOLVM_BIN ?? join(homedir(), '.local/bin/smolvm') });
  const modes = new Map([['ephemeral', new EphemeralMode(backend, store.sandboxes)]]);
  const svc = new SandboxService({ registry, modes, bus: { emit() {}, on() { return () => {}; } } as never });

  afterAll(async () => {
    await svc.destroyAll('test end');
    store.close();
    rmSync(d, { recursive: true, force: true });
  });

  it('untrusted profile: net is off, exec works, guest is a real VM kernel', async () => {
    const info = await svc.create({ profile: 'untrusted', mode: 'ephemeral', project: d });
    expect(info.state).toBe('running');

    const uname = await svc.exec(info.id, { cmd: ['uname', '-a'] });
    expect(uname.stdout).toContain('Linux');

    // network denied by default (spec §1)
    const wget = await svc.exec(info.id, { cmd: ['sh', '-c', 'wget -q -T 3 -O /dev/null https://example.com; echo exit=$?'] });
    expect(wget.stdout).toContain('exit=1');

    // RO mount: writes into /workspace must fail
    const write = await svc.exec(info.id, { cmd: ['sh', '-c', 'touch /workspace/e2e-ro 2>/dev/null; echo wrote=$?'] });
    expect(write.stdout).toContain('wrote=1');

    await svc.destroy(info.id);
  });

  it('dev profile: rw workspace, file written in guest appears on host', async () => {
    const info = await svc.create({ profile: 'dev', mode: 'ephemeral', project: d });
    await svc.exec(info.id, { cmd: ['sh', '-c', 'echo from-vm > /workspace/e2e.txt'] });
    expect(readFileSync(join(d, 'e2e.txt'), 'utf8')).toContain('from-vm');
    await svc.destroy(info.id);
    expect(existsSync(join(d, 'e2e.txt'))).toBe(true); // host repo survived (rw mount is the point)
  });

  it('policy gate denies profile override attempts', async () => {
    await expect(svc.create({ profile: 'nope', mode: 'ephemeral', project: d })).rejects.toThrow(/unknown profile/);
    await expect(svc.create({ profile: 'dev', mode: 'persistent', project: d })).rejects.toThrow(/mode/);
  });
});
```

- [ ] **Step 2: Run unit gates (E2E skipped without env)**

Run: `npm test`
Expected: PASS — integration suite reports skipped.

- [ ] **Step 3: Run the real E2E**

Run: `npm run test:vm`
Expected: PASS (3 tests) — proves VM boot, net-deny, RO/RW mounts, policy gate against the real smolvm.

- [ ] **Step 4: Write README.md**

Must include: what this is (spec §1 summary), quickstart (`npm i && npm run build && npm run sandd` + `sand` usage), profile table from spec §5, API table from spec §9, the security statement from spec §14 verbatim, and a "for PiSubagent consumers" section showing the fetch-based create/exec/promote flow.

- [ ] **Step 5: Final gates — everything green before declaring Phase 1 done**

```bash
npm run typecheck && npm test && npm run cruise && npm run test:vm
```
Expected: all PASS; coverage ≥80% lines/functions; zero dependency-cruiser violations.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test(e2e): fake-subagent flow on real smolvm + README; Phase 1 complete"
```

---

## Task dependency order

1 → 2 → (3, 4) → 5, 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16

Tasks 3+4 can run in parallel after Task 1; Tasks 5+6 in parallel after that. Task 2 (host install) can happen any time before Task 8's flag-verification gate, but doing it second is best (the reference unblocks everything downstream).

## Self-review checklist (run after plan execution of each task)

- [ ] Every new file imports ports only from `core/ports.ts` (adapters/modes/promote)
- [ ] `npm run cruise` still passes (composition-root exception is main.ts only)
- [ ] Events emitted by service match `SandboxEventMap` exactly
- [ ] No test depends on live network or real KVM unless gated by `RUN_VM_TESTS`
- [ ] smolvm flags cross-checked against `docs/smolvm-cli-reference.md`, corrections recorded
