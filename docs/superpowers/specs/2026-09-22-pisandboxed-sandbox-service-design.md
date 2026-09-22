# PiSandboxed — Sandboxing & Security Service Design

**Date:** 2026-09-22
**Status:** Approved design, pending implementation plan
**Part of:** GulanesKorp AI coding agent platform (LaPis = memory · PiSubagent = orchestration · **PiSandboxed = isolated execution**)

---

## 1. Mission

A platform microservice that provides hardware-isolated microVM execution for the
GulanesKorp agent platform. It gives PiSubagent (and any consumer — pi agents,
humans, future services) safe environments to:

1. **Run untrusted code** — subagent-generated scripts, cloned repos, installed packages
2. **Fan out parallel work** — warm-source branching for concurrent subagent tasks
3. **Test changes** — build/test inside a VM; results reach the host only via explicit promotion
4. **Visually test sites** — headless Chromium in a VM driven by a vision-model subagent

Nothing a subagent does inside a sandbox can touch the host outside policy-approved paths.

## 2. Non-goals

- Multi-tenant / multi-user hardening (sandboxd runs as the invoking user; single-user service)
- Replacing CI systems (this is agent-facing sandboxing, not a pipeline runner)
- Windows/macOS support at launch (Linux/KVM only for v1; smolvm supports the others later)

## 3. Architecture

```
PiSubagent / pi agents / humans
        │  HTTP (localhost, token auth)
        ▼
┌──────────────── sandboxd (Node 26 / TypeScript daemon) ─────────────────┐
│  server/   REST API (fastify, auth, SSE)  ← thin HTTP↔core mapping     │
│      ▼                                                                 │
│  core/     SandboxService + typed event bus                            │
│            depends ONLY on ports (interfaces), never on adapters       │
│      ▼ ports                     ▲ adapters (implement ports)          │
│  IsolationBackend ─────────── adapters/smolvm/  (only CLI spawner)     │
│  ModeManager ──────────────── modes/ (ephemeral | pool | persistent)   │
│  ProfileRegistry ──────────── adapters/profiles/ (builtin + user TOML) │
│  SandboxRepo · AuditRepo ──── adapters/sqlite/  (state + audit sink)   │
│  ArtifactExtractor ────────── promote/ (diff, artifacts strategies)    │
└─────────────────────────────────────────────────────────────────────────┘
        ▼
   smolvm microVMs (libkrun + KVM) — network deny-by-default
```

**Key rule:** nothing talks to smolvm directly except sandboxd. Consumers never
see VM names — only sandbox IDs. `sand` (CLI) is a thin client of the same API.

**Why a daemon (decision record):** true microservice shape matches the platform
direction; central policy enforcement is only enforceable at a choke point; CLI
client comes nearly free; service can move to another box later. We wrap the
smolvm CLI (stable contract) rather than embedding Rust crates (private,
unstable internals; <200ms boot makes subprocess overhead negligible).

### Modularity rules (enforced from Phase 1)

Ports-and-adapters, right-sized to a single package — modularity lives in
enforced boundaries, not packaging (no npm workspaces, no third-party plugin
loading).

1. **Dependency direction:** `server → core → ports ← adapters`. Core and ports
   never import from `adapters/`, `modes/`, `server/`. Enforced in CI with
   dependency-cruiser from the first commit.
2. **Ports are the only seams:** `IsolationBackend`, `ModeManager`,
   `ProfileRegistry`, `SandboxRepo`, `AuditRepo`, `ArtifactExtractor`. All are
   TypeScript interfaces in `core/ports.ts`, defined in Phase 1 even where only
   one implementation exists yet.
3. **Event bus for cross-cutting concerns:** core emits typed events
   (`sandbox.created`, `exec.completed`, `promote.applied`, `sandbox.reaped`,
   `policy.denied`). Phase 1 ships one subscriber — the SQLite audit sink.
   Metrics, webhooks, platform notifications subscribe later, no core edits.
4. **Registration over wiring:** modes and extractor strategies self-register;
   adding one is a new file + a registration line.

### Extension points (future feature → where it lands)

| Future feature | Touches | Core changes |
|---|---|---|
| pooled mode (Ph3) | new `modes/pool.ts` | registration only |
| persistent mode (Ph3) | new `modes/persistent.ts` | registration only |
| cloud/docker backend | new `IsolationBackend` adapter | config selection |
| metrics dashboard | event subscriber | none |
| webhook → PiSubagent | event subscriber | none |
| new artifact type (HAR, video, traces) | new `ArtifactExtractor` strategy | registration only |
| remote profile registry | new `ProfileRegistry` source | none |
| GPU profiles | profile schema + smolvm adapter flags | additive schema |
| PiSubagent typed SDK | separate package over REST | none |

## 4. Lifecycle modes (per-request field `mode`)

| Mode | Behavior | Phase | Use |
|---|---|---|---|
| `ephemeral` *(default)* | boot → run → destroy, per task | 1 | untrusted code, one-shot tests |
| `pooled` | daemon keeps warm **branchable** source VMs per profile; requests branch COW from a warm source; supports N-way fan-out (`count`) | 3 | parallel builds/tests/scrapes |
| `persistent` | named VM, survives sessions, TTL + reaper | 3 | dev boxes, interactive debugging |

