/**
 * Liquid AI Decisions API (System One) typed-judgment client for the QA harness.
 *
 * API (verified 2026-10-16):
 *   POST  https://api.liquid.ai/decisions/v1/systemone
 *       Authorization: Bearer <key>
 *   body  → { state, model: "d1-ultra", questions: { <id>: { type, instructions, criteria? } } }
 *   reply → { model, answers: { <id>: <answer> }, usage: { input_tokens, output_tokens, cost } }
 *     noul   answer → { type: 'noul',   noul: P(yes) 0..1 }                  (no confidence field)
 *     choice answer → { type: 'choice', choice, probabilities, confidence }  (confidence 0..1)
 *   A choice needs at least 2 options (HTTP 422 otherwise); a one-option
 *   choice is answered locally without a request.
 *
 * Policy (the heart of this module): confidence < threshold (default 0.8) →
 * `inconclusive: true`. API errors, missing key, unparseable responses →
 * inconclusive with the raw payload preserved. NEVER throws. Never fabricates
 * a confident answer.
 */

export interface Verdict<T = boolean> {
  value: T;
  confidence: number;
  inconclusive: boolean;
  raw: unknown;
}

export interface DecisionOptions {
  apiKey?: string;    // default: env LIQUID_API_KEY
  endpoint?: string;  // default: https://api.liquid.ai/decisions/v1/systemone
  model?: string;     // default: 'd1-ultra' ('d1' is the other model)
  threshold?: number; // default 0.8
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = 'https://api.liquid.ai/decisions/v1/systemone';
const DEFAULT_MODEL = 'd1-ultra';
const QUESTION_ID = 'verdict';
const DEFAULT_THRESHOLD = 0.8;
/** noul is P(yes); the boolean flips at even odds. */
const BOOL_FLIP_POINT = 0.5;

/** Loose view of the documented answer union (noul | choice | score). */
interface DecisionAnswer {
  type?: unknown;
  noul?: unknown;
  choice?: unknown;
  confidence?: unknown;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Every failure mode funnels through here: dead `false`, confidence 0, raw preserved. */
function fail<T>(raw: unknown): Verdict<T> {
  return { value: false as unknown as T, confidence: 0, inconclusive: true, raw };
}

export function makeDecision(opts: DecisionOptions & { fetch?: FetchLike } = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const doFetch = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? DEFAULT_MODEL;

  /**
   * Single seam for API drift: one place builds the documented request and
   * applies the threshold policy; only `buildQuestion`/`parseAnswer` know the
   * primitive-specific shape. parseAnswer → undefined means unparseable.
   */
  async function judge<T>(
    question: string,
    state: unknown,
    buildQuestion: () => Record<string, unknown>,
    parseAnswer: (answer: DecisionAnswer) => [T, number] | undefined,
  ): Promise<Verdict<T>> {
    const apiKey = opts.apiKey ?? process.env.LIQUID_API_KEY;
    if (!apiKey) return fail<T>({ reason: 'missing api key' });

    let raw: unknown;
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, state, questions: { [QUESTION_ID]: buildQuestion() } }),
      });
      raw = res.ok ? ((await res.json()) as unknown) : { status: res.status, body: await res.text() };
    } catch (err) {
      return fail<T>({ error: (err as Error).message });
    }

    const answer = (raw as { answers?: Record<string, DecisionAnswer> } | null)?.answers?.[QUESTION_ID];
    if (!answer) return fail<T>(raw);

    const parsed = parseAnswer(answer);
    if (!parsed) return fail<T>(raw);

    const [value, confidence] = parsed;
    return { value, confidence, inconclusive: confidence < threshold, raw };
  }

  return {
    verify(question: string, state: unknown): Promise<Verdict<boolean>> {
      return judge<boolean>(
        question,
        state,
        () => ({ type: 'noul', instructions: question }),
        (a) => {
          const noul = num(a.noul);
          if (a.type !== 'noul' || noul === undefined) return undefined;
          // Noul answers carry only P(yes) — the confidence OF the verdict is
          // the probability of whichever side noul landed on (a confident NO
          // must not read as inconclusive).
          return [noul >= BOOL_FLIP_POINT, Math.max(noul, 1 - noul)];
        },
      );
    },

    async choose<T extends string>(question: string, options: T[], state: unknown): Promise<Verdict<T>> {
      // The API rejects a choice with fewer than 2 options (HTTP 422): one
      // option is the answer by construction, so it is chosen without a request.
      const only = options.length === 1 ? options[0] : undefined;
      if (only !== undefined) {
        const answer = { type: 'choice', choice: only, probabilities: { [only]: 1 }, confidence: 1 };
        return { value: only, confidence: 1, inconclusive: false, raw: { local: 'single-option choice', answers: { [QUESTION_ID]: answer } } };
      }
      return judge<T>(
        question,
        state,
        () => ({
          type: 'choice',
          instructions: question,
          criteria: Object.fromEntries(options.map((o) => [o, null])),
        }),
        (a) => {
          if (typeof a.choice !== 'string') return undefined;
          // Model output is untrusted: only options we sent may pass through.
          if (!options.includes(a.choice as T)) return undefined;
          return [a.choice as T, num(a.confidence) ?? 0];
        },
      );
    },
  };
}
