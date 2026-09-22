# browser-harness — invocation & integration notes (Phase 2 spike, 2026-09-22)

Source of truth for Task 4 (QA harness adapter). Every claim below was verified
by running the actual command on this machine; outputs are verbatim.

- **Package:** `browser-harness` on PyPI — "The simplest, thinnest, and most powerful harness to control your real browser with your agent."
- **Resolved version:** `0.1.13` (latest stable; 15 releases total)
- **Python required:** `>=3.11` (PyPI metadata); installed and verified on **CPython 3.12.13**
- **Repo:** https://github.com/browser-use/browser-harness (`README.md`, `install.md`, `SKILL.md` consulted)

---

## 1. Install (verified)

```sh
# venv into the repo (what this spike used)
cd /home/genegulanesjr/Documents/GulanesKorp/PiSandboxed
uv venv --python 3.12 .venv-qa                 # → "Using CPython 3.12.13"
uv pip install --python .venv-qa/bin/python browser-harness
# → installed browser-harness 0.1.13 (+ websockets, httpx, pillow, ...)

.venv-qa/bin/python -c "import importlib.metadata as m; print(m.version('browser-harness'))"
# → 0.1.13
```

Upstream's canonical install (alternative, user-level tool install):

```sh
uv tool install --python 3.12 --upgrade --force browser-harness
browser-harness skill > <skills-dir>/browser-harness/SKILL.md   # skill registration
```

