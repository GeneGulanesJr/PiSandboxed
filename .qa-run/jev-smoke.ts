// Live Jev smoke test — REAL API call via TYPESAFE_API_KEY (host env only).
import { makeJev } from '../qa/jev.js';

const envName = process.env.TYPE_SAFE_API_KEY ? 'TYPE_SAFE_API_KEY' : (process.env.TYPESAFE_API_KEY ? 'TYPESAFE_API_KEY' : 'NONE');
console.log('ENV_NAME:', envName);

const jev = makeJev();
const t0 = Date.now();
const v = await jev.verify('is 2+2 four?', { math: 'certain' });
console.log('VERDICT:', JSON.stringify(v, null, 2));
console.log('LATENCY_MS:', Date.now() - t0);
console.log('SMOKE_VALUE:', v.value, 'SMOKE_INCONCLUSIVE:', v.inconclusive, 'SMOKE_CONFIDENCE:', v.confidence);
