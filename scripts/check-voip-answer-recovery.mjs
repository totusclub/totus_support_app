// Check: answering a VoIP call from the background / closed app connects the call.
//
// Run: node scripts/check-voip-answer-recovery.mjs   (Node >= 22.18, no npm install)
//
// Part 1 - pure logic of src/voip/answerRecovery.ts.
// Part 2 - the real src/voip/VoipService.ts with native modules replaced by mocks
//          (module.registerHooks): iOS cold start, answer made in CallKit before JS
//          started, then the VoIP token event fires several times. Expected: one
//          RTCPeerConnection, one answer sent to the backend.
//
// Broken case this reproduces (30.09.2026): on iOS the answer from the closed app was
// lost (getInitialEvents read on Android only), and the pending answer was processed
// 2-6 times, each time creating a new RTCPeerConnection.
//
// The app is NEVER made active in the "closed app" / "locked phone" scenarios: the call
// must connect right after "Answer" in CallKit, without the user opening the app.
// (AppDelegate starts React Native in the background on the VoIP push; index.js calls
// bootstrapVoipFromStoredSession - the same entry point is used here.)

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

if (!process.features || !process.features.typescript || typeof module.registerHooks !== 'function') {
  console.log('SKIP: need Node >= 22.18 (TypeScript type stripping + module.registerHooks)');
  process.exit(0);
}

// ---------------------------------------------------------------- mocks
const MOCKS = {
  'react-native': `
    const M = globalThis.__voipMock;
    export const Platform = M.Platform;
    export const AppState = { addEventListener: (ev, cb) => { M.appStateListeners.push(cb); return { remove() {} }; }, currentState: 'background' };
    export const PermissionsAndroid = { request: async () => 'granted', check: async () => true, PERMISSIONS: {}, RESULTS: { GRANTED: 'granted' } };
    export const NativeModules = {};
    export const AppStateStatus = undefined; // type-only import in VoipService
    export default { Platform, AppState, PermissionsAndroid };`,
  'react-native-callkeep': `
    const M = globalThis.__voipMock;
    export const IOptions = undefined;
    export default M.callKeep;`,
  'react-native-voip-push-notification': `export default globalThis.__voipMock.voipPush;`,
  '@react-native-async-storage/async-storage': `
    const store = globalThis.__voipStore || (globalThis.__voipStore = new Map());
    export default {
      getItem: async k => store.get(k) ?? null,
      setItem: async (k, v) => { store.set(k, v); },
      removeItem: async k => { store.delete(k); },
      multiGet: async keys => keys.map(k => [k, store.get(k) ?? null]),
      multiSet: async pairs => { pairs.forEach(([k, v]) => store.set(k, v)); },
      multiRemove: async keys => { keys.forEach(k => store.delete(k)); },
    };`,
  'react-native-incall-manager': `export default new Proxy({}, { get: () => () => {} });`,
  'socket.io-client': `export default (...a) => globalThis.__voipMock.makeSocket(...a);`,
  '@react-native-community/netinfo': `
    export const NetInfoState = undefined;
    export default { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true, type: 'wifi' }) };`,
  '@react-native-firebase/messaging': `
    const m = () => ({ getToken: async () => null, onTokenRefresh: () => () => {}, getInitialNotification: async () => null, onMessage: () => () => {}, setBackgroundMessageHandler: () => {} });
    export const FirebaseMessagingTypes = undefined;
    export default m;`,
  'react-native-webrtc': `
    const M = globalThis.__voipMock;
    export const RTCPeerConnection = M.RTCPeerConnection;
    export const RTCSessionDescription = function (d) { return d; };
    export const RTCIceCandidate = function (c) { return c; };
    export const MediaStream = function () { return { getTracks: () => [] }; };
    export const RTCAudioSession = { audioSessionDidActivate() { M.audioActivations++; }, audioSessionDidDeactivate() { M.audioActivations--; } };
    export const mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ kind: 'audio', enabled: true, stop() {} }], getAudioTracks: () => [{ enabled: true, stop() {} }] }), setAudioOutput: () => {} };`,
};
const LOCAL_STUBS = {
  'config/server': `export const VOIP_BASE_URL = 'https://voip.test'; export const API_BASE_URL = 'https://api.test';`,
  'api/auth': `export const restoreSession = async () => globalThis.__voipMock.storedUser;`,
  'api/voipAuth': `
    export const voipFetch = (...a) => globalThis.__voipMock.fetch(...a);
    export const voipSocketAuth = (cb) => cb({ token: 't' });
    export const setVoipAccessToken = () => {};`,
  'voip/AndroidCallForegroundService': `export const startAndroidCallForegroundService = async () => {}; export const stopAndroidCallForegroundService = async () => {};`,
  'voip/NativeVoipOrchestrator': `export const nativeStopVoipService = () => {}; export const nativeUpdateConnectionStatus = () => {};`,
  'voip/AndroidPowerManager': `export const ensureAndroidBatteryOptimizationHandled = async () => {}; export const maybePromptAndroidVoipPowerSetup = async () => {};`,
};

