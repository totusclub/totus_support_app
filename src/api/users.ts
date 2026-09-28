// Пользователи платформы — порт calling_v2/lib/users-api.ts.
// GET /api/users доступен ролям agent/staff (middleware/auth.js POLICY).
import {VOIP_BASE_URL} from '../config/server';
import {authFetch} from './http';

export interface PlatformUser {
  id: number;
  loyaltyId: string;
  name: string | null;
  fName: string | null;
  lName: string | null;
  email: string | null;
  phone: string | null;
  online: boolean;
  hasVoipToken: boolean;
  hasSocket: boolean;
  /** 0 / false — доступ есть, 1 / true — заблокирован (как в calling_v2). */
  access?: boolean | 0 | 1;
}

export async function getAllUsers(): Promise<PlatformUser[]> {
  const resp = await authFetch(`${VOIP_BASE_URL}/api/users`);
  if (!resp.ok) throw new Error(`Не удалось загрузить пользователей (${resp.status})`);
  const data = await resp.json();
  return (data.users || []) as PlatformUser[];
}

export async function getUserByLoyaltyId(loyaltyId: string): Promise<PlatformUser | null> {
  const resp = await authFetch(`${VOIP_BASE_URL}/api/users/${encodeURIComponent(loyaltyId)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Не удалось загрузить пользователя (${resp.status})`);
  const data = await resp.json();
  return (data.user || null) as PlatformUser | null;
}

/** access=true — заблокировать (1), false — открыть доступ (0). PATCH /api/users/:id/access. */
export async function updateUserAccess(userId: number, blocked: boolean): Promise<void> {
  const resp = await authFetch(`${VOIP_BASE_URL}/api/users/${userId}/access`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({access: blocked}),
  });
  if (!resp.ok) throw new Error(`Не удалось обновить доступ (${resp.status})`);
}

export function hasAccess(u: PlatformUser): boolean {
  return u.access === 0 || u.access === false || u.access === undefined;
}

/** Можно ли позвонить: онлайн (сокет) или есть токен пуша (VoIP/FCM). */
export function isCallable(u: PlatformUser): boolean {
  return hasAccess(u) && (u.online || u.hasVoipToken);
}

export function getUserDisplayName(user: Pick<PlatformUser, 'name' | 'fName' | 'lName' | 'email' | 'phone' | 'loyaltyId'>): string {
  if (user.name) return user.name;
  if (user.fName || user.lName) return [user.fName, user.lName].filter(Boolean).join(' ');
  if (user.email) return user.email;
  if (user.phone) return user.phone;
  return `User ${user.loyaltyId}`;
}

export function normalizeLoyaltyId(id: string | null | undefined): string {
  return String(id || '').replace(/\s+/g, '');
}
