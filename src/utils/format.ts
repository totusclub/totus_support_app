// Хелперы дат/времени — порт calling_v2/components/chat/utils.ts.
import type {SupportMessage} from '../api/supportChat';

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function parseDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** «14:05» */
export function formatTime(value: string | number | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** «Сегодня» / «Вчера» / «7 сентября» / «7 сентября 2025». */
export function dayLabel(value: string | number | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '';
  const now = new Date();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Время в списке: сегодня — «14:05», вчера — «Вчера», иначе — «07.09». */
export function listTime(value: string | number | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '';
  const now = new Date();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return formatTime(value);
  if (diffDays === 1) return 'Вчера';
  const dm = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? dm : `${dm}.${String(d.getFullYear()).slice(2)}`;
}

/** «03:25» / «1:02:03» */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export type MessageGroup = {key: string; label: string; messages: SupportMessage[]};

/** Группировка сообщений по дням (вход — от старых к новым). */
export function groupByDay(messages: SupportMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const m of messages) {
    const d = parseDate(m.createdAt);
    const key = d ? String(startOfDay(d)) : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.messages.push(m);
    else groups.push({key, label: dayLabel(m.createdAt), messages: [m]});
  }
  return groups;
}

export function initialOf(name: string | null | undefined): string {
  const s = (name || '').trim();
  return s ? s.charAt(0).toUpperCase() : '?';
}

/** Слить сообщения без дублей, отсортировать по id. */
export function mergeMessages(existing: SupportMessage[], incoming: SupportMessage[]): SupportMessage[] {
  if (incoming.length === 0) return existing;
  const map = new Map<number, SupportMessage>();
  for (const m of existing) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return Array.from(map.values()).sort((a, b) => a.id - b.id);
}

/** «9897 3971 0801 6689» */
export function formatLoyaltyId(id: string | null | undefined): string {
  const digits = String(id || '').replace(/\s+/g, '');
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}
