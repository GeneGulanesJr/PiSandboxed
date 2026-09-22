import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeReport } from '../qa/report.js';
import type { Verdict } from '../qa/jev.js';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('writeReport', () => {
  it('writes parseable JSON and human markdown into artifactsDir', () => {
    dir = mkdtempSync(join(tmpdir(), 'qa-report-'));
    const verdicts: Verdict[] = [
      { value: true, confidence: 0.93, inconclusive: false, raw: {} },
      { value: false, confidence: 0.88, inconclusive: false, raw: {} },
      { value: false, confidence: 0.4, inconclusive: true, raw: { reason: 'low confidence' } },
    ];
    const report = {
      sandboxId: 'sb_rep1', url: 'http://localhost:8080',
      startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:01:30Z',
      checks: [
        { name: 'login form renders', verdict: verdicts[0]!, screenshots: ['shot-1.png'] },
        { name: 'wrong-password shows error', verdict: verdicts[1]!, screenshots: ['shot-2.png'] },
        { name: 'modal is visually centered', verdict: verdicts[2]!, screenshots: ['shot-3.png'] },
      ],
      harnessTranscript: 'TITLE: App\nURL: http://localhost:8080',
    };
    const { jsonPath, markdownPath } = writeReport(report as never, dir);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(parsed.sandboxId).toBe('sb_rep1');
    expect(parsed.checks).toHaveLength(3);

    const md = readFileSync(markdownPath, 'utf8');
    expect(md).toContain('# QA Report');               // title
    expect(md).toContain('sb_rep1');
    expect(md).toContain('login form renders');
    expect(md).toContain('PASS');                      // check 1
    expect(md).toContain('FAIL');                      // check 2
    expect(md).toContain('INCONCLUSIVE');              // check 3
    expect(md).toContain('40%');                       // confidence percent
    expect(md).toContain('shot-1.png');                // screenshot refs
    expect(md).toContain('1/3 passed');                // summary line
    expect(md).toContain('1 inconclusive');
  });

  it('report with zero checks still writes valid files', () => {
    dir = mkdtempSync(join(tmpdir(), 'qa-report-'));
    const { jsonPath, markdownPath } = writeReport({
      sandboxId: 'sb_empty', url: 'http://x', startedAt: 't', finishedAt: 't',
      checks: [], harnessTranscript: '',
    } as never, dir);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8')).checks).toEqual([]);
    expect(readFileSync(markdownPath, 'utf8')).toContain('0/0 passed');
  });
});
