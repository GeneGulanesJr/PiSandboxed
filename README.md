# PiSandboxed

Sandboxing & security service of the GulanesKorp agent platform
(LaPis = memory · PiSubagent = orchestration · **PiSandboxed = isolated execution**).

A localhost microservice that gives agents hardware-isolated **smolvm microVMs**
(libkrun + KVM, <200ms boot) to run untrusted code, fan out parallel work, test
changes inside a real VM, and drive visual QA — with **policy profiles** that
requests can pick but never override, and a **promote-only escape hatch**:
nothing a subagent does inside a sandbox touches the host outside
policy-approved paths, and results reach the host only via explicit, audit-logged
promotion.

## Quickstart

```sh
npm i
npm run build
SANDD_PORT=7391 npm run sandd      # 7331 is squatted on this box — use 7391
```

The daemon bootstraps a bearer token at `~/.pisandboxed/token` (mode 0600) on
first start. The `sand` CLI reads it automatically:

```sh
sand profiles                                   # list profiles
ID=$(sand create --profile dev --project myproj)  # boots pack:node26-dev VM
sand exec $ID node --version                    # v26.9.0 inside the VM
sand status $ID                                 # state + expiry
sand rm $ID                                     # destroy
sand audit -n 20                                # audit log tail
```

(`SAND_URL` overrides the base URL; default `http://127.0.0.1:7331` — set
`SAND_URL=http://127.0.0.1:7391` when using the port above.)

## Profiles

Builtin profiles are immutable TOML in `profiles/`; user additions go in
`profiles.user/` (gitignored). Requests pick a profile by name and cannot add
mounts, egress, or secrets. Images: `pack:` names resolve to
`$SMOLVM_IMAGES_DIR/<name>.smolmachine` (default `~/.pisandboxed/images`),
booted fully offline via `smolvm --from`.

| Profile | Image | Net | Mounts | Secrets | Resources | TTL |
|---|---|---|---|---|---|---|
| `untrusted` | `pack:alpine3` | sealed | RO `/workspace` | none | 2 cpu / 2 GB | 10m |
| `dev` | `pack:node26-dev` | allowlist (registry.npmjs.org, github.com) | rw `/workspace` | none | 4 cpu / 8 GB | 30m |
| `build` | `pack:node26-dev` | allowlist (github.com, registry.npmjs.org) | rw `/workspace` | SSH agent | 4 cpu / 8 GB | 1h |

Rebuild packs with `images/build-image.sh <name>` (Smolfiles in `images/`).

## API v1

Auth: bearer token, localhost only.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sandboxes` | `{profile, mode?, ttlMs?, project?}` — `project` fills the profile's `{project}` mount placeholder; requests cannot add mounts |
| `POST` | `/sandboxes/:id/exec` | `{cmd, env?}` → streamed output (SSE) |
| `GET` | `/sandboxes/:id` | status + expiry |
| `POST` | `/sandboxes/:id/promote` | `{kind: diff\|artifacts, params?}` — policy-checked extraction to the host |
| `DELETE` | `/sandboxes/:id` | destroy |
| `GET` | `/profiles` | list profiles |
| `GET` | `/audit?limit=` | audit log query |
| `GET` | `/healthz` | liveness (no auth) |

## Security statement (spec §14, verbatim)

> The VM boundary is real: hardware-virtualized, per-workload guest kernel,
> network deny-by-default, hypervisor-enforced host filesystem separation. But
> sandboxd and smolvm run as the invoking user — this is **single-user service
> isolation**, not protection against the host account being compromised. Every
> capability a profile grants (mounts, egress, SSH agent) becomes part of that
> sandbox's authority; the audit log is the accountability layer. Carried from
> smolvm's own security model documentation.

## For PiSubagent consumers

No SDK needed — `fetch` against localhost with the bearer token
(`~/.pisandboxed/token`):

```js
import { readFileSync } from 'node:fs';
const token = readFileSync(`${process.env.HOME}/.pisandboxed/token`, 'utf8').trim();
const api = 'http://127.0.0.1:7391';
const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

// 1. create — attach the subagent's project (fills the {project} mount)
const { id } = await fetch(`${api}/sandboxes`, { method: 'POST', headers: h,
  body: JSON.stringify({ profile: 'dev', mode: 'ephemeral', project: 'myproj' }),
}).then(r => r.json());

// 2. exec — run the task inside the VM (SSE stream; result frame has exitCode)
const res = await fetch(`${api}/sandboxes/${id}/exec`, { method: 'POST', headers: h,
  body: JSON.stringify({ cmd: ['npm', 'test'] }) });
const frames = (await res.text()).split('\n\n')
  .map(f => f.replace(/^data: /, '')).filter(f => f && f !== '[DONE]').map(JSON.parse);

