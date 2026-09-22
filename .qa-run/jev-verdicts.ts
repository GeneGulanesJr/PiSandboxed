// REAL Jev judgment layer — positive verdict AND negative-side control,
// both against the captured page state from the harness run.
import { readFileSync, writeFileSync } from 'node:fs';
import { makeJev } from '../qa/jev.js';

const state = JSON.parse(readFileSync(new URL('./state.json', import.meta.url), 'utf8'));
console.log('PAGE_STATE:', JSON.stringify(state));

const jev = makeJev(); // TYPESAFE_API_KEY from host env — never passed to the sandbox

const t0 = Date.now();
const positive = await jev.verify('is the user logged in and viewing a dashboard?', {
  h1: state.h1,
  dashboardVisible: state.dashboardVisible,
  loginGone: state.loginGone,
});
console.log('POSITIVE_LATENCY_MS:', Date.now() - t0);
console.log('JEV_POSITIVE:', JSON.stringify(positive, null, 2));

const t1 = Date.now();
const negative = await jev.verify('is the user still on the login screen?', {
  h1: state.h1,
  dashboardVisible: state.dashboardVisible,
  loginGone: state.loginGone,
});
console.log('NEGATIVE_LATENCY_MS:', Date.now() - t1);
console.log('JEV_NEGATIVE:', JSON.stringify(negative, null, 2));

// Derived control verdict: did the negative control behave as expected (NO, confidently)?
const control = {
  value: negative.value === false && !negative.inconclusive,
  confidence: negative.confidence,
  inconclusive: negative.inconclusive,
  raw: negative.raw,
};
console.log('NEGATIVE_CONTROL_AS_EXPECTED:', JSON.stringify(control, null, 2));

writeFileSync(
  new URL('./verdicts.json', import.meta.url),
  JSON.stringify({ state, positive, negative, control }, null, 2),
);
console.log('VERDICTS_SAVED');
