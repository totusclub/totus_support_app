// Check: iOS asks for microphone access early, while the app is on screen.
//
// Run: node scripts/check-mic-permission.mjs   (Node >= 22.18, no npm install)
//
// Broken case (audit 02.10.2026, A6): the microphone permission was asked only inside
// getUserMedia at answer time. The first answer from CallKit / the lock screen cannot show
// the system prompt, getUserMedia fails and the call is dropped.
// Expected now: after sign-in, as soon as the app is active, iOS shows the prompt once;
// nothing is asked in the background (cold start from a VoIP push), after logout, or on Android.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
  }
}

// ---------------------------------------------------------------- source guards
console.log('source');
await check('sign-in starts the early microphone request; logout cancels it', () => {
  const s = fs.readFileSync(path.join(root, 'src/state/AuthContext.tsx'), 'utf8');
  const start = s.slice(s.indexOf('async function startServices'), s.indexOf('export function AuthProvider'));
  assert.ok(/ensureMicPermissionWhenActive\(\)/.test(start), 'startServices must call ensureMicPermissionWhenActive()');
  const logout = s.slice(s.indexOf('const logout = useCallback'), s.indexOf('// Восстановление сессии'));
  assert.ok(/cancelMicPermissionRequest\(\)/.test(logout), 'logout must call cancelMicPermissionRequest()');
});

if (!process.features || !process.features.typescript || typeof module.registerHooks !== 'function') {
  console.log('SKIP micPermission: need Node >= 22.18');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- mocks
const MOCKS = {
  'react-native': `
    const M = () => globalThis.__mic; // read per call: every case installs a fresh state
    export const Platform = { get OS() { return M().Platform.OS; } };
    export const AppState = {
      get currentState() { return M().appState; },
      addEventListener: (ev, cb) => { const L = M().listeners; L.add(cb); return { remove() { L.delete(cb); } }; },
    };
    export default { Platform, AppState };`,
  'react-native-webrtc': `
    const M = () => globalThis.__mic;
    export const permissions = {
      query: async (d) => { M().queries.push(d.name); return M().status; },
      request: async (d) => { const m = M(); m.requests.push(d.name); m.status = m.answer ? 'granted' : 'denied'; return m.answer; },
    };`,
};
module.registerHooks({
  resolve(spec, ctx, next) {
    if (MOCKS[spec]) return {url: 'mock:' + spec, shortCircuit: true};
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith('mock:')) return {format: 'module', source: MOCKS[url.slice(5)], shortCircuit: true};
    return next(url, ctx);
  },
});
const quiet = () => {};
console.warn = quiet;
const realLog = console.log;
realLog('micPermission.ts');
console.log = (...a) => { if (!String(a[0]).startsWith('[mic-permission]')) realLog(...a); };

let n = 0;
async function fresh({os = 'ios', appState = 'active', status = 'prompt', answer = true} = {}) {
  globalThis.__mic = {Platform: {OS: os}, appState, status, answer, listeners: new Set(), queries: [], requests: []};
  const url = pathToFileURL(path.join(root, 'src/voip/micPermission.ts')).href + `?case=${++n}`;
  const mod = await import(url);
  return {mod, M: globalThis.__mic};
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function goActive(M) {
  M.appState = 'active';
  for (const cb of [...M.listeners]) cb('active');
  await tick();
  await tick();
}

await check('iOS, app on screen, not asked yet -> system prompt shown once', async () => {
  const {mod, M} = await fresh();
  mod.ensureMicPermissionWhenActive();
  mod.ensureMicPermissionWhenActive(); // repeated sign-in / restore
  await tick(); await tick();
  assert.deepEqual(M.requests, ['microphone']);
  assert.equal(mod.getMicPermissionStatus(), 'granted');
});
await check('iOS cold start from a VoIP push (background) -> no prompt until the app is opened', async () => {
  const {mod, M} = await fresh({appState: 'background'});
  mod.ensureMicPermissionWhenActive();
  mod.ensureMicPermissionWhenActive();
  await tick();
  assert.equal(M.requests.length, 0, 'must not ask in background');
  assert.equal(M.listeners.size, 1, 'one waiting listener');
  await goActive(M);
  assert.deepEqual(M.requests, ['microphone']);
  assert.equal(M.listeners.size, 0, 'listener removed after use');
});
await check('already granted -> no prompt', async () => {
  const {mod, M} = await fresh({status: 'granted'});
  mod.ensureMicPermissionWhenActive();
  await tick(); await tick();
  assert.equal(M.requests.length, 0);
  assert.equal(mod.getMicPermissionStatus(), 'granted');
});
await check('denied earlier -> no prompt (iOS cannot ask again), status reported as denied', async () => {
  const {mod, M} = await fresh({status: 'denied'});
  mod.ensureMicPermissionWhenActive();
  await tick(); await tick();
  assert.equal(M.requests.length, 0);
  assert.equal(mod.getMicPermissionStatus(), 'denied');
});
await check('user taps "Don\'t Allow" -> status denied, no crash', async () => {
  const {mod, M} = await fresh({answer: false});
  mod.ensureMicPermissionWhenActive();
  await tick(); await tick();
  assert.deepEqual(M.requests, ['microphone']);
  assert.equal(mod.getMicPermissionStatus(), 'denied');
});
await check('logout before the app was opened -> no prompt later', async () => {
  const {mod, M} = await fresh({appState: 'background'});
  mod.ensureMicPermissionWhenActive();
  mod.cancelMicPermissionRequest();
  await goActive(M);
  assert.equal(M.requests.length, 0);
});
await check('Android -> nothing here (RECORD_AUDIO is requested by VoipService init)', async () => {
  const {mod, M} = await fresh({os: 'android'});
  mod.ensureMicPermissionWhenActive();
  await tick(); await tick();
  assert.equal(M.queries.length + M.requests.length, 0);
  assert.equal(M.listeners.size, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