module.registerHooks({
  resolve(specifier, context, next) {
    if (MOCKS[specifier]) {
      return {url: `mock:${specifier}`, shortCircuit: true};
    }
    if (specifier.startsWith('.') && context.parentURL && context.parentURL.startsWith('file:')) {
      const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
      const rel = path.relative(path.join(root, 'src'), base).split(path.sep).join('/');
      if (LOCAL_STUBS[rel]) {
        return {url: `mock-local:${rel}`, shortCircuit: true};
      }
      if (!path.extname(base) && fs.existsSync(base + '.ts')) {
        return {url: pathToFileURL(base + '.ts').href, shortCircuit: true};
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('mock:')) {
      return {format: 'module', source: MOCKS[url.slice(5)], shortCircuit: true};
    }
    if (url.startsWith('mock-local:')) {
      return {format: 'module', source: LOCAL_STUBS[url.slice(11)], shortCircuit: true};
    }
    return next(url, context);
  },
});

// ---------------------------------------------------------------- part 1
console.log('answerRecovery.ts');
const R = await import(pathToFileURL(path.join(root, 'src/voip/answerRecovery.ts')).href);
const A = 'RNCallKeepPerformAnswerCallAction';
const E = 'RNCallKeepPerformEndCallAction';

await check('answer before JS start is recovered', () => {
  const s = R.summarizeInitialCallKeepEvents([{name: A, data: {callUUID: 'c1'}}]);
  assert.equal(s.answerUUID, 'c1');
  assert.deepEqual(s.endedUUIDs, []);
});
await check('answer then end -> do not connect, end the call', () => {
  const s = R.summarizeInitialCallKeepEvents([{name: A, data: {callUUID: 'c1'}}, {name: E, data: {callUUID: 'c1'}}]);
  assert.equal(s.answerUUID, null);
  assert.deepEqual(s.endedUUIDs, ['c1']);
});
await check('old call ended, new call answered -> new call connects', () => {
  const s = R.summarizeInitialCallKeepEvents([{name: E, data: {callUUID: 'old'}}, {name: A, data: {callUUID: 'new'}}]);
  assert.equal(s.answerUUID, 'new');
  assert.deepEqual(s.endedUUIDs, ['old']);
});
await check('garbage input is ignored', () => {
  assert.equal(R.summarizeInitialCallKeepEvents(null).answerUUID, null);
  assert.equal(R.summarizeInitialCallKeepEvents([null, {name: A}, {name: A, data: null}]).answerUUID, null);
});
await check('gate: one answer per call, retry allowed after failure', () => {
  const g = R.createAnswerGate();
  assert.equal(g.begin('c1'), true);
  assert.equal(g.begin('c1'), false);
  assert.equal(g.isInFlight('c1'), true);
  g.finish('c1', false);
  assert.equal(g.begin('c1'), true);
  g.finish('c1', true);
  assert.equal(g.isDone('c1'), true);
  assert.equal(g.begin('c1'), false);
  assert.equal(g.begin('c2'), true);
});
await check('offer retries wait long enough after a long background (>= 20 s total)', () => {
  let total = 0;
  for (let i = 1; i <= R.OFFER_FETCH_MAX_ATTEMPTS; i++) total += R.offerRetryDelayMs(i);
  assert.equal(R.offerRetryDelayMs(1), 0);
  assert.ok(total >= 20000, `total ${total}`);
});
await check('CallKit audio activation before JS start is remembered (answer from lock screen has sound)', () => {
  const on = R.summarizeInitialCallKeepEvents([{name: A, data: {callUUID: 'c1'}}, {name: 'RNCallKeepDidActivateAudioSession'}]);
  assert.equal(on.audioActivated, true);
  const off = R.summarizeInitialCallKeepEvents([{name: 'RNCallKeepDidActivateAudioSession'}, {name: 'RNCallKeepDidDeactivateAudioSession'}]);
  assert.equal(off.audioActivated, false);
});
await check('socket handshake after a long background uses a refreshed token, not the expired one', async () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = exp => `h.${b64({exp})}.s`;
  const expired = jwt(Math.floor(Date.now() / 1000) - 3600);
  const fresh = jwt(Math.floor(Date.now() / 1000) + 3600);
  globalThis.__voipStore = new Map([['support:accessToken', expired], ['support:refreshToken', 'r1']]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.ok(String(url).endsWith('/api/auth/refresh'));
    return {ok: true, status: 200, json: async () => ({accessToken: fresh})};
  };
  try {
    const VA = await import(pathToFileURL(path.join(root, 'src/api/voipAuth.ts')).href);
    const data = await new Promise(resolve => VA.voipSocketAuth(resolve));
    assert.equal(data.token, fresh);
  } finally {
    globalThis.fetch = realFetch;
  }
});
await check('resume: pending answer or answered-without-peer -> answer; otherwise nothing', () => {
  const base = {pendingAnswerUUID: null, activeCallUUID: null, callState: 'idle', hasPeer: false, answerInFlight: false, answerDone: false};
  assert.equal(R.decideOnResume(base).action, 'none');
  assert.deepEqual(R.decideOnResume({...base, pendingAnswerUUID: 'c1'}), {action: 'answer', uuid: 'c1'});
  assert.deepEqual(R.decideOnResume({...base, activeCallUUID: 'c1', callState: 'answered'}), {action: 'answer', uuid: 'c1'});
  assert.equal(R.decideOnResume({...base, activeCallUUID: 'c1', callState: 'answered', hasPeer: true}).action, 'none');
  assert.equal(R.decideOnResume({...base, pendingAnswerUUID: 'c1', answerInFlight: true}).action, 'none');
  assert.equal(R.decideOnResume({...base, activeCallUUID: 'c1', callState: 'answered', answerDone: true}).action, 'none');
});

