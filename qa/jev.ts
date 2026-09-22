/**
 * TypeSafe Jev (System One) typed-judgment client for the QA harness.
 *
 * Documented API (https://docs.typesafe.ai/api.md):
 *   POST  https://api.typesafe.ai/v1/systemone
 *       Authorization: Bearer <key>
 *   body  → { state, model: "jev-latest", questions: { <id>: { type, instructions, criteria? } } }
 *   reply → { model, answers: { <id>: <answer> }, usage }
 *     noul   answer → { type: 'noul',   noul: P(yes) 0..1 }                  (no confidence field)
 *     choice answer → { type: 'choice', choice, probabilities, confidence }  (confidence 0..1)
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

export interface JevOptions {
  apiKey?: string;    // default: env TYPE_SAFE_API_KEY
  endpoint?: string;  // default: https://api.typesafe.ai/v1/systemone (documented)
  model?: string;     // default: 'jev-latest'
  threshold?: number; // default 0.8
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const QUESTION_ID = 'verdict';
const DEFAULT_THRESHOLD = 0.8;
/** noul is P(yes); the boolean flips at even odds. */
const BOOL_FLIP_POINT = 0.5;

/** Loose view of the documented answer union (noul | choice | score). */
interface JevAnswer {
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

export function makeJev(opts: JevOptions & { fetch?: FetchLike } = {}) {
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
    parseAnswer: (answer: JevAnswer) => [T, number] | undefined,
  ): Promise<Verdict<T>> {
    const apiKey = opts.apiKey ?? process.env.TYPE_SAFE_API_KEY;
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

    const answer = (raw as { answers?: Record<string, JevAnswer> } | null)?.answers?.[QUESTION_ID];
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