The `--python 3.12` pin is upstream-recommended ("prevents uv from selecting old
releases that support older Python versions").

## 2. Invocation shape (verified)

**A CLI that executes a Python script from stdin**, with browser helpers
pre-imported into the exec namespace:

```sh
browser-harness <<'PY'
print(page_info())
PY
```

- The daemon **auto-starts** on first call and connects to the running browser.
- `run.py` calls `ensure_daemon()` before `exec` (per SKILL.md).
- Multi-line scripts via heredoc are the documented norm. Exit code reflects
  success/failure (fatal errors → exit 1).
- Subcommands: `--version`, `--doctor` / `doctor [--json] [--require-existing-daemon]`,
  `auth login|status|logout`, `skill`, `recordings [enable|disable|--latest]`,
  `video init|review|export`, `telemetry status`, `--update [-y]`, `--reload`
  (stops the daemon so the next call starts fresh).
- There is also an MCP variant (`browser-harness-mcp`, stdio) — not needed for Task 4.

### 72 pre-imported names (verified via `print(sorted(n for n in dir() if not n.startswith("_")))`)

Task-relevant helpers: `page_info`, `new_tab`, `goto_url`, `js`, `cdp`,
`click_at_xy`, `fill_input`, `type_text`, `press_key`, `dispatch_key`,
`wait_for_element`, `wait_for_load`, `wait_for_network_idle`, `wait`, `scroll`,
`list_tabs`, `switch_tab`, `close_tab`, `current_tab`, `ensure_real_tab`,
`capture_screenshot`, `upload_file`, `http_get`, `ensure_daemon`, `daemon_alive`,
`daemon_browser_kind`, `restart_daemon`, `start_recording`, `stop_recording`,
`start_remote_daemon`, `stop_remote_daemon`, `iframe_target`, `activate_tab`.
Also exposed: `AGENT_WORKSPACE`, `paths`, `ipc`, `json`, `os`, `sys`, `time`, `math`.

`cdp("Domain.method", **params)` gives raw CDP access (e.g.
`cdp("Accessibility.getFullAXTree")["nodes"]`, `cdp("Runtime.evaluate", ...)` via `js(...)`).

## 3. Connecting to an EXISTING browser via CDP (verified — this is the Task 4 path)

Two env vars, per SKILL.md ("do not call mac-approve ... for `BU_CDP_URL`,
`BU_CDP_WS`, or Browser Use Cloud" — the GUI-checkbox/macOS flows never apply here):

- **`BU_CDP_URL`** — HTTP DevTools endpoint; "the daemon resolves it to WebSocket".
- **`BU_CDP_WS`** — the `ws://.../devtools/browser/<id>` URL directly.

### Verified end-to-end (headless Chromium, CDP on 9223)

Browser launch (Playwright-cached chromium, no system chrome on this box):

```sh
~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  --headless=new --remote-debugging-port=9223 --no-sandbox --disable-gpu \
  --user-data-dir=/tmp/spike-profile about:blank &

curl -s http://127.0.0.1:9223/json/version
# → {"Browser":"Chrome/151.0.7922.34", "webSocketDebuggerUrl":"ws://127.0.0.1:9223/devtools/browser/9c60f7c5-..."}
```

Smoke (no LLM, no key, no GUI):

```sh
BH_HOME=/tmp/bh-home BU_CDP_URL=http://127.0.0.1:9223 .venv-qa/bin/browser-harness <<'PY'
print(page_info())
PY
# → {'url': 'about:blank', 'title': '', 'w': 780, 'h': 437, 'sx': 0, 'sy': 0, 'pw': 780, 'ph': 437}
# exit 0
```

`BU_CDP_WS` variant (verified): set `BH_TAB_MARKER=0`, `--reload` the daemon,
then `BU_CDP_WS="ws://127.0.0.1:9223/devtools/browser/<id>"` → same page_info result.

## 4. LLM / API-key requirements (verified: NONE for local CDP runs)

- `browser-harness auth status` with nothing configured:
  `{"status": "missing", "source": null, "path": "/tmp/bh-home/auth.json"}` —
  and every local-CDP command above still worked. The "LLM" in the product story
  is the *outer* coding agent; the harness itself executes plain Python.
- Browser Use Cloud (remote browsers) is the only thing needing auth
  (`auth login` / `BROWSER_USE_API_KEY`) — irrelevant to Task 4.
- **No-LLM smoke path is the documented Fast Path itself:** `print(page_info())`.

## 5. Workspace & state layout (verified)

- State root: `${XDG_CONFIG_HOME:-~/.config}/browser-harness`, overridable via
  **`BH_HOME`** or `BROWSER_HARNESS_HOME`. Contains: `agent-workspace/`,
  `runtime/` (sockets), `tmp/`, `telemetry.json`, `version-cache.json`,
  `auth.json` (when configured).
- **Agent helper files** go in `$BH_AGENT_WORKSPACE/agent_helpers.py`
  (SKILL.md: "Put task-specific helper additions in `$BH_AGENT_WORKSPACE/agent_helpers.py`").
  `BH_AGENT_WORKSPACE` is an env override — verified:
  `BH_AGENT_WORKSPACE=/tmp/spike-helpers` → script saw `AGENT_WORKSPACE = /tmp/spike-helpers`
  (dir auto-created, starts empty; the harness never writes there — the *agent* does).
- **Task 4 should set `BH_HOME` (and optionally `BH_AGENT_WORKSPACE`) per sandbox
  run** to keep daemon sockets and state isolated between VMs.
- Telemetry exists and is on by default (anonymous); `browser-harness telemetry disable`
  opts out. Recordings are **off** on fresh installs (`recordings` shows `(default)`).

## 6. Minimal working example (verbatim commands + output)

```sh
$ BH_HOME=/tmp/bh-home BU_CDP_URL=http://127.0.0.1:9223 .venv-qa/bin/browser-harness <<'PY'
new_tab("https://example.com")
wait_for_load()
info = page_info()
print("TITLE:", info["title"])
print("URL:", info["url"])
PY
TITLE: 🐴 Example Domain
URL: https://example.com/
GOTO_EXIT=0
```

- SKILL.md rule: **first navigation of a task is `new_tab(url)`**, not `goto_url(url)`
  (the daemon keeps the attached tab across CLI invocations).
- 🐴 = the **horse marker** BH appends to tab titles so agents can find their tab.
  Disable with `BH_TAB_MARKER=0` set **before the daemon starts** (verified: with
  the env set + `--reload`, title printed clean: `Example Domain`). **Task 4 must
  set `BH_TAB_MARKER=0` or strip the marker before title assertions.**

## 7. Daemon lifecycle gotchas (verified — critical for Task 4)

1. **`BU_CDP_URL` is read at daemon startup only.** With a live daemon, a later
   invocation with a *different* (even dead) `BU_CDP_URL` **silently reuses the
   old daemon**: pointing at `http://127.0.0.1:59999` while the 9223 daemon lived
   still returned the live page (`page_info: {'url': 'https://example.com/', ...}`, exit 0).
   → After a VM restart (new CDP port or browser relaunch), run
   `browser-harness --reload` (or `restart_daemon()`) before reconnecting.
2. **Dead endpoint + fresh daemon fails closed (good):**
   ```
   browser-harness: fatal: BU_CDP_URL=http://127.0.0.1:59999 unreachable after 30s:
   <urlopen error [Errno 111] Connection refused> -- is the dedicated automation
   Chrome running? Launch it with --remote-debugging-port=<port> --user-data-dir=<dedicated dir>
   ```
   exit 1, after a ~30s retry window. Task 4's timeout must exceed that window or
   pre-check reachability with `curl $BU_CDP_URL/json/version` first.
3. `browser-harness --reload` output: `daemon stopped — will restart fresh on next call`.
4. `doctor --json` (verified): `{"chrome_running": true, "daemon": {"alive": true,
   "browser_ready": true, "name": "default"}, "healthy": true, "install_mode":
   "pypi", "require_existing_daemon": false, "schema_version": 1, "version": "0.1.13"}`.
   With `BH_REQUIRE_EXISTING_DAEMON=1` / `--require-existing-daemon` it "never
   starts or discovers another browser" — the right mode for CI adapters.

## 8. Known gaps / gotchas summary

- Daemon reuse ignores per-invocation `BU_CDP_URL` (gotcha 7.1) — restart daemon on endpoint change.
- 30s unreachable-endpoint retry window before failing closed (7.2).
- Horse marker mutates `page_info()["title"]` unless `BH_TAB_MARKER=0` at daemon start (6).
- The daemon model is **one browser connection per name**; a named/`BU_CDP_URL`
  daemon is a "whole Chrome instance" lane — serialize browser ops or use separate
  daemon names per VM. SKILL.md warns concurrent tab-switching from two agents races.
- `new_tab()` vs `goto_url()` semantics (first nav must be `new_tab`).
- Telemetry on by default; recordings off by default — decide policy for Task 4 and set explicitly.
- macOS-only helpers (`mac-approve`) and the `chrome://inspect` checkbox do NOT
  apply to `BU_CDP_URL`/`BU_CDP_WS` connections — no manual browser-side setup
  is needed for the headless-VM integration path.
- `page_info()` viewport was 780x437 for the default headless run — set the
  viewport explicitly (via CDP `Emulation.setDeviceMetricsOverride` or window
  flags) if Task 4 needs deterministic screenshots.

## 9. Cleanup done after spike

Spike chromium killed (CDP 9223 down), `/tmp/spike-profile`, `/tmp/bh-home`,
`/tmp/spike-helpers` removed. `.venv-qa/` left in the repo root for Task 4
(contains browser-harness 0.1.13; not committed — verify it is gitignored before commit).
