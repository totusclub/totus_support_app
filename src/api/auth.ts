// Вход сотрудника поддержки — тот же эндпоинт, что у панели агента calling_v2
// (lib/auth-api.ts): POST /api/web/login, пускает только пользователей с role = 'agent'.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {VOIP_BASE_URL} from '../config/server';
import {clearTokens, getAccessToken, getRefreshToken, isTokenAlive, storeTokens} from './http';

export interface AgentUser {
  id: number;
  loyaltyId: string;
  name: string | null;
  fName: string | null;
  lName: string | null;
  email: string | null;
  phone: string | null;
  role: string;
}

export interface LoginResponse {
  ok: boolean;
  user: AgentUser;
  accessToken?: string;
  refreshToken?: string;
}

const USER_KEY = 'support:agentUser';

export class LoginError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LoginError';
    this.status = status;
  }
}

function loginErrorMessage(status: number, serverError?: string): string {
  if (status === 400) return 'Введите e-mail и пароль';
  if (status === 401) return 'Неверный e-mail или пароль';
  if (status === 403) {
    if (serverError && serverError.includes('Only agents')) {
      return 'Вход только для сотрудников поддержки (роль agent)';
    }
    return 'Доступ заблокирован';
  }
  if (status === 429) return 'Слишком много попыток. Подождите минуту';
  return 'Не удалось войти. Проверьте соединение';
}

export async function login(email: string, password: string): Promise<AgentUser> {
  let resp: Response;
  try {
    resp = await fetch(`${VOIP_BASE_URL}/api/web/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email: email.trim().toLowerCase(), password}),
    });
  } catch {
    throw new LoginError(loginErrorMessage(0), 0);
  }
  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    /* тело не JSON */
  }
  if (!resp.ok || !data?.ok || !data?.user) {
    throw new LoginError(loginErrorMessage(resp.status, data?.error), resp.status);
  }
  if (data.user.role !== 'agent') {
    throw new LoginError(loginErrorMessage(403, 'Only agents'), 403);
  }
  if (!data.accessToken) {
    // Без JWT (JWT_SECRET не задан на сервере) Support Chat не работает: его роуты strict.
    throw new LoginError('Сервер не выдал токен доступа (JWT). Обратитесь к администратору', 500);
  }
  await storeTokens(data.accessToken, data.refreshToken);
  await storeUser(data.user);
  return data.user as AgentUser;
}

export async function storeUser(user: AgentUser): Promise<void> {
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
}

export async function getStoredUser(): Promise<AgentUser | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AgentUser) : null;
  } catch {
    return null;
  }
}

/** Есть сохранённый агент и живая сессия (живой access или есть refresh). */
export async function restoreSession(): Promise<AgentUser | null> {
  const user = await getStoredUser();
  if (!user || user.role !== 'agent') return null;
  const access = await getAccessToken();
  const refresh = await getRefreshToken();
  if (!access && !refresh) return null;
  if (access && !isTokenAlive(access) && !refresh) return null;
  return user;
}

export async function clearSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  await clearTokens();
}

export function agentDisplayName(user: AgentUser | null): string {
  if (!user) return 'Сотрудник';
  return (
    user.name ||
    [user.fName, user.lName].filter(Boolean).join(' ') ||
    user.email ||
    'Сотрудник'
  );
}
