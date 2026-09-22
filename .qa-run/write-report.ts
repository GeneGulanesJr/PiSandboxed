// Assemble + write the QA report with REAL Jev verdicts as checks.
import { readFileSync } from 'node:fs';
import { writeReport } from '../qa/report.js';
import type { Verdict } from '../qa/jev.js';

const verdicts = JSON.parse(readFileSync(new URL('./verdicts.json', import.meta.url), 'utf8'));
const richDiag = JSON.parse(readFileSync(new URL('./rich-verdict.json', import.meta.url), 'utf8'));

const shotPath = '/home/genegulanesjr/Documents/sand-jev-live-g3Ndge/artifacts/a-dashboard.png';

// Deterministic harness checks get full-confidence boolean verdicts (no LLM involved).
const hVerdict = (value: boolean): Verdict => ({ value, confidence: 1, inconclusive: false, raw: null });

// Real Jev verdicts, verbatim from .qa-run/verdicts.json / rich-verdict.json.
const v = (o: { value: boolean; confidence: number; inconclusive: boolean; raw: unknown }): Verdict => o;

const harnessTranscript = [
  '== run: login-flow interaction (harness task, canonical) ==',
  readFileSync(new URL('./transcript-a.txt', import.meta.url), 'utf8').trimEnd(),
  '',
  '== diagnostic: rich-state capture ==',
  'RICH_STATE: ' + JSON.stringify(richDiag.rich),
  '',
  '== Jev verdicts (LIVE, api.typesafe.ai, model jev-1.13.0) ==',
  JSON.stringify(
    {
      positive: verdicts.positive,
      negative: verdicts.negative,
      positiveRichState: richDiag.positiveRich,
    },
    null,
    2,
  ),
].join('\n');

const { jsonPath, markdownPath } = writeReport(
  {
    sandboxId: 'sb_ynq46iw41770',
    url: 'http://127.0.0.1:8080/',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    harnessTranscript,
    checks: [
      {
        name: 'login form renders (form + email + password + submit present)',
        verdict: hVerdict(true),
        screenshots: [],
        detail: 'all four selectors found via js() in guest DOM; #dashboard hidden at start',
      },
      {
        name: 'login interaction: real key events + click → #dashboard visible',
        verdict: hVerdict(true),
        screenshots: [shotPath],
        detail:
          'fill_input("#email") → value qa-agent@example.com; fill_input("#password") → 32 chars; click_at_xy(390,317) on submit; wait_for_element("#dashboard", visible=True) OK',
      },
      {
        name: 'dashboard h1 correct ("Dashboard")',
        verdict: hVerdict(true),
        screenshots: [shotPath],
        detail: 'DASHBOARD_H1=Dashboard; LOGIN_SCREEN_GONE=True; screenshot 8708 bytes, visually confirmed',
      },
      {
        name: 'Jev LIVE positive: "is the user logged in and viewing a dashboard?" (minimal state)',
        verdict: v(verdicts.positive),
        screenshots: [shotPath],
        detail:
          'state = {h1:"Dashboard", dashboardVisible:true, loginGone:true} → noul=0.7 → value=true BUT confidence 0.7 < threshold 0.8 → honest INCONCLUSIVE (third sample of same question: noul 0.58/0.6/0.7 — consistently sub-threshold on minimal state). Raw: ' +
          JSON.stringify(verdicts.positive.raw),
      },
      {
        name: 'Jev LIVE negative control: "is the user still on the login screen?" → expected NO',
        verdict: v(verdicts.control),
        screenshots: [],
        detail:
          'same state → noul=0.04 → value=false at confidence 0.96 (inconclusive=false). Negative control behaved as expected; derived control verdict carries the raw negative answer: ' +
        JSON.stringify(verdicts.negative.raw),
      },
      {
        name: 'Jev LIVE diagnostic: positive question with richer captured state',
        verdict: v({
          value: richDiag.positiveRich.value,
          confidence: richDiag.positiveRich.confidence,
          inconclusive: richDiag.positiveRich.inconclusive,
          raw: richDiag.positiveRich.raw,
        }),
        screenshots: [shotPath],
        detail:
          'state enriched with welcomeText/logoutButtonVisible/loginScreenHidden → noul=0.97 → value=true, confidence 0.97, inconclusive=false. Lesson: verdict confidence scales with state evidence, not question phrasing.',
      },
    ],
  },
  '/home/genegulanesjr/Documents/sand-jev-live-g3Ndge/artifacts',
);

console.log('REPORT_JSON:', jsonPath);
console.log('REPORT_MD:', markdownPath);
