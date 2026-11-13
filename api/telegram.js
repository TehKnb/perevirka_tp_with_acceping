// Рішення техспеціаліста щодо заявки: кнопки в Telegram і відповідь із причиною відмови.
//
// Після фото й аудіо бот надсилає окреме повідомлення «Рішення щодо заявки» з кнопками
// (під текстовим повідомленням їх показує й Telegram Desktop):
//   «Підтвердити» → повідомлення змінюється на «✅ Підтверджено · ім'я», людина бачить це на сайті.
//   «Відхилити»   → бот просить написати причину у відповідь на його повідомлення
//                   (кнопка «Скасувати відмову» повертає заявку в очікування).
//   Відповідь із причиною → «❌ Відхилено · ім'я» з причиною, людина бачить цей текст на сайті.
//
// Оновлення від Telegram приходять двома шляхами, обробка одна (handleUpdate):
//   на сервері — вебхук POST /api/telegram (адресу реєструє server.js: TELEGRAM_WEBHOOK_URL, TELEGRAM_WEBHOOK_SECRET);
//   локально — опитування getUpdates (startPolling), бо до localhost Telegram не достукається.

import { findByPrompt, getReview } from '../lib/reviews.js';
import { escapeHtml, json, telegram, telegramEnv } from '../lib/telegram.js';

const MAX_REASON = 500;

/** Кнопки під повідомленням «Рішення щодо заявки». */
export function decisionKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Підтвердити', callback_data: `ok:${id}` },
        { text: '❌ Відхилити', callback_data: `no:${id}` },
      ],
    ],
  };
}

/** Текст повідомлення з рішенням для кожного стану заявки. */
export function decisionText(review) {
  const name = `<b>${escapeHtml(review.name)}</b>`;
  const by = review.by ? escapeHtml(review.by) : '';
  switch (review.status) {
    case 'approved':
      return `✅ Підтверджено · ${by}\nЗаявка: ${name}`;
    case 'rejecting':
      return `✍️ Відхилення · ${by}\nЗаявка: ${name}\nЧекаємо причину — напишіть її у відповідь на повідомлення бота нижче.`;
    case 'rejected':
      return `❌ Відхилено · ${by}\nЗаявка: ${name}\nПричина: ${escapeHtml(review.reason ?? '')}`;
    default:
      return `🕓 Рішення щодо заявки: ${name}\nПерегляньте фото й аудіо вище та оберіть:`;
  }
}

function personName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return (name || user?.username || 'техпідтримка').slice(0, 40);
}

