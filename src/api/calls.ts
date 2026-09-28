// Сведения о звонке из calling_api_v2 (in-memory Map calls): GET /api/calls/:callId.
// Используется историей звонков, чтобы узнать loyaltyId собеседника входящего звонка.
import {VOIP_BASE_URL} from '../config/server';
import {authFetch} from './http';

export interface BackendCallInfo {
  callId: string;
  fromDeviceId: string | null;
  toDeviceId: string | null;
  fromLoyaltyId: string | null;
  toLoyaltyId: string | null;
  callerName: string | null;
}

export async function getCallInfo(callId: string): Promise<BackendCallInfo | null> {
  try {
    const resp = await authFetch(`${VOIP_BASE_URL}/api/calls/${encodeURIComponent(callId)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      callId: data.callId || callId,
      fromDeviceId: data.fromDeviceId || null,
      toDeviceId: data.toDeviceId || null,
      fromLoyaltyId: data.fromLoyaltyId || null,
      toLoyaltyId: data.toLoyaltyId || null,
      callerName: data.callerName || null,
    };
  } catch {
    return null;
  }
}
