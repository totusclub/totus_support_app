// Проверка STUN/TURN — аналог блока «Статус STUN/TURN серверов» панели calling_v2
// (checkAllServersStatus), но точнее: STUN считается доступным при srflx-кандидате,
// TURN — при relay-кандидате. Список серверов и креды TURN — с backend (GET /api/ice-servers).
import {RTCPeerConnection} from 'react-native-webrtc';
import {VOIP_BASE_URL} from '../config/server';
import {authFetch} from '../api/http';

export type ServerStatus = {
  url: string;
  type: 'stun' | 'turn';
  status: 'available' | 'unavailable' | 'error';
  latency?: number;
};

type IceServer = {urls: string | string[]; username?: string; credential?: string};

export async function fetchIceServersForDiagnostics(): Promise<{servers: IceServer[]; mode: string | null}> {
  try {
    const res = await authFetch(`${VOIP_BASE_URL}/api/ice-servers`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.iceServers) && data.iceServers.length) {
        return {servers: data.iceServers, mode: data.mode || null};
      }
    }
  } catch {
    /* фолбэк ниже */
  }
  return {
    servers: [{urls: 'stun:stun1.totus.club:3478'}, {urls: 'stun:stun2.totus.club:3478'}],
    mode: 'fallback',
  };
}

async function checkOne(server: IceServer, url: string): Promise<ServerStatus> {
  const type: 'stun' | 'turn' = url.startsWith('stun') ? 'stun' : 'turn';
  const want = type === 'stun' ? 'srflx' : 'relay';
  const started = Date.now();
  let pc: any = null;
  try {
    pc = new RTCPeerConnection({
      iceServers: [{...server, urls: url}],
      iceTransportPolicy: type === 'turn' ? 'relay' : 'all',
    } as any);
    pc.createDataChannel('diag');
    let found = false;
    const done = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000);
      pc.addEventListener('icecandidate', (e: any) => {
        const cand: string = e?.candidate?.candidate || '';
        if (cand.includes(` typ ${want}`)) {
          found = true;
          clearTimeout(timer);
          resolve();
        }
        if (!e?.candidate) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    await done;
    return found
      ? {url, type, status: 'available', latency: Date.now() - started}
      : {url, type, status: 'unavailable'};
  } catch {
    return {url, type, status: 'error'};
  } finally {
    try {
      pc?.close();
    } catch {
      /* ignore */
    }
  }
}

export async function checkAllServersStatus(): Promise<{mode: string | null; results: ServerStatus[]}> {
  const {servers, mode} = await fetchIceServersForDiagnostics();
  const results: ServerStatus[] = [];
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const url of urls) {
      results.push(await checkOne(s, url));
    }
  }
  return {mode, results};
}
