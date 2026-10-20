// Support App: пуши о сообщениях пользователей на заблокированный / свёрнутый iPhone.
// Запуск: node scripts/check-staff-push-client.mjs (без npm install).
// Было (до 20.10.2026): только локальное уведомление, пока жив сокет чата — на заблокированном
// iPhone iOS усыпляет приложение, сокет рвётся, уведомлений нет. Сервер: calling_api_v2 lib/staffPush.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
  }
}

const appDelegate = code(read('ios/TotusSupport/AppDelegate.swift'));
const helperM = code(read('ios/TotusSupport/VoipPushHelper.m'));
const helperH = code(read('ios/TotusSupport/VoipPushHelper.h'));
const remote = code(read('src/push/remotePush.ts'));
const socket = code(read('src/realtime/supportSocket.ts'));
const chatCtx = code(read('src/state/SupportChatContext.tsx'));
const auth = code(read('src/state/AuthContext.tsx'));
const plist = read('ios/TotusSupport/Info.plist');
const entRelease = read('ios/TotusSupport/TotusSupportRelease.entitlements');

console.log('iOS: APNs-токен обычных пушей');

check('AppDelegate регистрирует обычные пуши и передаёт токен в VoipPushHelper', () => {
  assert.match(appDelegate, /application\.registerForRemoteNotifications\(\)/);
  assert.match(appDelegate, /didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data\s*\)\s*\{\s*VoipPushHelper\.setApnsDeviceToken\(deviceToken\)/);
  // PushKit (звонки) не тронут
  assert.match(appDelegate, /registry\.desiredPushTypes = \[\.voIP\]/);
  assert.match(appDelegate, /CallKeepHelper\.reportIncomingCall\(/);
});

check('VoipPushHelper: hex-токен и модуль NativeModules.TotusApns (getToken, registerForRemote)', () => {
  assert.match(helperH, /\+ \(void\)setApnsDeviceToken:\(NSData \*\)deviceToken;/);
  assert.match(helperM, /\[hex appendFormat:@"%02x", bytes\[i\]\]/);
  assert.match(helperM, /RCT_EXPORT_MODULE\(TotusApns\)/);
  assert.match(helperM, /RCT_REMAP_METHOD\(getToken,/);
  assert.match(helperM, /RCT_EXPORT_METHOD\(registerForRemote\)/);
});

check('Info.plist: remote-notification в фоне; Release: aps-environment production', () => {
  assert.match(plist, /<string>remote-notification<\/string>/);
  assert.match(entRelease, /<key>aps-environment<\/key>\s*<string>production<\/string>/);
});

console.log('JS: регистрация на сервере и «на экране / свёрнуто»');

check('remotePush: POST /api/support/push-device {token, environment, bundleId}; выход — DELETE', () => {
  assert.match(remote, /\/api\/support\/push-device`, \{\s*method: 'POST'/);
  assert.match(remote, /environment: apnsEnvironment\(\), bundleId: BUNDLE_ID/);
  assert.match(remote, /const BUNDLE_ID = 'club\.totus\.support'/);
  assert.match(remote, /__DEV__ \? 'sandbox' : 'production'/);
  assert.match(remote, /method: 'DELETE'/);
  assert.match(remote, /if \(Platform\.OS !== 'ios'\) return Promise\.resolve\(null\)/);
});

check('сокет чата сообщает support:presence при подключении и при смене AppState', () => {
  assert.match(socket, /socket\.emit\('support:presence', \{state: presenceState\(state\), pushToken: getRegisteredPushToken\(\)\}\)/);
  assert.match(socket, /socket\.on\('connect', \(\) => \{\s*updateSupportPresence\(\);/);
  assert.match(socket, /AppState\.addEventListener\('change', s => updateSupportPresence\(s\)\)/);
  assert.match(socket, /return state === 'active' \? 'foreground' : 'background'/);
});

check('свёрнуто и пуши включены — без второго (локального) уведомления; на экране — локальное', () => {
  assert.match(chatCtx, /if \(!appActive && isRemotePushActive\(\)\) return;/);
  assert.match(chatCtx, /showMessageNotification\(\{chatId: chat\.id/);
});

check('вход / возврат в приложение — регистрация; выход — снятие до очистки сессии', () => {
  assert.match(auth, /requestNotificationPermission\(\)[\s\S]*?\.then\(\(\) => registerRemotePush\(\)\)[\s\S]*?\.then\(\(\) => updateSupportPresence\(\)\)/);
  const out = auth.indexOf('await unregisterRemotePush()');
  assert.ok(out > 0 && out < auth.indexOf('await clearSession()'), 'unregister до clearSession');
  assert.match(auth, /connectSupportSocket\(\);\s*registerRemotePush\(\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