// ---------------------------------------------------------------- part 2
out('VoipService.ts (mocked native modules)');

// Time runs 50x faster so the 25 s offer backoff and 1.5 s timers finish quickly.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.max(0, Math.floor((ms || 0) / 50)), ...a);
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...a) => realSetInterval(fn, Math.max(5, Math.floor((ms || 0) / 50)), ...a);
const sleep = ms => new Promise(r => realSetTimeout(r, ms));

const M = {
  Platform: {OS: 'ios', Version: '18', select: o => o.ios ?? o.default},
  appStateListeners: [],
  peers: [],
  answersSent: [],
  offerFetches: 0,
  offerAvailableAfter: 0,
  initialEvents: [],
  callKeepListeners: {},
  voipListeners: {},
  endedCalls: [],
  answerBodies: [],
  audioActivations: 0,
  storedUser: {id: 1, loyaltyId: 'agent-1', role: 'agent'},
};
M.callKeep = {
  setup() {}, setAvailable() {}, setCurrentCallActive() {}, setMutedCall() {}, answerIncomingCall() {},
  displayIncomingCall() {}, reportNewIncomingCall() {}, startCall() {},
  endCall(uuid) { M.endedCalls.push(uuid); },
  addEventListener(name, cb) { (M.callKeepListeners[name] ||= []).push(cb); },
  removeEventListener() {},
  getInitialEvents: async () => M.initialEvents.slice(),
  clearInitialEvents() { M.initialEvents = []; },
};
M.voipPush = {
  addEventListener(name, cb) { (M.voipListeners[name] ||= []).push(cb); },
  removeEventListener() {},
  tokenDelayMs: 60, // real ms (= 3 s of app time): the token arrives after the answer is recovered
  registerVoipToken() {
    realSetTimeout(() => (M.voipListeners.register || []).forEach(cb => cb('ab cd ef 01')), M.voipPush.tokenDelayMs);
  },
};
M.makeSocket = () => {
  const handlers = {};
  const s = {
    connected: true, active: true, id: 'sock', io: {on() {}, opts: {}},
    on(ev, cb) { (handlers[ev] ||= []).push(cb); return s; },
    once(ev, cb) { return s.on(ev, cb); },
    off() { return s; }, removeListener() { return s; }, removeAllListeners() { return s; },
    emit() { return true; }, connect() { return s; }, disconnect() { return s; },
  };
  return s;
};
M.RTCPeerConnection = function () {
  const p = {
    signalingState: 'stable', connectionState: 'new', iceConnectionState: 'new', iceGatheringState: 'complete',
    localDescription: null, remoteDescription: null,
    addTrack() {}, addEventListener() {}, removeEventListener() {}, getSenders: () => [], getReceivers: () => [], getStats: async () => new Map(),
    async setRemoteDescription(d) { p.remoteDescription = d; p.signalingState = 'have-remote-offer'; },
    async createAnswer() { return {type: 'answer', sdp: 'v=0 answer'}; },
    async createOffer() { return {type: 'offer', sdp: 'v=0 offer'}; },
    async setLocalDescription(d) { p.localDescription = d; p.signalingState = 'stable'; },
    async addIceCandidate() {}, restartIce() {}, close() { p.connectionState = 'closed'; p.signalingState = 'closed'; },
  };
  M.peers.push(p);
  return p;
};
M.fetch = async (url, init = {}) => {
  const json = body => ({ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)});
  if (/\/api\/calls\/[^/]+$/.test(url) && (!init.method || init.method === 'GET')) {
    M.offerFetches++;
    if (M.offerFetches <= M.offerAvailableAfter) {
      throw new Error('network is down');
    }
    return json({offer: {type: 'offer', sdp: 'v=0 offer'}});
  }
  if (/\/answer$/.test(url)) {
    M.answersSent.push(url);
    M.answerBodies.push(JSON.parse(init.body || '{}'));
    return json({ok: true});
  }
  if (/candidates/.test(url)) {
    return json({candidates: []});
  }
  if (/ice/.test(url)) {
    return json({iceServers: [{urls: 'stun:stun.test'}], ttl: 3600});
  }
  return json({ok: true});
};
globalThis.__voipMock = M;

