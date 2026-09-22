// Diagnostic: does state richness move the positive Jev verdict?
import { writeFileSync } from 'node:fs';
import { runHarnessTask } from '../qa/harness.js';
import { makeJev } from '../qa/jev.js';

const r = await runHarnessTask({
  cdpUrl: 'http://127.0.0.1:9222',
  workspaceDir: '/home/genegulanesjr/Documents/sand-jev-live-g3Ndge/qa-workspace',
  extraEnv: { BH_HOME: '/tmp/bh-home-jev-live' },
  task: `
rich = js("(() => { const d=document.getElementById('dashboard'); const l=document.getElementById('login-screen'); const h=d.querySelector('h1'); const p=d.querySelector('p'); const lo=document.getElementById('logout-btn'); const em=document.getElementById('email'); return JSON.stringify({url: location.href, title: document.title, dashboardVisible: !d.hidden, h1: h ? h.textContent : null, welcomeText: p ? p.textContent : null, logoutButtonVisible: !!lo && !lo.hidden, loginScreenHidden: !!l.hidden, emailFieldStillVisible: !!em && !em.hidden}); })()")
print("RICH_STATE:", rich)
`,
});
const m = r.transcript.match(/RICH_STATE: (\{.*\})/);
if (!m) {
  console.log('RICH_STATE_FAILED:', r.error ?? r.transcript);
  process.exit(1);
}
const rich = JSON.parse(m[1]);
console.log('RICH_STATE:', JSON.stringify(rich));

const jev = makeJev();
const positiveRich = await jev.verify('is the user logged in and viewing a dashboard?', rich);
console.log('JEV_POSITIVE_RICH:', JSON.stringify({
  value: positiveRich.value,
  confidence: positiveRich.confidence,
  inconclusive: positiveRich.inconclusive,
  answer: (positiveRich.raw as { answers?: Record<string, unknown> })?.answers?.verdict,
  usage: (positiveRich.raw as { usage?: unknown })?.usage,
}));
writeFileSync(new URL('./rich-verdict.json', import.meta.url), JSON.stringify({ rich, positiveRich }, null, 2));
console.log('SAVED');
