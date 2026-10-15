// Check: after a call ends, the call screen shows the other person's name (not «Неизвестный»),
// and the screen does not get stuck on «Звонок завершён».
//
// Run: node scripts/check-call-ended-name.mjs   (Node >= 22.18, no npm install)
//
// Owner report 15.10.2026 (iPhone): after a call ends, the in-app call screen shows «Неизвестно».
// Cause: VoipService clears callerName on every end path, and CallContext dropped its own copy
// (tracked call) at the same moment, so the «Звонок завершён» card had no name; the overlay
// fell back to «Неизвестный». On iOS this is what the agent sees when coming back to the app
// after hanging up in CallKit. Separately, when answering failed (call already over, 404/409/410)
// VoipService left the state at 'ended' forever: the card never closed, new calls were blocked.
//
// Part 1 - the real src/state/CallContext.tsx with React / VoipService / API replaced by mocks:
//          poll() is driven by hand through call states.
// Part 2 - source checks of CallOverlay.tsx and VoipService.ts.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import module from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = console.log.bind(console);
let failed = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    out(`  ok   ${name}`);
  } catch (e) {
    failed++;
    out(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
  }
}
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

if (!process.features || !process.features.typescript || typeof module.registerHooks !== 'function') {
  console.log('SKIP: need Node >= 22.18 (TypeScript type stripping + module.registerHooks)');
  process.exit(0);
}

// ---------------------------------------------------------------- mocks
const M = (globalThis.__callCtxMock = {
  engine: {state: 'idle', callUUID: null, callerName: null, isMuted: false, isSpeakerEnabled: false, speakerMode: 'earpiece', connectionState: null},
  callInfo: {},
  records: [],
  state: [],
  refs: [],
  effects: [],
  timers: [],
  intervals: [],
});

const MOCKS = {
  react: `
    const M = globalThis.__callCtxMock;
    let si = 0, ri = 0;
    export function __beginRender() { si = 0; ri = 0; }
    export function useState(init) {
      const i = si++;
      if (!(i in M.state)) M.state[i] = typeof init === 'function' ? init() : init;
      const set = v => { M.state[i] = typeof v === 'function' ? v(M.state[i]) : v; };
      return [M.state[i], set];
    }
    export function useRef(init) { const i = ri++; if (!M.refs[i]) M.refs[i] = {current: init}; return M.refs[i]; }
    export const useCallback = fn => fn;
    export const useMemo = fn => fn();
    export function useEffect(fn) { M.effects.push(fn); }
    export const useContext = ctx => ctx._value;
    export function createContext(v) { const c = {_value: v}; c.Provider = 'Provider'; return c; }
    export function createElement(type, props, ...children) { return {type, props, children}; }
    export default {createElement};`,
  'react-native': `
    export const Alert = { alert: (...a) => globalThis.__callCtxMock.alerts = a };
    export const AppState = { currentState: 'active' };`,
  '../voip/VoipService': `
    const M = globalThis.__callCtxMock;
    export const getCallState = () => ({...M.engine});
    export const getActiveCallInfo = () => ({isActive: M.engine.state === 'answered', startedAt: M.engine.state === 'answered' ? 1000 : null});
    export const answerCall = async () => {};
    export const endCall = () => {};
    export const rejectCall = () => {};
    export const startOutgoingVoiceCallByLoyaltyId = () => new Promise(() => {});
    export const toggleMute = () => {};
    export const toggleSpeakerMode = () => {};`,
  '../api/calls': `export const getCallInfo = async id => globalThis.__callCtxMock.callInfo[id] || null;`,
  '../api/users': `export const normalizeLoyaltyId = v => String(v || '').replace(/\\s+/g, '');`,
  '../history/callHistory': `export const upsertCallRecord = async r => { globalThis.__callCtxMock.records.push(r); };`,
  '../push/localNotifications': `export const showMissedCallNotification = async () => {};`,
  './AuthContext': `export const useAuth = () => ({ user: { loyaltyId: '111 111' }, status: 'signedIn' });`,
};

const CTX = path.join(root, 'src/state/CallContext.tsx');
module.registerHooks({
  resolve(specifier, context, next) {
    if (Object.prototype.hasOwnProperty.call(MOCKS, specifier)) return {url: `mock:${specifier}`, shortCircuit: true};
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('mock:')) return {format: 'module', source: MOCKS[url.slice(5)], shortCircuit: true};
    if (url === pathToFileURL(CTX).href) {
      // the only JSX in the file: <Ctx.Provider value={value}>{children}</Ctx.Provider>
      let src = fs.readFileSync(CTX, 'utf8');
      src = src.replace(/<Ctx\.Provider value=\{value\}>\{children\}<\/Ctx\.Provider>/, 'React.createElement(Ctx.Provider, {value}, children)');
      assert.ok(!/<[A-Z][\w.]*[\s>]/.test(src.replace(/<[A-Za-z]+(?:\[\])? \| null>|useRef<|useState<|createContext<|useMemo<|Promise</g, '')), 'unexpected JSX in CallContext.tsx');
      return {format: 'module-typescript', source: src, shortCircuit: true};
    }
    return next(url, context);
  },
});

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { M.timers.push({fn, ms}); return M.timers.length; };
globalThis.setInterval = fn => { M.intervals.push(fn); return 1; };
const flush = () => new Promise(r => realSetTimeout(r, 0));

const ctxMod = await import(pathToFileURL(CTX).href);
const reactMock = await import('react');

