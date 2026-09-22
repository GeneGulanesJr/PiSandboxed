import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { ProfileRegistryImpl } from '../../src/adapters/profiles/registry.js';
import { SmolvmBackend } from '../../src/adapters/smolvm/backend.js';
import { EphemeralMode } from '../../src/modes/ephemeral.js';
import { SandboxService } from '../../src/core/sandbox-service.js';
import { openStore } from '../../src/adapters/sqlite/store.js';
import { runHarnessTask } from '../../qa/harness.js';
import { writeReport } from '../../qa/report.js';

const smolvmBin = process.env.SMOLVM_BIN ?? join(homedir(), '.local/bin/smolvm');
const enabled = process.env.RUN_VM_TESTS === '1' && existsSync(smolvmBin)
  && existsSync(join(homedir(), '.pisandboxed/images/chromium-cdp.smolmachine'));

// project dirs MUST live under ~/Documents (profiles template root) — absolute
// paths are used verbatim by the {project} expansion (Phase 1 fix), but the
// template prefix is the sanctioned root for QA scratch projects.
const project = enabled ? mkdtempSync(join(homedir(), 'Documents', 'pisand-qa-')) : '';
if (enabled) cpSync(resolve('qa/demo-site'), join(project, 'demo-site'), { recursive: true });
// additive override-profiles dir (only populated when host 9222 is squatted);
// when disabled, point at a guaranteed-missing dir so the registry scan is a no-op
const overrideDir = enabled ? join(project, 'profiles-qa') : join(tmpdir(), 'pisand-qa-missing-profiles');