/** Оновлює повідомлення з рішенням відповідно до стану заявки. */
async function showDecision(token, review, keyboard = { inline_keyboard: [] }) {
  await telegram(token, 'editMessageText', {
    chat_id: review.chatId,
    message_id: review.decisionMessageId,
    text: decisionText(review),
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

async function answer(token, callbackId, text, alert = false) {
  await telegram(token, 'answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: alert || undefined });
}

async function onCallback(token, chatId, q) {
  if (String(q.message?.chat?.id) !== String(chatId)) return;
  const [action, id] = String(q.data ?? '').split(':');
  const review = getReview(id);
  if (!review) {
    return answer(token, q.id, 'Заявку не знайдено: сервер перезапускався. Напишіть учаснику в Discord.', true);
  }
  const who = personName(q.from);

  if (action === 'ok' && review.status === 'pending') {
    review.status = 'approved';
    review.by = who;
    await showDecision(token, review);
    return answer(token, q.id, 'Підтверджено. Учасник побачить це на сайті.');
  }

  if (action === 'no' && review.status === 'pending') {
    review.status = 'rejecting';
    review.by = who;
    const prompt = await telegram(token, 'sendMessage', {
      chat_id: review.chatId,
      message_thread_id: review.thread,
      reply_parameters: { message_id: review.decisionMessageId, allow_sending_without_reply: true },
      parse_mode: 'HTML',
      text:
        `<a href="tg://user?id=${q.from.id}">${escapeHtml(who)}</a>, напишіть причину відмови для ` +
        `«${escapeHtml(review.name)}» у відповідь на це повідомлення. Її побачить учасник на сайті.`,
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Причина відмови' },
    });
    review.promptMessageId = prompt.message_id;
    await showDecision(token, review, {
      inline_keyboard: [[{ text: '↩️ Скасувати відмову', callback_data: `undo:${id}` }]],
    });
    return answer(token, q.id, 'Напишіть причину у відповідь на повідомлення бота.');
  }

  if (action === 'undo' && review.status === 'rejecting') {
    review.status = 'pending';
    review.by = null;
    await deleteMessage(token, review.chatId, review.promptMessageId);
    review.promptMessageId = null;
    await showDecision(token, review, decisionKeyboard(id));
    return answer(token, q.id, 'Відмову скасовано.');
  }

  return answer(token, q.id, 'Заявку вже оброблено.');
}

/**
 * Прохання написати причину надсилається з force_reply, і Telegram Desktop знову й знову відкриває
 * поле відповіді на нього, навіть коли відповідь уже є. Тож, щойно воно не потрібне, бот його видаляє.
 */
async function deleteMessage(token, chatId, messageId) {
  if (!messageId) return;
  await telegram(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch((err) =>
    console.warn('telegram: не вдалося видалити прохання причини —', err.message),
  );
}

const isReasonPrompt = (msg) => Boolean(msg?.from?.is_bot) && /напишіть причину відмови/.test(msg?.text ?? '');

async function onMessage(token, chatId, m) {
  if (String(m.chat?.id) !== String(chatId)) return;
  const replyTo = m.reply_to_message?.message_id;
  const reason = typeof m.text === 'string' ? m.text.trim().slice(0, MAX_REASON) : '';
  if (!replyTo || !reason) return;
  const review = findByPrompt(replyTo);
  if (!review) {
    // Відповідь на застаріле прохання (заявку вже оброблено або сервер перезапускався) — прибираємо його.
    if (isReasonPrompt(m.reply_to_message)) await deleteMessage(token, chatId, replyTo);
    return;
  }
  review.status = 'rejected';
  review.reason = reason;
  review.by = personName(m.from);
  await showDecision(token, review);
  await deleteMessage(token, review.chatId, review.promptMessageId);
  review.promptMessageId = null;
}

/** Одне оновлення від Telegram (з вебхука чи з опитування). */
export async function handleUpdate(update) {
  const { token, chatId } = telegramEnv();
  if (!token || !chatId) return;
  if (update.callback_query) await onCallback(token, chatId, update.callback_query);
  else if (update.message) await onMessage(token, chatId, update.message);
}

export async function POST(request) {
  const { token, chatId } = telegramEnv();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !chatId || !secret) return json(503, { ok: false, error: 'not_configured' });
  if (request.headers.get('x-telegram-bot-api-secret-token') !== secret) return json(403, { ok: false });

  let update;
  try {
    update = await request.json();
  } catch {
    return json(400, { ok: false });
  }
  // Помилки обробки лише логуємо й відповідаємо 200: інакше Telegram повторюватиме те саме оновлення.
  try {
    await handleUpdate(update);
  } catch (err) {
    console.error('telegram: не вдалося обробити оновлення —', err.message);
  }
  return json(200, { ok: true });
}

/** Реєструє адресу вебхука в Telegram (кличе server.js під час запуску). */
export async function registerWebhook() {
  const { token } = telegramEnv();
  const url = process.env.TELEGRAM_WEBHOOK_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !url) return;
  if (!secret) {
    console.error('telegram: TELEGRAM_WEBHOOK_URL задано, а TELEGRAM_WEBHOOK_SECRET — ні; вебхук не зареєстровано');
    return;
  }
  try {
    await telegram(token, 'setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['callback_query', 'message'],
    });
    console.log(`telegram: вебхук зареєстровано на ${url}`);
  } catch (err) {
    console.error('telegram: не вдалося зареєструвати вебхук —', err.message);
  }
}

const POLL_TIMEOUT_SEC = 25;

/**
 * Локальний режим: сервер сам питає Telegram про натискання (getUpdates), бо вебхук до localhost не дійде.
 * Якщо в бота зареєстровано вебхук (друга версія вже працює на Railway), Telegram відповідає «Conflict» —
 * тоді опитування зупиняється, а вебхук не чіпаємо.
 */
export async function startPolling(signal) {
  const { token } = telegramEnv();
  if (!token) return;
  console.log('telegram: локальний режим — натискання кнопок отримуємо опитуванням (getUpdates)');
  let offset = 0;
  while (!signal?.aborted) {
    try {
      const updates = await telegram(
        token,
        'getUpdates',
        { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['callback_query', 'message'] },
        (POLL_TIMEOUT_SEC + 10) * 1000,
      );
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((err) => console.error('telegram: не вдалося обробити оновлення —', err.message));
      }
    } catch (err) {
      if (signal?.aborted) return;
      if (/conflict/i.test(err.message)) {
        console.error('telegram: у бота зареєстровано вебхук або його вже опитує інший процес — локальне опитування зупинено.', err.message);
        return;
      }
      console.warn('telegram: опитування не вдалося, повтор за 5 с —', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
