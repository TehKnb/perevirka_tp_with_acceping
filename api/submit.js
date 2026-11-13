// Функція відправки (її запускає server.js): приймає результати перевірки з форми й пересилає їх у Telegram —
// у гілку (topic) групи техпідтримки: спершу фото з підписом (ім'я, пакет/потік, короткий
// підсумок перевірок), потім аудіозапис, потім повідомлення «Рішення щодо заявки» з кнопками
// «Підтвердити» / «Відхилити» (api/telegram.js).
// Сайту повертає id заявки: за ним сторінка дізнається рішення техспеціаліста (api/status.js).
//
// Токен бота й адреса чату — лише в змінних оточення (Railway → Variables,
// локально — .env.local), у код сторінки вони не потрапляють:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID (необов'язково — без неї в загальний чат).

import { randomUUID } from 'node:crypto';
import { createReview } from '../lib/reviews.js';
import { escapeHtml, json, telegram, telegramEnv } from '../lib/telegram.js';
import { decisionKeyboard, decisionText } from './telegram.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 120;
const MAX_SUMMARY = 700; // підпис до фото в Telegram — до 1024 символів

function text(form, key, max) {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function textBlock(form, key, max) {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function file(form, key, typePrefix) {
  const v = form.get(key);
  if (!v || typeof v === 'string' || v.size === 0 || v.size > MAX_FILE_BYTES) return null;
  if (!v.type.startsWith(typePrefix)) return null;
  return v;
}

/** Як Telegram покаже аудіо: OGG/Opus — голосове, M4A/MP3 — аудіо з плеєром, решта — файлом. */
function audioMethod(type) {
  if (type.includes('ogg')) return { method: 'sendVoice', field: 'voice', ext: 'ogg' };
  if (type.includes('mp4') || type.includes('aac') || type.includes('m4a')) return { method: 'sendAudio', field: 'audio', ext: 'm4a' };
  if (type.includes('mpeg')) return { method: 'sendAudio', field: 'audio', ext: 'mp3' };
  return { method: 'sendDocument', field: 'document', ext: type.includes('webm') ? 'webm' : 'bin' };
}

/** Ім'я файлу без пробілів і спецсимволів: лише літери, цифри й дефіс. */
function fileStem(name) {
  const stem = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return stem || 'uchasnyk';
}

export async function POST(request) {
  const { token, chatId, thread } = telegramEnv();
  if (!token || !chatId) {
    console.error('submit: не задано TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID');
    return json(500, { ok: false, error: 'not_configured' });
  }

  // Приймаємо лише запити з нашої ж сторінки (захист від відправки з чужих сайтів).
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json(403, { ok: false, error: 'origin' });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json(400, { ok: false, error: 'bad_form' });
  }

  const name = text(form, 'name', MAX_TEXT);
  const stream = text(form, 'stream', MAX_TEXT);
  const summary = textBlock(form, 'summary', MAX_SUMMARY);
  const photo = file(form, 'photo', 'image/');
  const audio = file(form, 'audio', 'audio/');
  if (!name || !stream || !photo || !audio) return json(400, { ok: false, error: 'missing_fields' });

  const caption =
    `<b>Нова попередня перевірка відео та звуку</b>\n\n` +
    `<b>Ім’я та прізвище:</b> ${escapeHtml(name)}\n` +
    `<b>Пакет / потік:</b> ${escapeHtml(stream)}` +
    (summary ? `\n\n${escapeHtml(summary)}` : '');
  const stem = fileStem(name);
  const id = randomUUID();

  try {
    const sent = await telegram(token, 'sendPhoto', {
      chat_id: chatId,
      message_thread_id: thread,
      photo: [photo, `${stem}.jpg`],
      caption,
      parse_mode: 'HTML',
    });

    const a = audioMethod(audio.type);
    const audioFields = {
      chat_id: chatId,
      message_thread_id: thread,
      caption: `Аудіо: ${name}`.slice(0, 1024),
      reply_parameters: { message_id: sent.message_id, allow_sending_without_reply: true },
    };
    try {
      await telegram(token, a.method, { ...audioFields, [a.field]: [audio, `${stem}.${a.ext}`] });
    } catch (err) {
      // Якщо Telegram не прийняв формат як аудіо/голосове — надсилаємо просто файлом.
      if (a.method === 'sendDocument') throw err;
      console.warn('submit: аудіо не прийнято, надсилаємо файлом —', err.message);
      await telegram(token, 'sendDocument', { ...audioFields, document: [audio, `${stem}.${a.ext}`] });
    }

    // Окреме повідомлення з кнопками рішення — після фото й аудіо (під ним кнопки видно й у Telegram Desktop).
    const pending = { name, status: 'pending', by: null };
    const decision = await telegram(token, 'sendMessage', {
      chat_id: chatId,
      message_thread_id: thread,
      reply_parameters: { message_id: sent.message_id, allow_sending_without_reply: true },
      text: decisionText(pending),
      parse_mode: 'HTML',
      reply_markup: decisionKeyboard(id),
    });
    createReview(id, { name, chatId: String(chatId), thread, decisionMessageId: decision.message_id });
    console.log(`submit: заявка ${id} надіслана, кнопки рішення ${decision.reply_markup ? 'є' : 'Telegram не прийняв'}`);
  } catch (err) {
    console.error('submit: Telegram відхилив запит —', err.message);
    return json(502, { ok: false, error: 'telegram' });
  }

  return json(200, { ok: true, id });
}