/** true if 127.0.0.1:port is bindable right now (i.e. free) */
function canBind(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

async function allocateHostPort(): Promise<number> {
  if (await canBind(9222)) return 9222; // clean environment → canonical port
  for (let p = 19222; p < 19272; p++) {
    if (await canBind(p)) {
      console.log(`[e2e] host 127.0.0.1:9222 occupied (e.g. by another CDP publisher) — falling back to published port ${p}`);
      return p;
    }
  }
  throw new Error('no free host port in 19222..19271 for CDP publish');
}

// In-guest static server: the image is alpine node26 — NO python3 — so the site
// is served by a dependency-free node one-liner written to tmpfs (guest /tmp).
const SERVE_SCRIPT = [
  'cat > /tmp/serve.js <<\'EOF\'',
  "const h = require('http'), f = require('fs');",
  "h.createServer((q, s) => { s.end(f.readFileSync('/workspace/demo-site/index.html')); }).listen(8080, () => console.log('site up'));",
  'EOF',
  'cd /workspace/demo-site && nohup node /tmp/serve.js >/tmp/site.log 2>&1 &',
  'for i in 1 2 3 4 5 6 7 8 9 10; do wget -q -T 2 -O /tmp/page.html http://127.0.0.1:8080/ && break; sleep 1; done',
  'head -c 40 /tmp/page.html',
].join('\n');

describe.skipIf(!enabled)('E2E: visual QA loop (browser-test + CDP + harness + report)', { timeout: 300_000 }, () => {
  const store = openStore(join(project, 'state.db'));
  const registry = new ProfileRegistryImpl([overrideDir, resolve('profiles')]);
  const backend = new SmolvmBackend({ binPath: smolvmBin });
  const modes = new Map([['ephemeral', new EphemeralMode(backend, store.sandboxes)]]);
  const svc = new SandboxService({ registry, modes, bus: { emit() {}, on() { return () => {}; } } as never });
  let sandboxId = '';
  const artifacts = join(project, 'artifacts');

  // guest-side CDP is always 9222 (socat 9222→9223 baked into the pack); the
  // HOST-side publish port adapts: 9222 when free, otherwise an override profile
  // (byte-identical copy of browser-test.toml, different name — the registry
  // fails closed on shadowing by design) publishing <free>:9222.
  let hostPort = 9222;
  let profileName = 'browser-test';

  beforeAll(async () => {
    if (!enabled) return;
    hostPort = await allocateHostPort();
    if (hostPort !== 9222) {
      const base = readFileSync(resolve('profiles/browser-test.toml'), 'utf8');
      const patched = base.replace('ports = ["9222:9222"]', `ports = ["${hostPort}:9222"]`);
      if (patched === base) throw new Error('profiles/browser-test.toml ports line changed — override patch is stale');
      mkdirSync(overrideDir, { recursive: true });
      writeFileSync(join(overrideDir, 'browser-test-qa.toml'), patched);
      profileName = 'browser-test-qa';
      console.log(`[e2e] registered override profile '${profileName}' (ports ${hostPort}:9222)`);
    }
  });

  afterAll(async () => {
    if (sandboxId) await svc.destroy(sandboxId).catch(() => {});
    store.close();
    // keep project dir for debugging unless clean
    if (process.env.QA_KEEP !== '1') rmSync(project, { recursive: true, force: true });
    else console.log('[e2e] QA_KEEP=1 — artifacts kept at', artifacts);
  });

  it('boots browser-test, serves the site in-guest, CDP reachable in-guest, egress sealed', async () => {
    const info = await svc.create({ profile: profileName, mode: 'ephemeral', project });
    sandboxId = info.id;
    expect(info.state).toBe('running');

    // site up in-guest
    const site = await svc.exec(sandboxId, { cmd: ['sh', '-c', SERVE_SCRIPT] });
    expect(site.stdout).toContain('<!DOCTYPE html');

    // chromium up in-guest (CDP wrapper baked into the pack: socat 9222→9223)
    const cdp = await svc.exec(sandboxId, { cmd: ['sh', '-c', [
      'nohup /opt/cdp/start-chromium.sh >/tmp/chrome.log 2>&1 &',
      'for i in $(seq 1 20); do wget -q -T 2 -O /tmp/cdp.json http://127.0.0.1:9222/json/version && break; sleep 1; done',
      'cat /tmp/cdp.json',
    ].join('\n')] });
    console.log('[e2e] in-guest CDP /json/version:', cdp.stdout.trim());
    expect(cdp.stdout).toContain('"Browser"');

    // sealed-egress re-proof (regression): outbound-localhost-only seal live on port VMs
    const seal = await svc.exec(sandboxId, { cmd: ['sh', '-c', 'wget -q -T 3 -O /dev/null https://example.com; echo exit=$?'] });
    expect(seal.stdout).toContain('exit=1');
  }, 300_000);

  it('host reaches CDP through the published port and drives a tab', async () => {
    const res = await fetch(`http://127.0.0.1:${hostPort}/json/version`);
    expect(res.ok).toBe(true);
    const j = await res.json() as { Browser: string };
    expect(j.Browser).toContain('Chrome');
    console.log('[e2e] host-side CDP /json/version:', JSON.stringify(j));

    // open a tab pointed at the in-VM site (host CDP → guest browser).
    // Chrome 111+ requires PUT for /json/new (GET is rejected with 405).
    const tab = await fetch(`http://127.0.0.1:${hostPort}/json/new?http://127.0.0.1:8080/`, { method: 'PUT' });
    expect(tab.ok).toBe(true);
  }, 120_000);

  it('harness task runs against the in-VM browser and report lands on host', async () => {
    const workspace = join(project, 'qa-workspace');
    const harness = await runHarnessTask({
      cdpUrl: `http://127.0.0.1:${hostPort}`,
      task: [
        'new_tab("http://127.0.0.1:8080/")',
        'wait_for_load()',
        'info = page_info()',
        'print("PAGE_TITLE:", info.get("title", ""))',
        'print("HAS_LOGIN:", "login-form" in str(js("return document.body.innerHTML")))',
      ].join('\n'),
      workspaceDir: workspace,
      // per-run daemon isolation: BH keeps sockets/state under BH_HOME and a
      // live daemon ignores later BU_CDP_URL changes (browser-harness notes §5/§7.1)
      extraEnv: { BH_HOME: join(project, '.bh-home') },
    });
    expect(harness.ok, harness.transcript + harness.error).toBe(true);
    console.log('[e2e] harness transcript:\n' + harness.transcript);
    expect(harness.transcript).toContain('PAGE_TITLE:');
    expect(harness.transcript).toContain('HAS_LOGIN: True');

    const report = writeReport({
      sandboxId, url: 'http://127.0.0.1:8080/',
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      checks: [{ name: 'site reachable via harness', verdict: { value: harness.ok, confidence: 1, inconclusive: false, raw: {} }, screenshots: [], detail: harness.transcript.slice(0, 400) }],
      harnessTranscript: harness.transcript,
    }, artifacts);
    expect(existsSync(report.markdownPath)).toBe(true);
    const md = readFileSync(report.markdownPath, 'utf8');
    console.log('[e2e] report.md excerpt:\n' + md.split('\n').slice(0, 12).join('\n'));
    expect(md).toContain('1/1 passed');
    expect(existsSync(report.jsonPath)).toBe(true);
  }, 300_000);
});
