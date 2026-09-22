# PiSandboxed Phase 3 (Lifecycle Completion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use Sequential mode for planned tasks or Direct mode if subagents aren't available. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** complete the three-mode lifecycle contract — `pooled` (warm branchable sources, COW branch fan-out for parallel subagents) and `persistent` (named dev boxes that survive daemon restarts, TTL-reaped) — plus the small riders: `/metrics`, `python-dev` image + profile, ephemeral-orphan sweep.

**Architecture:** no new modules — two new `ModeManager` implementations (`modes/pool.ts`, `modes/persistent.ts`) registered in the composition root, small `IsolationBackend` additions (`branchable` start flag, `branch()`), a fan-out response shape on the existing API, and a startup sweep. Dependency rules unchanged (`server → core → ports ← adapters`, depcruise-enforced).

**Tech Stack:** unchanged. smolvm 1.17.0 branch mechanics (verified in Phase 1 Task 2 capture + re-verified in Task 1 here).

**Spec:** `docs/superpowers/specs/2026-09-22-pisandboxed-sandbox-service-design.md` §4 (modes), §12 (Phase 3).

**Conventions:** unchanged — repo root `/home/genegulanesjr/Documents/GulanesKorp/PiSandboxed`, TDD (RED→GREEN→commit), no sudo, hermetic `npm test` + gated `npm run test:vm`, verify CLI behavior against reality BEFORE adapter code.

---

## Design decisions locked before Task 1 (record, don't relitigate)

1. **Sequential single branches, not batch.** `machine branch --from S --name <sb_id>` per child. Batch (`--count --name-prefix`) generates names we don't control; our mapping requires machine-name = sandbox-id. COW forks are fast; revisit batch if profiling ever says otherwise.
2. **Source workload:** boot with `--branchable` on START, guest init = `sh -c 'exec smolvm-branch-ready'` (parks at branch-point forever → single branches never wait, children park with helper as init, ready for exec).
3. **Pooled profiles must be self-contained.** A `mode: pooled` request against a profile whose mounts contain a rw `{project}` placeholder is DENIED (`pooled requires a self-contained profile — children share the source disk COW; per-project rw mounts cannot fan out`). New builtin `pool-node.toml`: `pack:node26-dev`, mounts `[]`, npm+github allowlist, 30m ttl. Children work in their own COW disk overlay.
4. **Persistent naming:** `name?: string` on CreateSandboxInput (pattern `^[a-z0-9][a-z0-9-]{2,30}$`) → sandbox id = name. Collision (existing row/machine) → PolicyError. Default TTL for persistent: 7d (profile ttl is an upper bound as before).
5. **Survival:** persistent sandboxes survive daemon restart via sqlite rows + `smolvm machine list` re-attach at startup. Ephemeral orphans (crash leftovers) are swept at startup: rows → stopped, machines → `delete -f` (ephemeral = disposable by definition).
6. **Sources are internal:** not consumer-visible sandboxes, no `sandbox.created` events; pool stats exposed via `/metrics` only.

---

### Task 1: Branch mechanics spike (live)

**Files:** Modify `docs/smolvm-cli-reference.md` (branch section), Create `docs/phase3-spike.md`

- [ ] **Step 1:** Live-verify with a throwaway VM (delete after): `machine create` + `machine start --name S --branchable` → guest init `sh -c 'exec smolvm-branch-ready'` parks (check process list in-guest) → `machine branch --from S --name C1` (single, expect fast) → child state running → `machine exec --name C1 -- env` shows `SMOLVM_BRANCH_NAME/INDEX/BATCH_ID/BATCH_SIZE` → `machine exec --name C1 -- uname -a` works → `machine branch --from S --name C2` again (second single branch from same parked source — does it work repeatedly? record) → COW proof: write file in C1 to `/root/spike.txt`, check it's ABSENT in C2 and in S → branch onto a `--outbound-localhost-only` source: does the child inherit the seal? → `machine delete -f` all three.
- [ ] **Step 2:** Document every result verbatim in `docs/phase3-spike.md` + refresh the branch section of the reference doc. Any deviation from the README's described semantics = a red flag for Tasks 2–3 (record, adapt plan).
- [ ] **Step 3:** `npm test` still green (docs-only). **Commit:** `git add docs/ && git commit -m "docs: branch mechanics verified live (Phase 3 spike)"`

---

### Task 2: Backend branch support

**Files:** Modify `src/core/ports.ts` (BootOptions: `branchable?: boolean`, `branchWorkload?: boolean`; IsolationBackend: `branch(from: string, machineName: string): Promise<BackendHandle>`), `src/adapters/smolvm/backend.ts`, `test/smolvm-backend.test.ts`

