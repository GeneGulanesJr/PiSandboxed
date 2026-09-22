import { describe, expect, it, vi } from 'vitest';
import { makeJev } from '../qa/jev.js';

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

// Documented TypeSafe response shape (https://docs.typesafe.ai/api.md):
//   { model, answers: { <questionId>: <answer> }, usage }
//     noul   → { type: 'noul', noul: <P(yes) 0..1> }                      (no confidence field)
//     choice → { type: 'choice', choice, probabilities, confidence }      (confidence 0..1)
const noulBody = (noul: number) => ({
  model: 'jev-1.13.0',
  answers: { verdict: { type: 'noul', noul } },
  usage: { input_tokens: 296, output_tokens: 20 },
});
const choiceBody = (choice: string, confidence: number) => ({
  model: 'jev-1.13.0',
  answers: {
    verdict: { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
});

describe('makeJev', () => {
  it('sends question + state to the systemone endpoint with auth header, parses the documented answer shape', async () => {
    const body = noulBody(0.93);
    const fetch = vi.fn(ok(body));
    const jev = makeJev({ apiKey: 'k1', fetch });
    const v = await jev.verify('does the page show a login form?', { title: 'Sign in', hasForm: true });
    expect(v).toEqual({ value: true, confidence: 0.93, inconclusive: false, raw: body });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k1');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      model: 'jev-latest',
      state: { title: 'Sign in', hasForm: true },
      questions: { verdict: { type: 'noul', instructions: 'does the page show a login form?' } },
    });
  });

  it('defaults to TYPE_SAFE_API_KEY env when no apiKey option', async () => {
    process.env.TYPE_SAFE_API_KEY = 'envkey';
    const fetch = vi.fn(ok(noulBody(0.1)));
    const jev = makeJev({ fetch });
    const v = await jev.verify('q', {});
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer envkey');
    // confident NO: value false, confidence max(0.1, 0.9) — NOT inconclusive
    expect(v).toMatchObject({ value: false, confidence: 0.9, inconclusive: false });
    delete process.env.TYPE_SAFE_API_KEY;
  });

  it('missing key → inconclusive without calling fetch', async () => {
    const saved = process.env.TYPE_SAFE_API_KEY;
    delete process.env.TYPE_SAFE_API_KEY;
    const fetch = vi.fn();
    const jev = makeJev({ fetch });
    const v = await jev.verify('q', { x: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(v).toEqual({ value: false, confidence: 0, inconclusive: true, raw: { reason: 'missing api key' } });
    if (saved !== undefined) process.env.TYPE_SAFE_API_KEY = saved;
  });

  it('confidence below threshold → inconclusive (raw value preserved)', async () => {
    const fetch = vi.fn(ok(noulBody(0.5)));
    const jev = makeJev({ apiKey: 'k', threshold: 0.8, fetch });
    const v = await jev.verify('q', {});
    expect(v.inconclusive).toBe(true);
    expect(v.value).toBe(true); // raw value preserved, flagged inconclusive
    expect(v.confidence).toBe(0.5);
  });

  it('API error → inconclusive with error preserved, never throws', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const jev = makeJev({ apiKey: 'k', fetch });
    const v = await jev.verify('q', {});
    expect(v.inconclusive).toBe(true);
    expect(JSON.stringify(v.raw)).toContain('ECONNREFUSED');
  });

  it('choose maps the verdict onto the provided options; unknown → inconclusive', async () => {
    const fetchA = vi.fn(ok(choiceBody('dashboard', 0.91)));
    const jevA = makeJev({ apiKey: 'k', fetch: fetchA });
    const c1 = await jevA.choose('which page is this?', ['login', 'dashboard'], { title: 'Dash' });
    expect(c1).toMatchObject({ value: 'dashboard', confidence: 0.91, inconclusive: false });
    const [urlA, initA] = fetchA.mock.calls[0] as unknown as [string, RequestInit];
    expect(urlA).toBe('https://api.typesafe.ai/v1/systemone');
    const sentA = JSON.parse(initA.body as string);
    expect(sentA.questions.verdict).toMatchObject({ type: 'choice', instructions: 'which page is this?' });
    expect(sentA.questions.verdict.criteria).toEqual({ login: null, dashboard: null });

    const fetchB = vi.fn(ok(choiceBody('wizard-of-oz', 0.99)));
    const jevB = makeJev({ apiKey: 'k', fetch: fetchB });
    const c2 = await jevB.choose('which page is this?', ['login', 'dashboard'], {});
    expect(c2.inconclusive).toBe(true);
    expect(c2.value).toBe(false); // fail-inconclusive never fabricates membership
  });
});