All three modes share one API surface. Mode is an implementation detail behind
`POST /sandboxes`.

## 5. Security profiles

Versioned TOML files in-repo, referenced by name. Requests pick a profile but
**cannot override its rules** (enforced by the Policy Engine — this is the point
of centralizing policy).

```toml
# profiles/dev.toml
image = "ghcr.io/gulaneskorp/node26-dev:latest"
cpus = 4
memory = 4096
ttl = "30m"
[network]
allow_hosts = ["registry.npmjs.org", "github.com"]
[[mounts]]
host = "/home/genegulanesjr/Documents/{project}"
guest = "/workspace"
mode = "rw"
[secrets]
ssh_agent = false
```

**Built-in profiles (Phase 1):**

| Profile | Net | Mounts | Secrets | Resources | TTL |
|---|---|---|---|---|---|
| `untrusted` | off | RO only | none | 2 cpu / 2 GB | 10m |
| `dev` | allowlist (npm, github) | rw workspace | none | 4 cpu / 8 GB | 30m |
| `build` | narrow (git + registry) | rw workspace | SSH agent | 4 cpu / 8 GB | 1h |

**Phase 2:** `browser-test` (see §7). Custom user profiles live in
`profiles.user/` (gitignored); built-ins are immutable.

## 6. Change-testing workflow ("testing changes")

1. Subagent gets a sandbox with the host repo mounted at `/workspace`
2. It edits, builds, runs tests **inside the VM** (host repo is a live mount, but
   nothing on the host executes)
3. Results reach the host **only via explicit promotion**:
   `POST /sandboxes/:id/promote` extracts git diff / test report / artifacts to a
   policy-approved host path
4. Every promotion is audit-logged. No promote → no host state mutation beyond
   what the mount itself touched.

## 7. Browser testing (visual QA — browser-harness + Jev)

**Topology — browser in the cage, brains on the host, one CDP wire:**

```
main agent ──dispatch──> qa-visual subagent (pi instance — HOST process)
                           │
                           ├── browser-harness (Python, host-side, uv-managed)
                           │     └── CDP  ws://localhost:9222
                           ├── Jev judgments (TypeSafe JS SDK, host-side)
                           │     └── natural language + page state → {value, confidence}
                           └── LLM API keys — HOST ONLY, never in the sandbox
                                       │  (only this wire crosses the boundary)
                                       ▼
     ┌──────────── sandbox: `browser-test` profile ────────────┐
     │  Chromium --remote-debugging-port=9222 (software GL)    │
     │  site under test (dev server, localhost-in-VM)          │
     │  /workspace rw mount — site code + artifacts/           │
     └──────────────────────────────────────────────────────────┘
```

- **browser-harness** (browser-use, Python) is the interaction layer: connects to the
  in-VM browser over one CDP websocket and self-heals — the agent writes its own
  missing helpers into a per-task workspace (kept under the consumer's project dir,
  NEVER shared, NEVER inside the sandbox).
- **Jev (TypeSafe System One)** is the judgment layer: typed verdicts with
  confidence for assertions/routing/extraction. Threshold policy: **below 0.8 →
  inconclusive, never silently pass**; escalation = re-ask with screenshot attached.
- **Screenshots stay first-class evidence**: PNG per navigation/major action into
  `/workspace/artifacts/` via CDP — human evidence + Jev visual grounding. The
  vision model is an occasional tool, not the loop's engine (the loop is
  DOM/harness-driven).
- `browser-test` profile: `chromium-cdp` image, publishes exactly one port
  (9222 → 9222, host-local), sealed net by default (staging URLs via `allow_hosts`),
  rw workspace mount, no SSH agent. CDP exposure is host-local — anything on the
  host can drive that browser; acceptable single-user, documented.
- `chromium-cdp` image: node26-dev base + Chromium + fonts + a wrapper that starts
  headless Chromium with CDP on 9222 (`--no-sandbox` — the VM is the sandbox;
  `--disable-gpu` software rendering; `--disable-dev-shm-usage`). No Playwright,
  no Python in-guest — the image stays lean.
- **Verify-first points** (Phase 1 lesson): smolvm inbound port publishing
  (fallback: `--net-backend virtio-net`) and browser-harness's real invocation
  shape — both get a research spike before adapter code is written.
- **Rendering:** software rendering for launch. GPU (virtio-gpu/Venus) stays a
  Phase 3 option for WebGL/visual-fidelity testing.

## 8. Baked images (Smolfiles)

Images are declared as smolvm Smolfiles in `images/`, built and packed with
`smolvm pack create`, versioned like code:

- `node26-dev` (Phase 1) — Node 26, pnpm, git, build essentials; deps pre-warmed
- `chromium-cdp` (Phase 2) — node26-dev + Chromium + fonts + CDP launch wrapper
  (Chromium boots with `--remote-debugging-port=9222`); no Playwright/Python
  in-guest — browser-harness runs host-side (spec §7)
