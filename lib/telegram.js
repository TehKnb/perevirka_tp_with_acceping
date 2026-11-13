// Виклики Telegram Bot API. Токен лише зі змінних оточення, у відповіді сайту він не потрапляє.

const TELEGRAM_TIMEOUT_MS = 60_000; // щоб сторінка не чекала вічно, якщо Telegram не відповідає

/**
 * Метод Bot API з полями форми. Файли — як [Blob, ім'я файлу]; об'єкти й масиви (reply_markup,
 * allowed_updates тощо) — як JSON. Порожні значення пропускаємо.
 */
export async function telegram(token, method, fields, timeoutMs = TELEGRAM_TIMEOUT_MS) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v[0] instanceof Blob) body.append(k, v[0], v[1]);
    else if (typeof v === 'object') body.append(k, JSON.stringify(v));
    else body.append(k, String(v));
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`${method}: ${data.description ?? res.status}`);
  return data.result;
}

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Налаштування бота з оточення: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID (необов'язково). */
export function telegramEnv() {
  const threadId = process.env.TELEGRAM_THREAD_ID;
  return {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    thread: threadId ? Number(threadId) : undefined,
  };
}
