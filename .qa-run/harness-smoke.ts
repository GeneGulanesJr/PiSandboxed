// Scenario A runner — Phase A: connectivity smoke + helper-signature introspection.
import { runHarnessTask } from '../qa/harness.js';

const result = await runHarnessTask({
  cdpUrl: 'http://127.0.0.1:9222',
  workspaceDir: '/home/genegulanesjr/Documents/sand-jev-live-g3Ndge/qa-workspace',
  extraEnv: { BH_HOME: '/tmp/bh-home-jev-live' },
  task: `
import inspect
for name in ("new_tab","wait_for_load","fill_input","click_at_xy","wait_for_element","capture_screenshot","js","page_info"):
    fn = globals().get(name)
    try:
        print("SIG", name, inspect.signature(fn))
    except Exception as e:
        print("SIG", name, "ERR", e)
print("PAGE_INFO:", page_info())
`,
});

console.log('OK:', result.ok);
if (result.error) console.log('ERROR:', result.error);
console.log('---TRANSCRIPT-BEGIN---');
console.log(result.transcript);
console.log('---TRANSCRIPT-END---');