- [ ] **Step 1: Failing tests** — (a) boot with `branchable: true` emits `machine start --name X --branchable`; (b) boot with `branchWorkload: true` uses `-- /bin/sh -c 'exec smolvm-branch-ready'` instead of `sleep infinity` (and the two flags are independent); (c) `branch('S','sb_c1')` emits `machine branch --from S --name sb_c1` and returns a working handle (exec/stop/remove wired to `sb_c1`).
- [ ] **Step 2: Implement** against Task 1's verified flags (adapt flag forms to the spike doc if they differ — interface stays fixed).
- [ ] **Step 3:** `npm test`, `npm run typecheck`, `npm run cruise` green. **Commit:** `git commit -m "feat(adapters/smolvm): branchable boot + branch() per verified spike"`

---

### Task 3: `modes/pool.ts` — PooledMode

**Files:** Create `src/modes/pool.ts`, `test/mode-pool.test.ts`; Modify `src/core/ports.ts` (CreateSandboxInput: `count?: number`, `name?: string` — name lands in Task 5 but declare both here once)

- [ ] **Step 1: Failing tests** (fake backend + fake repo; contract):
```ts
export interface PoolOptions {
  maxSources?: number;        // default 2
  sourceIdleTtlMs?: number;   // default 30*60_000
}
// PooledMode implements ModeManager:
// create(input, profile):
//   profile.mounts.some(m => m.readWrite && m.host.includes('{project}')) → PolicyError 'self-contained'
//   source = ensureSource(profile)  // boots warm branchable source (id: pool_<profilehash>), reuses existing warm one
//   n = input.count ?? 1
//   children = for i in 1..n: backend.branch(source.machineName, `sb_${newId()}`) → ManagedSandbox (state running, expiresAt = now + profile.ttlMs)
//   returns n===1 ? SandboxInfo : { sandboxes: SandboxInfo[] }   // see Task 4 note — ModeManager.create returns SandboxInfo; count>1 handled by service (below)
// ids(): children only. destroy/destroyAll: children (destroyAll also handles sources on shutdown).
// reapOnce hook: destroy sources idle > sourceIdleTtlMs (no live children referencing them).
```
Tests: (1) first create boots a source with branchable+branchWorkload then branches one child; (2) second create reuses the warm source (booted count stays 1); (3) `count: 3` (service-level, via a direct PooledMode.createMany helper OR service fan-out — implement `createMany(input, profile): Promise<SandboxInfo[]>` on PooledMode) branches 3 distinct children; (4) rw-{project} profile → PolicyError, no boot; (5) source idle TTL → source stopped (and its machine removed); (6) destroyAll stops children AND sources.
- [ ] **Step 2: Implement** `PooledMode` + `createMany`. Source ids: `pool_` + fnv1a-hash of profile.name (deterministic, reproducible).
- [ ] **Step 3:** Gates green. **Commit:** `git commit -m "feat(modes): pooled — warm branchable sources + COW fan-out children"`

---

### Task 4: Service + API wiring for pooled/persistent inputs

**Files:** Modify `src/core/sandbox-service.ts` (count/name plumbing, pooled gate), `src/server/app.ts` (response shape), `test/sandbox-service.test.ts`, `test/server-app.test.ts`

- [ ] **Step 1: Failing tests** — service: (a) `mode: pooled` + rw-{project} profile → PolicyError (defense in depth — the mode also checks); (b) pooled `count: 3` → mode's `createMany` called, service returns array as `unknown`; (c) `count` on ephemeral → PolicyError ('count is only valid for pooled mode'). API: (d) `POST /sandboxes {mode:'pooled', count:3}` → 201 `{sandboxes: [3 ids]}`; (e) default pooled create (no count) → 201 single info object (backward-compatible).
- [ ] **Step 2: Implement** — service detects pooled+count>1 → casts mode to PooledMode (capability check: `'createMany' in mode`) → returns array; app serializes array as `{sandboxes: [...]}`. Keep single-create response byte-identical to Phase 1.
- [ ] **Step 3:** Gates green. **Commit:** `git commit -m "feat(api): pooled fan-out — count + {sandboxes:[...]} response, self-contained gate"`

---

### Task 5: `modes/persistent.ts` — PersistentMode + startup sweep

**Files:** Create `src/modes/persistent.ts`, `test/mode-persistent.test.ts`; Modify `src/core/sandbox-service.ts` (name handling), `src/server/main.ts` (register mode, attach + sweep on boot), `test/sandbox-service.test.ts`, `test/main-wiring.test.ts`