// 3. promote — the ONLY way results mutate the host (audit-logged)
await fetch(`${api}/sandboxes/${id}/promote`, { method: 'POST', headers: h,
  body: JSON.stringify({ kind: 'diff' }) });
await fetch(`${api}/sandboxes/${id}`, { method: 'DELETE', headers: h });
```

## Development

```sh
npm run typecheck && npm test && npm run cruise   # hermetic unit gates
npm run test:vm                                   # real-VM E2E (needs smolvm + KVM;
                                                  # RUN_VM_TESTS=1 vitest run test/integration)
```

See `docs/superpowers/specs/` for the full design and `docs/smolvm-cli-reference.md`
for the captured smolvm 1.17.0 semantics (pack booting, egress model, RO mounts).

## Visual QA (Phase 2)

Hardware-isolated browser testing: real Chromium runs **inside the VM**; the
browser-harness, the Jev judgment calls, and the report stay **host-side** —
LLM/API keys never enter the sandbox.

```text
 subagent (host) — agents/qa-visual.md            TYPE_SAFE_API_KEY lives here
   │ sand create/exec/rm        └─ browser-harness (stdin python tasks)
   │                               qa/harness.ts · qa/jev.ts · qa/report.ts
   │                                      │ BU_CDP_URL=http://127.0.0.1:9222
   ▼                                      ▼ (CDP wire, published port)
 ┌─ smolvm microVM — pack:chromium-cdp ────────────────┐
 │  node static server :8080     headless Chromium     │
 │                               CDP :9222 (socat→9223)│
 └─────────────────────────────────────────────────────┘
```

Host prereqs: `uv`, then the QA venv (see `docs/browser-harness-notes.md`):

```sh
uv venv .venv-qa && uv pip install --python .venv-qa/bin/python -r qa/requirements.txt
# TYPE_SAFE_API_KEY optional — unset ⇒ Jev verdicts are INCONCLUSIVE, never errors
```

Quickstart (full loop + hard rules: `agents/qa-visual.md`):

```sh
PROJ=$HOME/Documents/qa-demo; cp -r qa/demo-site "$PROJ/"
ID=$(SAND_URL=http://127.0.0.1:7391 node bin/sand.mjs create --profile browser-test --project "$PROJ")
node bin/sand.mjs exec $ID -- sh -c 'printf "%s\n" \
  "const h=require(\"http\"),f=require(\"fs\");" \
  "h.createServer((q,s)=>s.end(f.readFileSync(\"/workspace/demo-site/index.html\"))).listen(8080);" \
  > /tmp/serve.js; cd /workspace/demo-site \
  && nohup node /tmp/serve.js >/tmp/site.log 2>&1 & sleep 1; \
  wget -q -T 2 -O - http://127.0.0.1:8080/ | head -c 15'
node bin/sand.mjs exec $ID -- sh -c 'nohup /opt/cdp/start-chromium.sh >/tmp/chrome.log 2>&1 & sleep 4; \
  wget -q -O - http://127.0.0.1:9222/json/version'
npx tsx qa-run.ts        # runHarnessTask({cdpUrl: 'http://127.0.0.1:9222', ...})
                         # → jev.verify(...) per checkpoint → writeReport(artifacts)
node bin/sand.mjs rm $ID && smolvm machine list   # ALWAYS — even on failure
```

`qa-run.ts` (the snippet runner — `artifacts/` + `report.{json,md}` land under
`$PROJ` via the rw mount):

```ts
import { runHarnessTask } from './qa/harness.js';
import { makeJev } from './qa/jev.js';
import { writeReport } from './qa/report.js';
const jev = makeJev();
const h = await runHarnessTask({ cdpUrl: 'http://127.0.0.1:9222',
  task: 'new_tab("http://127.0.0.1:8080/")\nwait_for_load()\nprint(page_info())',
  workspaceDir: `${process.env.PROJ}/qa-workspace` });
const verdict = await jev.verify('Does the page state show the demo app loaded?',
  { transcript: h.transcript });
writeReport({ sandboxId: process.env.ID!, url: 'http://127.0.0.1:8080/',
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  checks: [{ name: 'demo loads', verdict, screenshots: [], detail: h.transcript.slice(0, 400) }],
  harnessTranscript: h.transcript }, `${process.env.PROJ}/artifacts`);
```

Sealing: a profile with `ports` (here `9222:9222`) is forced onto the
virtio-net stack with **outbound-localhost-only** egress, and
`browser-test` allowlists no hosts — in-VM URLs only. Sealed egress is
re-proven by the E2E gate (`test/integration/visual-qa.e2e.test.ts` asserts
an in-guest `wget https://example.com` fails while host→guest CDP over the
published port works).