const quiet = process.env.VOIP_CHECK_VERBOSE ? null : {log: console.log, warn: console.warn, error: console.error};
if (quiet) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const V = await import(pathToFileURL(path.join(root, 'src/voip/VoipService.ts')).href);
const COLD = await import(pathToFileURL(path.join(root, 'src/voip/coldStart.ts')).href);
let appOpened = false;
const openApp = () => {
  appOpened = true;
  M.appStateListeners.forEach(cb => cb('active'));
};

const scenario = check;

await scenario('iOS, app closed, phone locked: Answer before JS started -> connects WITHOUT opening the app', async () => {
  M.initialEvents = [
    {name: A, data: {callUUID: 'call-1'}},
    {name: 'RNCallKeepDidActivateAudioSession', data: {}},
  ];
  // index.js on a background JS start (AppDelegate.startReactNativeInBackgroundIfNeeded)
  await COLD.bootstrapVoipFromStoredSession();
  assert.equal(V.isVoipEngineInitialized(), true, 'engine must start from the stored session');
  await sleep(1500); // ~75 s of app time: init timers, 5 token requests, offer fetch
  assert.equal(M.peers.length, 1, `peers created: ${M.peers.length}`);
  assert.equal(M.answersSent.filter(u => u.includes('call-1')).length, 1, `answers: ${M.answersSent.length}`);
  assert.equal(V.getCallState().state, 'answered');
  assert.equal(V.getCallState().callUUID, 'call-1');
  assert.deepEqual(M.endedCalls, []);
  assert.equal(appOpened, false, 'the app was never opened');
  assert.equal(M.audioActivations, 1, 'WebRTC must be told CallKit activated audio');
  // The answer must carry this device's VoIP token (it arrives after the recovery).
  assert.equal(M.answerBodies[0] && M.answerBodies[0].deviceId, 'abcdef01', `answer body: ${JSON.stringify(M.answerBodies[0])}`);
});

