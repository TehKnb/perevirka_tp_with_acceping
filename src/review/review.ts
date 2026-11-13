import type { AppConfig } from '../config';

/** Відповідь сервера про заявку (api/status.js). */
export type ReviewStatus =
  | { status: 'pending' }
  | { status: 'approved' }
  | { status: 'rejected'; reason: string | null }
  | { status: 'unknown' };

/** Що показує екран: очікування, затримка, підтверджено, відхилено, або відповідь загубилася. */
export type ReviewView = 'waiting' | 'overdue' | 'approved' | 'rejected' | 'lost';

/** Заявка, збережена в браузері. */
export interface StoredReview {
  id: string;
  /** Коли надіслано, мс від епохи. */
  sentAt: number;
}

type ReviewConfig = AppConfig['review'];

export function reviewView(status: ReviewStatus['status'], msLeft: number): ReviewView {
  if (status === 'approved' || status === 'rejected') return status;
  if (status === 'unknown') return 'lost';
  return msLeft > 0 ? 'waiting' : 'overdue';
}

export const isFinal = (view: ReviewView) => view === 'approved' || view === 'rejected' || view === 'lost';

/** Скільки лишилося до обіцяного часу відповіді. */
export function msLeft(sentAt: number, now: number, c: Pick<ReviewConfig, 'waitMinutes'>): number {
  return Math.max(0, sentAt + c.waitMinutes * 60_000 - now);
}

/** 14:05 — хвилини й секунди, округлені вгору, щоб 0:00 з'являлося лише наприкінці. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Сховище браузера може бути недоступне (приватний режим, заблоковані дані сайту) — тоді просто не запам'ятовуємо.

export function loadReview(c: ReviewConfig, now = Date.now()): StoredReview | null {
  try {
    const raw = localStorage.getItem(c.storageKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredReview>;
    if (typeof v.id !== 'string' || typeof v.sentAt !== 'number') return null;
    if (now - v.sentAt > c.maxAgeHours * 3_600_000) return null;
    return { id: v.id, sentAt: v.sentAt };
  } catch {
    return null;
  }
}

export function saveReview(c: ReviewConfig, review: StoredReview) {
  try {
    localStorage.setItem(c.storageKey, JSON.stringify(review));
  } catch {
    /* без збереження */
  }
}

export function clearReview(c: ReviewConfig) {
  try {
    localStorage.removeItem(c.storageKey);
  } catch {
    /* нічого */
  }
}

/** Рішення з сервера; null — не вдалося спитати (мережа), тоді спробуємо пізніше. */
export async function fetchReviewStatus(c: ReviewConfig, id: string): Promise<ReviewStatus | null> {
  try {
    const res = await fetch(`${c.statusEndpoint}?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.status === 404) return { status: 'unknown' };
    if (!res.ok) return null;
    const data = (await res.json()) as ReviewStatus;
    if (data.status === 'rejected') return { status: 'rejected', reason: typeof data.reason === 'string' ? data.reason : null };
    if (data.status === 'approved' || data.status === 'pending') return { status: data.status };
    return null;
  } catch {
    return null;
  }
}