/** Mount CallProvider once (fresh state) and return helpers. */
function mount() {
  M.state.length = 0; M.refs.length = 0; M.effects.length = 0; M.timers.length = 0; M.intervals.length = 0; M.records.length = 0;
  M.engine = {state: 'idle', callUUID: null, callerName: null, isMuted: false, isSpeakerEnabled: false, speakerMode: 'earpiece', connectionState: null};
  let el;
  const render = () => { reactMock.__beginRender(); el = ctxMod.CallProvider({children: null}); };
  render();
  M.effects.splice(0).forEach(fn => fn());
  const poll = () => { M.intervals[0](); render(); };
  const ui = () => el.props.value;
  const runTimers = () => { const t = M.timers.splice(0); t.forEach(x => x.fn()); render(); };
  return {poll, ui, runTimers, render};
}

out('CallContext: name after the call ends');
await check('incoming call (name from push): after the end the card shows the caller name and ID, not empty', async () => {
  const h = mount();
  M.callInfo.c1 = {fromLoyaltyId: '123456', callerName: 'Анна Петрова'};
  M.engine = {...M.engine, state: 'ringing', callUUID: 'c1', callerName: 'Анна Петрова'};
  h.poll();
  await flush();
  M.engine = {...M.engine, state: 'answered'};
  h.poll();
  assert.equal(h.ui().callerName, 'Анна Петрова');
  // remote hangup: VoipService clears everything
  M.engine = {...M.engine, state: 'idle', callUUID: null, callerName: null};
  h.poll();
  assert.equal(h.ui().screenVisible, true, 'card stays for «Звонок завершён»');
  assert.equal(h.ui().callerName, 'Анна Петрова', 'name lost after end');
  assert.equal(h.ui().peerLoyaltyId, '123456');
  h.poll();
  assert.equal(h.ui().callerName, 'Анна Петрова', 'name lost on the next poll');
  h.runTimers();
  assert.equal(h.ui().screenVisible, false, 'card closes after 1.5 s');
});
await check('incoming call without a name in the push: name from GET /api/calls/:id is kept after the end', async () => {
  const h = mount();
  M.callInfo.c2 = {fromLoyaltyId: '555 777', callerName: 'Олег'};
  M.engine = {...M.engine, state: 'ringing', callUUID: 'c2', callerName: null};
  h.poll();
  await flush();
  M.engine = {...M.engine, state: 'ended', callUUID: null, callerName: null};
  h.poll();
  assert.equal(h.ui().callerName, 'Олег');
  assert.equal(h.ui().peerLoyaltyId, '555 777');
});
await check('outgoing call: the name of the called person stays after the end (also before the call has an id)', async () => {
  const h = mount();
  const p = h.ui().call({loyaltyId: '777 888', name: 'Иван Сидоров'});
  await p;
  h.poll();
  assert.equal(h.ui().callerName, 'Иван Сидоров', 'name while the call is starting');
  M.engine = {...M.engine, state: 'calling', callUUID: 'c3', callerName: null};
  h.poll();
  M.engine = {...M.engine, state: 'answered'};
  h.poll();
  M.engine = {...M.engine, state: 'ended', callUUID: null, callerName: null};
  h.poll();
  assert.equal(h.ui().callerName, 'Иван Сидоров');
  assert.equal(h.ui().peerLoyaltyId, '777 888');
});
await check('the previous person does not leak into the next call', async () => {
  const h = mount();
  M.callInfo.c4 = {fromLoyaltyId: '1', callerName: 'Первый'};
  M.engine = {...M.engine, state: 'ringing', callUUID: 'c4', callerName: 'Первый'};
  h.poll();
  await flush();
  M.engine = {...M.engine, state: 'idle', callUUID: null, callerName: null};
  h.poll();
  assert.equal(h.ui().callerName, 'Первый');
  await h.ui().call({loyaltyId: '2', name: 'Второй'});
  h.poll();
  assert.equal(h.ui().callerName, 'Второй');
  M.engine = {...M.engine, state: 'ringing', callUUID: 'c5', callerName: 'Третий'};
  h.poll();
  assert.equal(h.ui().callerName, 'Третий');
});

out('\nCallOverlay / VoipService');
await check('CallOverlay: no «Неизвестный»; without a name — ID or «Пользователь»; banner after the end says «завершён»', () => {
  const src = code(read('src/components/CallOverlay.tsx'));
  assert.ok(!/Неизвестн/.test(src), '«Неизвестный» is still in CallOverlay');
  assert.match(src, /\{c\.callerName \|\| \(c\.peerLoyaltyId \? `ID \$\{formatLoyaltyId\(c\.peerLoyaltyId\)\}` : 'Пользователь'\)\}/);
  assert.match(src, /: isCalling\s*\?\s*' · вызов…'\s*:\s*' · завершён'/);
});
await check('VoipService: a failed answer does not leave the state at «ended» forever (both catch blocks)', () => {
  const src = code(read('src/voip/VoipService.ts'));
  const blocks = src.match(/stopIncomingRingtone\(\);\s*activeCallStartedAt = null;\s*currentCallState = 'ended';\s*setTimeout\(\(\) => \{\s*if \(currentCallState === 'ended' && !activeCallUUID && !incomingCallUUID\) \{\s*currentCallState = 'idle';\s*\}\s*\}, 3000\);\s*throw e;/g) || [];
  assert.equal(blocks.length, 2, `found ${blocks.length} of 2`);
  assert.ok(!/currentCallState = 'ended';\s*throw e;/.test(src), 'a catch block still ends at «ended» without reset');
});

out(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
