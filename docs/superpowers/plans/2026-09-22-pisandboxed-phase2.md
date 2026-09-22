# PiSandboxed Phase 2 (Visual QA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use Sequential mode for planned tasks or Direct mode if subagents aren't available. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sand create --profile browser-test` gives a subagent a caged Chromium over CDP; a host-side qa-visual agent drives it with browser-harness, verifies with Jev typed judgments, and writes a QA report into `/workspace/artifacts/`.

**Architecture:** Browser in the VM (Chromium + CDP 9222, published to host), brains on the host (browser-harness via uv, Jev via JS SDK, LLM keys never in the sandbox). `qa/` is a TypeScript module in this repo: `harness.ts` (browser-harness subprocess wrapper), `jev.ts` (typed judgments, <0.8 = inconclusive), `report.ts` (JSON + markdown artifacts).

**Tech Stack:** existing sandboxd stack (Node 26/TS, Fastify, vitest, depcruise) + smolvm port publishing + browser-harness (Python, uv-pinned, host-side) + TypeSafe Jev HTTP API.

**Spec:** `docs/superpowers/specs/2026-09-22-pisandboxed-sandbox-service-design.md` §7 (rewritten), §8, §12.

**Conventions:** same as Phase 1 — repo root `/home/genegulanesjr/Documents/GulanesKorp/PiSandboxed`, TDD (RED→GREEN→commit), no sudo, integration tests gated behind `RUN_VM_TESTS=1`, verify CLI/library behavior against reality BEFORE writing adapter code (Phase 1 lesson), unit suite stays hermetic (`npm test` excludes `test/integration/**`).

---

### Task 1: Research spike — port publishing + browser-harness reality

**Files:**
- Modify: `docs/smolvm-cli-reference.md` (port-forwarding section)
- Create: `docs/browser-harness-notes.md`

NO implementation code this task. Output = documented facts the adapters are written against. Everything downstream depends on this.

- [ ] **Step 1: Verify smolvm inbound port publishing**

Consult `docs/smolvm-cli-reference.md` for the ports mechanism (Smolfile `ports` key and/or `machine create` flag). Then empirically:

```bash
# 1. create a VM that publishes 9222 (use the mechanism the reference documents)
# 2. start it, exec a listener in-guest:
smolvm machine exec --name <vm> -- sh -c 'while true; do echo -e "HTTP/1.1 200 OK\r\n\r\nCDP-OK" | nc -l -p 9222; done' &
# 3. from HOST:
curl -s http://127.0.0.1:9222/   # expect CDP-OK
```

Record in the reference doc: exact flags/Smolfile keys, whether the default (TSI) backend forwards inbound, and if not — whether `--net-backend virtio-net` fixes it (this is the documented fallback; verify it works). Clean up the VM.

- [ ] **Step 2: Verify browser-harness reality**

```bash
# on the HOST (it is host-side by design):
cd ~/Documents/GulanesKorp/PiSandboxed
uv venv .venv-qa && uv pip install -p .venv-qa browser-harness   # or the documented install
# start any chromium with CDP (host-side throwaway for this spike):
chromium --headless=new --remote-debugging-port=9223 --no-sandbox --disable-gpu &   # or npx playwright-installed chromium
# drive it with browser-harness per ITS documented entry point:
```

