/**
 * QA report artifact writer — the durable output of a QA run.
 *
 * Consumed by:
 *   - E2E gate (Task 7): parses report.json to pass/fail the promotion flow.
 *   - qa-visual agent (Task 8): reads report.md for the human-readable trail.
 *
 * Verdict semantics come from qa/jev.ts: `inconclusive` beats `value` when
 * classifying, so low-confidence judgments stay visible instead of masquerading
 * as hard failures (or worse, silent passes).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Verdict } from './jev.js';

export interface CheckResult {
  name: string;
  verdict: Verdict;
  screenshots: string[];
  /** Optional free-text observation from the harness/agent. */
  detail?: string;
}

export interface QaReport {
  sandboxId: string;
  url: string;
  startedAt: string;
  finishedAt: string;
  checks: CheckResult[];
  harnessTranscript: string;
}

export interface ReportPaths {
  jsonPath: string;
  markdownPath: string;
}

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
}

/** Inconclusive wins over the boolean value — never hide uncertainty. */
export function statusOf(verdict: Verdict): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  if (verdict.inconclusive) return 'INCONCLUSIVE';
  return verdict.value === true ? 'PASS' : 'FAIL';
}

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function summarize(report: QaReport): ReportSummary {
  let passed = 0;
  let failed = 0;
  let inconclusive = 0;
  for (const check of report.checks) {
    const status = statusOf(check.verdict);
    if (status === 'PASS') passed++;
    else if (status === 'FAIL') failed++;
    else inconclusive++;
  }
  return { total: report.checks.length, passed, failed, inconclusive };
}

function renderMarkdown(report: QaReport, summary: ReportSummary): string {
  const lines: string[] = [
    '# QA Report',
    '',
    `- **Sandbox:** ${report.sandboxId}`,
    `- **URL:** ${report.url}`,
    `- **Started:** ${report.startedAt}`,
    `- **Finished:** ${report.finishedAt}`,
    '',
    `**Summary:** ${summary.passed}/${summary.total} passed, ${summary.inconclusive} inconclusive`,
    '',
  ];

  if (report.checks.length > 0) {
    lines.push('## Checks', '');
    for (const check of report.checks) {
      lines.push(`### ${check.name}`, '');
      lines.push(`- **Status:** ${statusOf(check.verdict)}`);
      lines.push(`- **Confidence:** ${percent(check.verdict.confidence)}`);
      for (const shot of check.screenshots) {
        lines.push(`- screenshot: ${shot}`);
      }
      if (check.detail !== undefined) {
        lines.push(`- **Detail:** ${check.detail}`);
      }
      lines.push('');
    }
  }

  lines.push('## Harness transcript', '', '```', report.harnessTranscript, '```', '');

  return lines.join('\n');
}

/** Writes `report.json` + `report.md` into artifactsDir (created if missing). */
export function writeReport(report: QaReport, artifactsDir: string): ReportPaths {
  mkdirSync(artifactsDir, { recursive: true });

  const summary = summarize(report);
  const jsonPath = join(artifactsDir, 'report.json');
  const markdownPath = join(artifactsDir, 'report.md');

  writeFileSync(jsonPath, `${JSON.stringify({ ...report, summary }, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderMarkdown(report, summary), 'utf8');

  return { jsonPath, markdownPath };
}