await scenario('same call answer event arrives again (CallKit + app open) -> no second peer', async () => {
  const before = M.peers.length;
  for (const cb of M.callKeepListeners.answerCall || []) {
    await cb({callUUID: 'call-1'});
  }
  openApp(); // the user opens the app later: must not start a second connection
  (M.voipListeners.register || []).forEach(cb => cb('ab cd ef 01'));
  await sleep(300);
  assert.equal(M.peers.length, before);
  assert.equal(M.answersSent.filter(u => u.includes('call-1')).length, 1);
});

await scenario('late VoIP push event for the answered call does not reset it to ringing', async () => {
  (M.voipListeners.notification || []).forEach(cb => cb({callId: 'call-1', callerName: 'Client'}));
  assert.equal(V.getCallState().state, 'answered');
});

await scenario('app in background / phone locked, JS alive: Answer -> connects without opening, audio on', async () => {
  // The user hangs up call-1.
  for (const cb of M.callKeepListeners.endCall || []) cb({callUUID: 'call-1'});
  await sleep(200);
  M.offerFetches = 0;
  M.offerAvailableAfter = 4; // 4 failed fetches: 0.5 + 1 + 2 + 3 s of waiting
  const before = M.peers.length;
  appOpened = false;
  const audioBefore = M.audioActivations;
  // JS is alive (background), the answer arrives through the listener; the app stays closed.
  for (const cb of M.callKeepListeners.answerCall || []) {
    cb({callUUID: 'call-2'});
  }
  for (const cb of M.callKeepListeners.didActivateAudioSession || []) cb();
  await sleep(1200);
  assert.equal(appOpened, false);
  assert.equal(M.audioActivations - audioBefore, 1);
  assert.equal(M.peers.length - before, 1, `new peers: ${M.peers.length - before}`);
  assert.equal(M.answersSent.filter(u => u.includes('call-2')).length, 1);
  assert.equal(V.getCallState().state, 'answered');
});

await scenario('pending answer + repeated VoIP token events -> still one peer (no overwrite)', async () => {
  for (const cb of M.callKeepListeners.endCall || []) cb({callUUID: 'call-2'});
  await sleep(200);
  M.offerFetches = 0;
  M.offerAvailableAfter = 0;
  const before = M.peers.length;
  V.queuePendingAnswerFromBackground('call-3'); // Android headless / notifee path
  for (let i = 0; i < 4; i++) {
    (M.voipListeners.register || []).forEach(cb => cb('ab cd ef 01'));
  }
  openApp();
  await sleep(800);
  assert.equal(M.peers.length - before, 1, `new peers: ${M.peers.length - before}`);
  assert.equal(M.answersSent.filter(u => u.includes('call-3')).length, 1);
});

await scenario('source: iOS starts JS on the VoIP push (not only when the app is opened)', async () => {
  const ad = fs.readFileSync(path.join(root, 'ios/TotusSupport/AppDelegate.swift'), 'utf8');
  const push = ad.slice(ad.indexOf('didReceiveIncomingPushWith'), ad.indexOf('didInvalidatePushTokenFor'));
  assert.ok(/startReactNativeInBackgroundIfNeeded\(\)/.test(push), 'push handler must start React Native');
  assert.ok(/rootViewFactory\.view\(/.test(ad), 'background start without a window');
  assert.ok(/if let rootView = backgroundRootView/.test(ad), 'scene must reuse the background root view');
  const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(/bootstrapVoipFromStoredSession\(\)/.test(idx), 'index.js must start the call engine before UI');
});

await scenario('source: CallKeep initial events are not read on Android only', async () => {
  const src = fs.readFileSync(path.join(root, 'src/voip/VoipService.ts'), 'utf8');
  const calls = src.match(/processPendingAnswer\(/g) || [];
  // definition + the single call inside schedulePendingAnswer
  assert.equal(calls.length, 2, `processPendingAnswer( occurrences: ${calls.length}`);
  assert.ok(/recoverCallKeepInitialEvents\('init'\)/.test(src));
});

out(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
