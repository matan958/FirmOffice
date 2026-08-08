import { setGlobalOptions } from 'firebase-functions/v2';
import { FUNCTIONS_REGION } from '../shared.js';

/**
 * Global defaults for every function in this codebase.
 *
 * ── Why this is its own module, imported first ──
 * setGlobalOptions() only affects function definitions evaluated AFTER it runs. In
 * ESM, `export { x } from './y.js'` evaluates './y.js' before the body of the
 * importing module — so calling setGlobalOptions inside index.ts's body applied it to
 * nothing except the handlers literally defined below it. Everything re-exported from
 * a subdirectory had already registered itself with the default region.
 *
 * That failure is quiet and expensive: the first real deploy put five functions in
 * us-central1 and three in us-east1, and a cross-region storage trigger will not
 * deploy at all. Putting the call in a module that index.ts imports FIRST makes the
 * ordering explicit and guaranteed.
 *
 * `maxInstances` is a cost guard, not a performance knob: a bulk upload or a
 * misconfigured poller must not fan out into thousands of concurrent Vision calls
 * before anyone notices the bill.
 */
setGlobalOptions({
  region: FUNCTIONS_REGION,
  maxInstances: 10,
  memory: '512MiB',
  timeoutSeconds: 120,
});

export const globalOptionsApplied = true;
