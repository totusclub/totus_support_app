import {formatDuration, formatLoyaltyId, groupByDay, initialOf, mergeMessages} from '../src/utils/format';
import type {SupportMessage} from '../src/api/supportChat';

const msg = (id: number, createdAt: string): SupportMessage => ({
  id,
  chatId: 1,
  senderRole: 'user',
  senderId: 1,
  senderName: null,
  body: `m${id}`,
  meta: null,
  clientMsgId: null,
  readAt: null,
  createdAt,
});

describe('format utils', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(65)).toBe('01:05');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('formats loyalty id in groups of four', () => {
    expect(formatLoyaltyId('0978635637128057')).toBe('0978 6356 3712 8057');
    expect(formatLoyaltyId('0978 6356 3712 8057')).toBe('0978 6356 3712 8057');
  });

  it('merges messages without duplicates, sorted by id', () => {
    const a = [msg(1, '2026-09-01T10:00:00Z'), msg(3, '2026-09-01T10:02:00Z')];
    const b = [msg(2, '2026-09-01T10:01:00Z'), {...msg(3, '2026-09-01T10:02:00Z'), readAt: 'x'}];
    const r = mergeMessages(a, b);
    expect(r.map(m => m.id)).toEqual([1, 2, 3]);
    expect(r[2].readAt).toBe('x');
  });

  it('groups messages by day', () => {
    const g = groupByDay([
      msg(1, '2026-09-01T10:00:00'),
      msg(2, '2026-09-01T12:00:00'),
      msg(3, '2026-09-02T09:00:00'),
    ]);
    expect(g).toHaveLength(2);
    expect(g[0].messages).toHaveLength(2);
  });

  it('takes initial', () => {
    expect(initialOf(' анна')).toBe('А');
    expect(initialOf('')).toBe('?');
  });
});
