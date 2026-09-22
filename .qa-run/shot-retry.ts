// Screenshot-only retry to capture the full error verbatim.
import { runHarnessTask } from '../qa/harness.js';

const result = await runHarnessTask({
  cdpUrl: 'http://127.0.0.1:9222',
  workspaceDir: '/home/genegulanesjr/Documents/sand-jev-live-g3Ndge/qa-workspace',
  extraEnv: { BH_HOME: '/tmp/bh-home-jev-live' },
  task: `
print("PAGE_INFO:", page_info())
HOST_ART = '/home/genegulanesjr/Documents/sand-jev-live-g3Ndge/artifacts'
os.makedirs(HOST_ART, exist_ok=True)
print("DIR_LISTING:", os.listdir(HOST_ART))
shot = capture_screenshot(HOST_ART + '/a-dashboard.png')
print("SHOT_RET:", repr(shot)[:200])
print("SCREENSHOT_PATH:", HOST_ART + '/a-dashboard.png')
print("SCREENSHOT_SIZE:", os.path.getsize(HOST_ART + '/a-dashboard.png'))
`,
});

console.log('OK:', result.ok);
if (result.error) console.log('ERROR:', result.error);
console.log('---TRANSCRIPT-BEGIN---');
console.log(result.transcript);
console.log('---TRANSCRIPT-END---');
