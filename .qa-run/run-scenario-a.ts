// Scenario A runner — login-flow interaction against the sandboxed demo site.
// Prints DASHBOARD state; persists captured page state for the Jev judgment step.
import { writeFileSync } from 'node:fs';
import { runHarnessTask } from '../qa/harness.js';

const result = await runHarnessTask({
  cdpUrl: 'http://127.0.0.1:9222',
  workspaceDir: '/home/genegulanesjr/Documents/sand-jev-live-g3Ndge/qa-workspace',
  extraEnv: { BH_HOME: '/tmp/bh-home-jev-live' },
  task: `
new_tab("http://127.0.0.1:8080/")
wait_for_load()
print("PAGE_INFO:", page_info())

form_state = js("(() => { const f=document.getElementById('login-form'); const e=document.getElementById('email'); const p=document.getElementById('password'); const b=document.querySelector('#login-form button[type=submit]'); const d=document.getElementById('dashboard'); return JSON.stringify({form: !!f, email: !!e, pass: !!p, submit: !!b, dashHiddenAtStart: d.hidden}); })()")
print("FORM_STATE:", form_state)

fill_input("#email", "qa-agent@example.com")
fill_input("#password", "correct-horse-battery-staple-42")
print("EMAIL_VALUE_AFTER_TYPE:", js("document.getElementById('email').value"))
print("PASS_LEN_AFTER_TYPE:", js("document.getElementById('password').value.length"))

xy = js("(() => { const r = document.querySelector('#login-form button[type=submit]').getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}); })()")
print("SUBMIT_XY:", xy)
coords = json.loads(xy)
click_at_xy(coords["x"], coords["y"])

el = wait_for_element("#dashboard", timeout=10.0, visible=True)
print("WAIT_DASHBOARD_VISIBLE_OK:", el is not None)

state = js("(() => { const d=document.getElementById('dashboard'); const l=document.getElementById('login-screen'); const h=d.querySelector('h1'); return JSON.stringify({dashboardVisible: !d.hidden, h1: h ? h.textContent : null, loginGone: !!l.hidden, url: location.href}); })()")
print("DASHBOARD_STATE:", state)
s = json.loads(state)
print("DASHBOARD_VISIBLE:", s["dashboardVisible"])
print("DASHBOARD_H1:", s["h1"])
print("LOGIN_SCREEN_GONE:", s["loginGone"])

# capture_screenshot writes via the HOST harness process; artifacts dir pre-created on host
HOST_ART = '/home/genegulanesjr/Documents/sand-jev-live-g3Ndge/artifacts'
shot = capture_screenshot(HOST_ART + '/a-dashboard.png')
print("SCREENSHOT_PATH:", HOST_ART + '/a-dashboard.png')
print("SCREENSHOT_SIZE:", os.path.getsize(HOST_ART + '/a-dashboard.png'))
`,
});

console.log('OK:', result.ok);
if (result.error) console.log('ERROR:', result.error);
console.log('---TRANSCRIPT-BEGIN---');
console.log(result.transcript);
console.log('---TRANSCRIPT-END---');

// Extract DASHBOARD_STATE for the Jev step
const m = result.transcript.match(/DASHBOARD_STATE: (\{.*\})/);
if (m) {
  const state = JSON.parse(m[1]);
  writeFileSync(new URL('./state.json', import.meta.url), JSON.stringify(state, null, 2));
  console.log('STATE_SAVED:', JSON.stringify(state));
} else {
  console.log('STATE_SAVED: none');
}
writeFileSync(new URL('./transcript-a.txt', import.meta.url), result.transcript);