- [ ] **Step 1: Failing tests** (fakes; contract):
```ts
// PersistentMode implements ModeManager:
// constructor(backend, repo)
// attachExisting(): rows = repo.listByState('running') where mode==='persistent' → for each, verify machine alive (backend.status? — simplest: exec 'true' or a new backend.isAlive(name): boolean) → rebuild #live map; machines gone → row → stopped
// create(input, profile): id = input.name ?? generated sb_id; collision (repo.get(id)) → PolicyError; expiresAt = now + (input.ttlMs ?? profile.ttlMs) — profile ttl caps it (service gate already enforces ttlMs ≤ profile.ttlMs); a 7-day default comes from a custom user profile with ttl = "168h" — wait, ttl regex is ^\d+[smh]$ so max unit is hours: "168h" is valid. DECISION: persistent default stays profile-driven; document that long-lived persistence wants a user profile with a big ttl.
// ids/get/destroy/destroyAll: same shape as ephemeral, no #live.delete-before-stop ordering change needed (keep Phase 1 pattern).
```
Service: `input.name` → PolicyError if `!/^[a-z0-9][a-z0-9-]{2,30}$/`; if provided AND mode persistent → mode must honor it (PersistentMode.create uses it). main.ts: construct PersistentMode AFTER store; `await persistent.attachExisting()` before listen; ephemeral sweep: `store.sandboxes.listByState('running'|'creating')` where mode==='ephemeral' → try backend.remove(machineName) → row.updateState stopped.
- [ ] **Step 2: Implement.** Backend needs `isAlive?(machineName: string): Promise<boolean>` — optional port method, implemented via `machine exec -- true` (cheap) or `machine list` parse; use exec-true (single source of truth, no output parsing).
- [ ] **Step 3:** Gates green. **Commit:** `git commit -m "feat(modes): persistent — named long-lived sandboxes, daemon-restart reattach, ephemeral orphan sweep"`

---

### Task 6: `/metrics` endpoint

**Files:** Modify `src/server/app.ts`, `test/server-app.test.ts`, `docs/` not needed

- [ ] **Step 1: Failing test** — `GET /metrics` (authed) → JSON: `{ sandboxes: {running, stopped, creating, error}, byMode: {ephemeral, pooled, persistent}, execs: <audit count of exec.completed>, uptimeSec, pool: {sources: <pool size if available> } }` — sourced from repos + auditQuery. Keep it a plain JSON snapshot (no Prometheus format until a scraper exists — YAGNI).
- [ ] **Step 2: Implement** — AppOptions gains `metricsSource?: () => Record<string, unknown>`; main.ts supplies repo/audit-backed closure. Endpoint returns `metricsSource?.() ?? {error:'unavailable'}`.
- [ ] **Step 3:** Gates → **Commit:** `git commit -m "feat(server): /metrics snapshot endpoint"`

---

### Task 7: `python-dev` image + profile

**Files:** Create `images/python-dev.toml`, `profiles/python.toml`, modify `test/builtin-profiles.test.ts`

- [ ] **Step 1:** Smolfile: `image = "python:3.12-alpine"`, `init = ["apk add --no-cache git curl bash build-base", "pip install --no-cache-dir uv"]`. Build via `VERIFY_CMD="python3 --version" ./images/build-image.sh python-dev`. Profile `python.toml`: mirror dev.toml but image `pack:python-dev`, allowlist `["pypi.org", "files.pythonhosted.org", "github.com"]`. Builtin test: parses, mounts pattern, allowlist contains pypi.
- [ ] **Step 2:** Gates → **Commit:** `git commit -m "feat(images): python-dev pack + python profile"`

---

### Task 8: Gated E2E + README + final gates

**Files:** Modify `test/integration/` (new `lifecycle.e2e.test.ts`), `README.md`

- [ ] **Step 1: E2E (gated, real smolvm):**
  - **Pooled fan-out:** `svc.create({profile:'pool-node', mode:'pooled', count:3})` → 3 running children, distinct ids; exec `uname -a` in EACH; COW proof: exec write `/root/cow.txt` in child 1 → absent in child 2; concurrent execs in all 3 succeed; teardown destroys children.
  - **Persistent survival:** start daemon A on port X (in-process main() twice, or two `main()` invocations on different STATE_DIRs — simplest: use the daemon as a subprocess like Task 13's smoke) → create persistent named `qa-persist-e2e` → stop daemon → start daemon B → `svc.get('qa-persist-e2e')` still running → exec works → destroy.
  - **Orphan sweep:** insert a fake running ephemeral row + fake machine → boot → row stopped, machine deleted.
- [ ] **Step 2:** README: "## Lifecycle modes (Phase 3)" — pooled semantics (self-contained profiles, fan-out example with count:3), persistent semantics (name, survival, reaper, custom TTL via user profile), `/metrics` sample, python-dev mention.
- [ ] **Step 3: FINAL GATES:** `npm run typecheck && npm test && npm run cruise && npm run test:vm` — all green.
- [ ] **Step 4:** `git commit -m "test(e2e): pooled fan-out + persistent survival + orphan sweep; README; Phase 3 complete"`

---

## Task dependency order

1 → 2 → 3 → 4 → 5 → (6, 7 parallel) → 8

Task 1 gates everything (branch mechanics). Tasks 6+7 are independent riders.

## Self-review checklist

- [ ] Sealing matrix untouched — branch children inherit source network posture (verify in Task 1 spike: `--outbound-localhost-only` inheritance)
- [ ] `pooled` + rw-{project} profile denied at BOTH mode and service level
- [ ] Single-create responses byte-compatible with Phase 1 (tests pin it)
- [ ] Persistent rows survive restart; ephemeral orphans do not
- [ ] No new deps; qa/ untouched; depcruise rules intact