- `alpine3` (Phase 1, operational) — minimal netless base for the `untrusted`
  profile (smolvm refuses netless registry pulls by design)

Registry: ghcr.io/gulaneskorp (push optional; local `.smolmachine` packs are
sufficient for single-host operation).

## 9. API v1

```
POST   /sandboxes              {profile, mode?, ttl?, project?, count?}
                               # `project` fills the profile's {project} mount
                               # placeholder; requests CANNOT add mounts
POST   /sandboxes/:id/exec     {cmd, env?}         → streamed output
GET    /sandboxes/:id          status + resource stats
POST   /sandboxes/:id/promote  {artifacts | diff}  → policy-checked extraction
DELETE /sandboxes/:id
GET    /profiles               list available profiles
GET    /audit                  audit log query
GET    /healthz
```

Auth: bearer token (generated at first daemon start, stored user-private).
Transport: localhost HTTP only in v1.

## 10. Tech stack

- **Runtime:** Node 26 + TypeScript (matches host v26.8 and platform siblings LaPis/PiSubagent)
- **HTTP:** Fastify
- **State:** better-sqlite3 (sync, zero-dep-daemon, WAL mode)
- **Validation:** zod (profile + request schemas)
- **VM backend:** smolvm CLI (installed user-level, no sudo)
- **Tests:** vitest, ≥80% coverage gate (platform convention)
- **Architecture guard:** dependency-cruiser (enforces `server → core → ports ← adapters`)

## 11. Repo layout

```
PiSandboxed/
├── src/
│   ├── core/            # SandboxService + event bus — depends ONLY on ports
│   │   ├── ports.ts     # IsolationBackend · ModeManager · ProfileRegistry ·
│   │   │                # SandboxRepo · AuditRepo · ArtifactExtractor
│   │   └── sandbox-service.ts
│   ├── adapters/
│   │   ├── smolvm/      # implements IsolationBackend (only CLI spawner)
│   │   ├── sqlite/      # implements SandboxRepo + AuditRepo + audit event sink
│   │   └── profiles/    # implements ProfileRegistry (builtin + user TOML)
│   ├── modes/           # implements ModeManager: ephemeral.ts (pool/persistent later)
│   ├── promote/         # ArtifactExtractor strategies (diff, artifacts)
│   ├── server/          # fastify routes, auth, SSE — thin HTTP↔core mapping
│   └── cli/             # `sand` — thin HTTP client
├── profiles/            # built-in, immutable (untrusted, dev, build, browser-test)
├── profiles.user/       # local additions (gitignored)
├── images/              # Smolfiles: node26-dev, chromium-playwright
├── test/                # unit + integration (fake subagent E2E)
└── docs/
```

## 12. Phasing

- **Phase 1 (MVP):** ports + core service + event bus first, then ephemeral
  mode, Policy Engine (profile validation lives in `adapters/profiles/` + core
  gate), promote extractors (diff + artifacts — small, completes the
  change-testing story early), `sand` CLI, SQLite repos + audit sink; profiles
  `untrusted`/`dev`/`build`; baked `node26-dev` image; dependency-cruiser rule
  active from the first commit; one end-to-end integration test simulating a
  PiSubagent task.
- **Phase 2:** visual QA via browser-harness + Jev (spec §7): `chromium-cdp`
  image + `browser-test` profile (CDP port 9222) + `qa/` module
  (harness.ts / jev.ts / report.ts) + example qa-visual agent + gated E2E.
  Verify-first spikes: smolvm port publishing, browser-harness invocation.
- **Phase 3:** `pooled` mode (branch fan-out + warm-pool manager); `persistent`
  mode + TTL reaper; GPU/WebGL profile; python/headless-browser image variants;
  metrics.

## 13. Host prerequisites (verified 2026-09-22)

| Requirement | Status |
|---|---|
| Linux x86_64 + KVM | ✓ CachyOS, kernel 7.2.5, `/dev/kvm` writable |
| CPU/RAM/Disk | ✓ 16 cores / 30 GB / 342 GB free |
| Node 26 | ✓ host runs v26.8.2 |
| smolvm install (user-level) | pending — Phase 1 task 1 (no sudo required) |
| Docker (for building base rootfs if needed) | ✓ present |
| sudo | ✗ not available — all installs must be user-level |

## 14. Security statement (honest bounds)

The VM boundary is real: hardware-virtualized, per-workload guest kernel,
network deny-by-default, hypervisor-enforced host filesystem separation. But
sandboxd and smolvm run as the invoking user — this is **single-user service
isolation**, not protection against the host account being compromised. Every
capability a profile grants (mounts, egress, SSH agent) becomes part of that
sandbox's authority; the audit log is the accountability layer. Carried from
smolvm's own security model documentation.

## 15. Open questions (non-blocking)

1. ghcr push vs local-only packs for images — defer to Phase 1 end (local-only is sufficient).
2. PiSubagent client SDK (typed JS wrapper) — likely a small Phase 2 package; PiSubagent can start with `fetch` + the REST API.
3. Audit log retention window — default keep-forever on 342 GB disk; revisit if size becomes real.