Record in `docs/browser-harness-notes.md`: install command + resolved version, the EXACT invocation shape (CLI? python -m? library import?), how the CDP endpoint is passed in, what a minimal "goto a URL and report the title" run looks like, where helper files get written, and Python version requirements. If browser-harness expects to LAUNCH the browser itself, record how to point it at an existing CDP endpoint (that's our integration shape — the browser lives in a VM).

- [ ] **Step 3: Gates** — `npm run typecheck && npm test` still green (docs only, but cheap insurance).

- [ ] **Step 4: Commit** — `git add docs/ && git commit -m "docs: port-publishing verification + browser-harness invocation notes (Phase 2 spikes)"`

---

## Task 1 spike findings (authoritative — Tasks 2–4 MUST use these)

- **Ports:** `-p/--port HOST:GUEST` on create/run/update. **Inbound forwarding works ONLY on virtio-net when egress is sealed**: verified recipe = `--net-backend virtio-net` + `--no-net` → CDP reachable, egress sealed. TSI + no-net silently swallows data (exit 52). `--allow-host` forces virtio-net anyway.
- **browser-harness 0.1.13** (Python ≥3.11, uv venv `.venv-qa`): stdin-Python CLI `browser-harness <<'PY' … PY`; 72 helpers pre-imported (`page_info`, `new_tab`, `goto_url`, `js`, `cdp`, `click_at_xy`, `wait_for_*`); existing-CDP wiring via `BU_CDP_URL=http://host:port` (or `BU_CDP_WS=ws://…`); NO LLM key needed (fast path `page_info()`); workspace `$BH_AGENT_WORKSPACE/agent_helpers.py`; tab marker emoji off via `BH_TAB_MARKER=0`. Endpoint read at daemon start → adapter passes `--reload` on endpoint change. Dead endpoint = 30s retry then exit 1.
- **Guest `/tmp` is tmpfs** — state there is lost on VM restart; keep runtime state in `/workspace`.

---

### Task 2: `chromium-cdp` image

**Files:**
- Create: `images/chromium-cdp.toml`, modify `images/build-image.sh` (only if parameterization is insufficient)
- Modify: `docs/browser-harness-notes.md` (boot verification results)

- [ ] **Step 1: images/chromium-cdp.toml**

```toml
image = "node:26-alpine"
cpus = 4
memory = 4096
net = true

init = [
  "apk add --no-cache chromium font-noto font-noto-emoji nss curl bash",
  "mkdir -p /opt/cdp /workspace/artifacts",
  "printf '#!/bin/sh\\nexec /usr/bin/chromium-browser --headless=new --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/cdp-profile\\n' > /opt/cdp/start-chromium.sh",
  "chmod +x /opt/cdp/start-chromium.sh",
]
```

Notes: `--remote-debugging-address=0.0.0.0` so the published port reaches CDP from the host (localhost-binding inside the guest would hide it behind the forwarding boundary — verify in Step 3; if the guest loopback works through forwarding, tighten to 127.0.0.1). `--no-sandbox` is correct: the VM is the sandbox. Package names are alpine-standard; if `chromium-browser` vs `chromium` differs on the current alpine, fix the wrapper path.

- [ ] **Step 2: Build** — `./images/build-image.sh chromium-cdp` → expect `~/.pisandboxed/images/chromium-cdp.smolmachine`. Adapt build-image.sh if needed (it already takes NAME).

- [ ] **Step 3: Boot + CDP verification (the acceptance proof)**

```bash
smolvm machine create --from ~/.pisandboxed/images/chromium-cdp.smolmachine --name cdpcheck
smolvm machine start --name cdpcheck
smolvm machine exec --name cdpcheck -- sh -c '/opt/cdp/start-chromium.sh >/tmp/chrome.log 2>&1 & sleep 3; wget -q -O - http://127.0.0.1:9222/json/version'
```
Expect a JSON with `"Browser":` — Chromium's CDP is alive in-guest. THEN the port-publishing proof per Task 1's documented mechanism: `curl -s http://127.0.0.1:9222/json/version` FROM THE HOST. Record exactly what worked (flags, addressing) in `docs/browser-harness-notes.md`. Clean up the VM (`delete -f`).

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(images): chromium-cdp — headless Chromium with CDP 9222 + boot verification"`

---

### Task 3: `browser-test` profile + ports through the stack

**Files:**
- Modify: `src/core/ports.ts` (ResolvedProfile.ports, BootOptions.ports), `src/adapters/profiles/registry.ts` (zod `ports`, default `[]`), `src/adapters/smolvm/backend.ts` (pass port flags per Task 1 findings), `profiles/browser-test.toml`, `test/builtin-profiles.test.ts`, `test/smolvm-backend.test.ts`, `test/profiles-registry.test.ts` (ports round-trip)
- TDD: extend tests first, then wire.

- [ ] **Step 1: Failing tests** — (a) registry test: profile with `ports = ["9222:9222"]` resolves to `ports: ["9222:9222"]`; (b) backend test: boot with `ports: ["9222:9222"]` emits the verified port flag(s) from Task 1; boot with `ports: []` emits none; (c) builtin test: browser-test has image `pack:chromium-cdp`, exactly one port `9222:9222`, net false (sealed — staging via allow_hosts later), rw workspace mount.

- [ ] **Step 2: Implement** — flow `ports` through ResolvedProfile → BootOptions → backend args. **SEALING MATRIX (Task 2-verified — backend-aware, do NOT use --no-net for port-publishing VMs):**
  - `ports.length > 0` → create flags: `-p <mapping>` per port + `--net-backend virtio-net`; when `net=false` seal with **`--outbound-localhost-only`** (inbound publishing + localhost-only outbound + denial logging — Task 2 live-verified; `update --no-net` does NOT seal outbound on virtio-net).
  - `ports.length === 0 && !net` → Phase 1 behavior: `machine update --no-net` between create and start (TSI, proven sealed in Phase 1 E2E).
  - `net=true && allowHosts.length > 0` → `--allow-host` per host (implies virtio-net; unchanged).
  - `net=true && allowHosts.length === 0` → bare `--net` (explicit full outbound; no builtin does this).
  Unit tests pin the full 4-row matrix. Record the `--outbound-localhost-only` correction in `docs/smolvm-cli-reference.md` (corrects the Task 1 spike's row-5 claim).

- [ ] **Step 3: profiles/browser-test.toml**

```toml
image = "pack:chromium-cdp"
cpus = 4
memory = 8192
ttl = "1h"
net = false
ports = ["9222:9222"]

[network]
allow_hosts = []

[[mounts]]
host = "/home/genegulanesjr/Documents/{project}"
guest = "/workspace"
mode = "rw"

[secrets]
ssh_agent = false
```

- [ ] **Step 4: Gates** — `npm test` (all green incl. new assertions), `npm run typecheck`, `npm run cruise`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(profiles): browser-test — chromium-cdp + published CDP port through the stack"`

---

### Task 4: `qa/harness.ts` — browser-harness lifecycle wrapper

**Files:**
- Create: `qa/requirements.txt` (pinned browser-harness + deps from Task 1), `qa/harness.ts`, `test/qa-harness.test.ts`
- DEPCRUISE: `qa/` is outside `src/` — add `qa` to nothing; keep it import-free from src (it composes at the agent layer). If you find qa/ NEEDS a port/type from src/core, STOP and reconsider: the right dependency is qa→ports via a small shared types file only if unavoidable; prefer standalone types.

- [ ] **Step 1: Failing tests** — mock `child_process` (or inject a runner). Contract:
```ts
export interface HarnessOptions {
  cdpUrl: string;              // ws://127.0.0.1:<hostPort>
  task: string;                // natural-language task for browser-harness
  workspaceDir: string;        // per-task helper workspace (consumer project dir)
  pythonBin?: string;          // default: .venv-qa/bin/python
  timeoutMs?: number;          // default 300_000
}
export interface HarnessResult {
  ok: boolean;
  transcript: string;          // combined harness output
  helperFiles: string[];       // generated helpers found in workspaceDir
  error?: string;
}
export function runHarnessTask(opts: HarnessOptions, run?: (cmd: string[], opts: object) => Promise<{stdout: string; stderr: string; exitCode: number}>): Promise<HarnessResult>;
```
Tests: (1) invokes the Task-1-documented entry point with cdpUrl + task + workspaceDir (assert exact argv/program shape per Task 1 findings); (2) returns ok=true + transcript on exit 0; (3) ok=false + error on non-zero; (4) lists helperFiles from workspaceDir; (5) timeout kills and returns ok=false.

- [ ] **Step 2: Implement** against Task 1's documented invocation. Env for the subprocess: pass through `process.env` (browser-harness may need LLM keys — HOST side, by design).

- [ ] **Step 3: Gates** — unit green, typecheck, cruise.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(qa): browser-harness lifecycle wrapper with pinned deps + injected runner"`

---

### Task 5: `qa/jev.ts` — typed judgments with threshold policy

**Files:**
- Create: `qa/jev.ts`, `test/qa-jev.test.ts`

- [ ] **Step 1: Failing tests** — inject `fetch`. Contract:
```ts
export interface JevOptions { apiKey?: string; endpoint?: string; threshold?: number; }  // default 0.8
export interface Verdict<T = boolean> { value: T; confidence: number; inconclusive: boolean; raw: unknown; }
export function makeJev(opts?: JevOptions): {
  verify(question: string, state: unknown): Promise<Verdict<boolean>>;
  choose<T extends string>(question: string, options: T[], state: unknown): Promise<Verdict<T>>;
};
```
Tests (mocked fetch): (1) sends question+state to the TypeSafe API endpoint with auth header from apiKey (or `TYPE_SAFE_API_KEY` env — if absent, `verify` resolves `{value:false, confidence:0, inconclusive:true}` WITHOUT calling fetch); (2) parses `{value, confidence}` from the documented response shape (use Task 1/skill-docs reality; adapt parser not tests); (3) confidence < threshold → `inconclusive: true`; (4) `choose` maps the raw verdict to one of the options; unknown → inconclusive; (5) API error → inconclusive + raw carries the error (never throws).

- [ ] **Step 2: Implement.** Keep the endpoint/response parsing in ONE small function so API drift is a one-line fix.

- [ ] **Step 3: Gates → Commit** — `git add -A && git commit -m "feat(qa): Jev typed judgments — threshold policy, fail-inconclusive never fail-open"`

---

### Task 6: `qa/report.ts` — QA report artifacts

**Files:**
- Create: `qa/report.ts`, `test/qa-report.test.ts`

- [ ] **Step 1: Failing tests** — contract:
```ts
export interface CheckResult { name: string; verdict: Verdict; detail?: string; screenshots: string[]; }
export interface QaReport { sandboxId: string; url: string; startedAt: string; finishedAt: string; checks: CheckResult[]; harnessTranscript: string; }
export function writeReport(report: QaReport, artifactsDir: string): { jsonPath: string; markdownPath: string };
```
Tests: writes `report.json` (parseable, round-trips) + `report.md` (contains check names, verdicts incl. INCONCLUSIVE marker, confidence %, screenshot paths, summary line "N/M passed, K inconclusive").

- [ ] **Step 2: Implement** (pure fs + template). 
- [ ] **Step 3: Gates → Commit** — `git add -A && git commit -m "feat(qa): report writer — json + markdown with inconclusive visibility"`

---

### Task 7: Gated E2E — the full visual-QA loop

**Files:**
- Create: `test/integration/visual-qa.e2e.test.ts`, `qa/demo-site/index.html` (tiny static site: login form + dashboard, ~60 lines, no deps)

Gated on `RUN_VM_TESTS=1` + smolvm + the chromium-cdp pack existing.

- [ ] **Step 1: The E2E** —
1. create sandbox `browser-test`, project = a temp dir under `~/Documents` (Phase 1 lesson) containing `qa/demo-site/`
2. exec: start the static site in-guest (`cd /workspace/qa/demo-site && (python3 -m http.server 8080 >/dev/null 2>&1 &) ; sleep 1`) and launch `/opt/cdp/start-chromium.sh` in background
3. HOST-side CDP smoke (no LLM key): `curl http://127.0.0.1:9222/json/version` → Browser JSON; then `curl http://127.0.0.1:9222/json/new?http://localhost:8080/` → tab opens; `/json` lists it. NOTE: sandbox must be created with the verified recipe — ports force `--net-backend virtio-net` in the backend (Task 3); egress stays sealed (`--no-net`).
4. harness run (ONLY if browser-harness installed — `describe.skipIf`): `runHarnessTask({cdpUrl, task: "open http://localhost:8080 and report the page title", workspaceDir})` → ok=true
5. jev checks: mocked in CI; if `TYPE_SAFE_API_KEY` present, one real `verify("does the page contain a login form?", json/title state)`
6. `writeReport(...)` → artifacts on host via mount; assert files exist and markdown contains the check
7. teardown: `svc.destroy`

- [ ] **Step 2:** `npm test` (hermetic, E2E skipped) green; `npm run test:vm` → ALL green (Phase 1 suites + new). Fix expectations only where reality is spec-acceptable; fix code where the adapter is wrong. Record every reality-note.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "test(e2e): browser-test sandbox loop — CDP from host, harness task, report artifacts"`

---

### Task 8: Example agent + README + final gates

**Files:**
- Create: `agents/qa-visual.md`, modify `README.md`

- [ ] **Step 1: agents/qa-visual.md** — a pi agent definition (frontmatter: name, description, model hint) whose system prompt instructs: take a target (URL/flow), create a browser-test sandbox via `sand`, start the site in-guest, launch `/opt/cdp/start-chromium.sh`, run harness batches (`qa/harness.ts`), interpose Jev checks (`qa/jev.ts`) on each checkpoint, write the report (`qa/report.ts`), and promote/summarize artifacts. Explicit rules: never put API keys in the sandbox; never pass `--net` manually; screenshots + report are the deliverable. Structure per PiSubagent agent conventions (check PiSubagent repo's agent format before writing — mirror it exactly so re-homing is mechanical).

- [ ] **Step 2: README** — new "Visual QA (Phase 2)" section: architecture diagram (spec §7), host prereqs (uv, browser-harness venv, TYPE_SAFE_API_KEY optional), quickstart (create browser-test sandbox → start site → start chromium → run harness → report), link to agents/qa-visual.md. 

- [ ] **Step 3: Final gates** — `npm run typecheck && npm test && npm run cruise && npm run test:vm` ALL green.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: qa-visual example agent + README; Phase 2 complete"`

---

## Task dependency order

1 → 2 → 3 → (4, 5, 6 can parallelize — different files) → 7 → 8

Task 1 is the gate: Tasks 2–4 all reference its outputs. Do not start 2–4 with guessed flags/invocations.

## Self-review checklist

- [ ] Ports flow: profile → ResolvedProfile → BootOptions → backend (no side channels)
- [ ] `qa/` never imports `src/` (standalone module; duplicate the 3 types it needs if pressed)
- [ ] No LLM key ever crosses into the sandbox (grep the E2E + agent prompt for key handling)
- [ ] Sealed-by-default preserved: browser-test net=false; allow_hosts only for staging
- [ ] Jev: fail-inconclusive, never fail-open (test pins it)
- [ ] Integration tests gated; hermetic suite unaffected
