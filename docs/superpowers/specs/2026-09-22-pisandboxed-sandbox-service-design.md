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
┌─────────────────── sandboxd (Node 26 / TypeScript daemon) ──────────────┐
│  REST API          ← single entry point for everything                  │
│  Policy Engine     ← validates every request against a named profile    │
│  Mode Managers     ← ephemeral | pooled | persistent                    │
│  smolvm Adapter    ← spawns smolvm CLI (the ONLY thing that does)       │
│  State Store       ← SQLite (better-sqlite3): sandboxes, tasks, audit   │
└──────────────────────────────────────────────────────────────────────────┘
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

## 7. Browser testing (visual QA)

**Topology — vision loop on host, browser in VM:**

```
main agent ──dispatch──> qa-visual subagent (pi + vision model)  ← stays on HOST
                              │  HTTP
                              ▼
                         sandboxd ──> browser-test sandbox (VM):
                                       ├── dev server (site under test)
                                       ├── headless Chromium + Playwright
                                       └── screenshots → /workspace/artifacts/
                              ▲
        subagent reads screenshots via the host-side mount, looks at them
        with the vision model, exec's the next Playwright command — loop.
```

- Site + browser run in the **same VM** → localhost traffic, zero egress needed
  for local testing. For staging URLs, the profile's `allow_hosts` names the
  staging host (never `*`).
- `browser-test` profile: rw workspace mount, no SSH agent, net allowlist
  localhost-only by default.
- Screenshots are **outputs** (readable via mount) — promote stays reserved for
  **mutating** host state.
- **Rendering:** software-rendering Chromium for launch. GPU (virtio-gpu/Venus)
  requires host `virglrenderer` + Vulkan driver — deferred to Phase 3, only if
  WebGL/visual-fidelity testing is needed.
- Baked image: `chromium-playwright` (Node 26 + Playwright + Chromium + fonts).

## 8. Baked images (Smolfiles)

Images are declared as smolvm Smolfiles in `images/`, built and packed with
`smolvm pack create`, versioned like code:

- `node26-dev` (Phase 1) — Node 26, pnpm, git, build essentials; deps pre-warmed
- `chromium-playwright` (Phase 2) — node26-dev + Playwright + Chromium + fonts

Registry: ghcr.io/gulaneskorp (push optional; local `.smolmachine` packs are
sufficient for single-host operation).

## 9. API v1

```
POST   /sandboxes              {profile, mode?, ttl?, mounts?, count?}
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

## 11. Repo layout

```
PiSandboxed/
├── src/
│   ├── server/       # sandboxd bootstrap, routes, auth
│   ├── policy/       # profile parser, validator, request gate
│   ├── smolvm/       # CLI adapter: spawn, parse, lifecycle, errors
│   ├── modes/        # ephemeral.js, pool.js, persistent.js managers
│   ├── store/        # sqlite schema + repositories
│   └── cli/          # `sand` — thin API client
├── profiles/         # built-in, immutable (untrusted, dev, build, browser-test)
├── profiles.user/    # local overrides (gitignored)
├── images/           # Smolfiles: node26-dev, chromium-playwright
├── test/             # unit + integration (fake subagent E2E)
└── docs/
```

## 12. Phasing

- **Phase 1 (MVP):** sandboxd + ephemeral mode + Policy Engine + `sand` CLI +
  SQLite audit; profiles `untrusted`/`dev`/`build`; baked `node26-dev` image;
  one end-to-end integration test simulating a PiSubagent task.
- **Phase 2:** `browser-test` profile + `chromium-playwright` image + visual QA
  flow; **promote** workflow (completes the "testing changes" pillar).
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
