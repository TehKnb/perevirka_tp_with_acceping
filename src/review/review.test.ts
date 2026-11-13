import { describe, expect, it } from 'vitest';
import { formatCountdown, isFinal, msLeft, reviewView } from './review';

describe('reviewView', () => {
  it('рішення техпідтримки важливіше за таймер', () => {
    expect(reviewView('approved', 0)).toBe('approved');
    expect(reviewView('rejected', 60_000)).toBe('rejected');
  });

  it('очікування, поки час не вийшов, потім «затримується»', () => {
    expect(reviewView('pending', 1)).toBe('waiting');
    expect(reviewView('pending', 0)).toBe('overdue');
  });

  it('сервер не знає заявку — відповідь загубилася', () => {
    expect(reviewView('unknown', 60_000)).toBe('lost');
  });

  it('остаточні стани', () => {
    expect(['waiting', 'overdue', 'approved', 'rejected', 'lost'].filter((v) => isFinal(v as never))).toEqual([
      'approved',
      'rejected',
      'lost',
    ]);
  });
});

describe('таймер', () => {
  it('15 хвилин від відправки', () => {
    const sentAt = 1_000_000;
    expect(msLeft(sentAt, sentAt, { waitMinutes: 15 })).toBe(15 * 60_000);
    expect(msLeft(sentAt, sentAt + 14 * 60_000, { waitMinutes: 15 })).toBe(60_000);
    expect(msLeft(sentAt, sentAt + 20 * 60_000, { waitMinutes: 15 })).toBe(0);
  });

  it('формат хв:сс з округленням угору', () => {
    expect(formatCountdown(15 * 60_000)).toBe('15:00');
    expect(formatCountdown(14 * 60_000 + 59_001)).toBe('15:00');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(400)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});
