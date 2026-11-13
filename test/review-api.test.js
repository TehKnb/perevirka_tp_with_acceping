import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as status } from '../api/status.js';
import { POST as submit } from '../api/submit.js';
import { handleUpdate, startPolling, POST as webhook } from '../api/telegram.js';
import { clearReviews } from '../lib/reviews.js';

// Справжній Telegram не викликаємо: fetch підмінено, перевіряємо, що саме надіслали б.
let calls;
let nextMessageId;

function mockTelegram() {
  calls = [];
  nextMessageId = 100;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const fields = Object.fromEntries(
        [...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { name: v.name, type: v.type }]),
      );
      const messageId = ++nextMessageId;
      calls.push({ method, fields, messageId });
      const result = fields.reply_markup ? { message_id: messageId, reply_markup: JSON.parse(fields.reply_markup) } : { message_id: messageId };
      return new Response(JSON.stringify({ ok: true, result }));
    }),
  );
}

const SECRET = 'webhook-secret';
const CHAT = '-100123';
const tech = { id: 42, first_name: 'Олег', last_name: 'Технар' };

/** Надсилає заявку; повертає id і номер повідомлення з кнопками рішення. */
async function sendSubmission() {
  const form = new FormData();
  form.append('name', 'Іван Петренко');
  form.append('stream', 'Потік 7');
  form.append('photo', new File([new Uint8Array(2000)], 'photo.jpg', { type: 'image/jpeg' }));
  form.append('audio', new File([new Uint8Array(3000)], 'audio.m4a', { type: 'audio/mp4' }));
  const res = await submit(new Request('https://site.example/api/submit', { method: 'POST', body: form }));
  const decision = calls.find((c) => c.method === 'sendMessage');
  return { id: (await res.json()).id, decisionId: decision?.messageId };
}

function update(body, secret = SECRET) {
  return webhook(
    new Request('https://site.example/api/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify(body),
    }),
  );
}

const press = (data, chatId = CHAT) =>
  update({ callback_query: { id: 'cb1', from: tech, data, message: { chat: { id: Number(chatId) }, message_id: 103 } } });

const reply = (replyTo, text, chatId = CHAT) =>
  update({ message: { chat: { id: Number(chatId) }, from: tech, text, reply_to_message: { message_id: replyTo } } });

async function statusOf(id) {
  const res = await status(new Request(`https://site.example/api/status?id=${id}`));
  return { code: res.status, body: await res.json() };
}

const keyboardOf = (call) => JSON.parse(call.fields.reply_markup).inline_keyboard;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN';
  process.env.TELEGRAM_CHAT_ID = CHAT;
  process.env.TELEGRAM_THREAD_ID = '555';
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  clearReviews();
  mockTelegram();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('заявка з кнопками', () => {
  it('фото й аудіо без кнопок, потім окреме повідомлення з кнопками; сайт отримує id', async () => {
    const { id, decisionId } = await sendSubmission();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendAudio', 'sendMessage']);
    expect(calls[0].fields.reply_markup).toBeUndefined();
    const decision = calls[2].fields;
    expect(decision.message_thread_id).toBe('555');
    expect(decision.text).toContain('Іван Петренко');
    expect(JSON.parse(decision.reply_parameters).message_id).toBe(calls[0].messageId);
    const [ok, no] = keyboardOf(calls[2])[0];
    expect(ok).toEqual({ text: '✅ Підтвердити', callback_data: `ok:${id}` });
    expect(no).toEqual({ text: '❌ Відхилити', callback_data: `no:${id}` });
    expect(decisionId).toBe(calls[2].messageId);
    expect(await statusOf(id)).toEqual({ code: 200, body: { status: 'pending' } });
  });

  it('«Підтвердити» → сайт бачить approved, повідомлення з рішенням змінюється, кнопки зникають', async () => {
    const { id, decisionId } = await sendSubmission();
    calls = [];
    expect((await press(`ok:${id}`)).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['editMessageText', 'answerCallbackQuery']);
    expect(calls[0].fields.message_id).toBe(String(decisionId));
    expect(calls[0].fields.text).toContain('✅ Підтверджено · Олег Технар');
    expect(keyboardOf(calls[0])).toEqual([]);
    expect((await statusOf(id)).body).toEqual({ status: 'approved' });
  });

  it('«Відхилити» → бот просить причину; відповідь із причиною → rejected із цим текстом', async () => {
    const { id, decisionId } = await sendSubmission();
    calls = [];
    await press(`no:${id}`);
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'editMessageText', 'answerCallbackQuery']);
    const prompt = calls[0];
    expect(prompt.fields.message_thread_id).toBe('555');
    expect(JSON.parse(prompt.fields.reply_parameters).message_id).toBe(decisionId);
    expect(JSON.parse(prompt.fields.reply_markup).force_reply).toBe(true);
    expect(prompt.fields.text).toContain('Іван Петренко');
    expect(calls[1].fields.text).toContain('Чекаємо причину');
    expect(keyboardOf(calls[1])[0][0].callback_data).toBe(`undo:${id}`);
    // Поки причини немає — для людини це ще очікування.
    expect((await statusOf(id)).body).toEqual({ status: 'pending' });

    calls = [];
    await reply(prompt.messageId, '  Фон не однотонний: за спиною шафа.  ');
    // Прохання бота видаляється, інакше Telegram Desktop знову й знову відкриває поле відповіді.
    expect(calls.map((c) => c.method)).toEqual(['editMessageText', 'deleteMessage']);
    expect(calls[1].fields.message_id).toBe(String(prompt.messageId));
    expect(calls[0].fields.text).toContain('❌ Відхилено · Олег Технар');
    expect(calls[0].fields.text).toContain('Причина: Фон не однотонний: за спиною шафа.');
    expect((await statusOf(id)).body).toEqual({ status: 'rejected', reason: 'Фон не однотонний: за спиною шафа.' });
  });

  it('причина з HTML-символами екранується в Telegram, а на сайт іде як є', async () => {
    const { id } = await sendSubmission();
    await press(`no:${id}`);
    const promptId = calls.find((c) => c.method === 'sendMessage' && c.fields.text.includes('причину')).messageId;
    calls = [];
    await reply(promptId, 'Світло <лампа> & тінь');
    expect(calls[0].fields.text).toContain('Світло &lt;лампа&gt; &amp; тінь');
    expect((await statusOf(id)).body.reason).toBe('Світло <лампа> & тінь');
  });

  it('«Скасувати відмову» повертає кнопки й очікування', async () => {
    const { id } = await sendSubmission();
    await press(`no:${id}`);
    const promptId = calls.find((c) => c.method === 'sendMessage' && c.fields.text.includes('причину')).messageId;
    calls = [];
    await press(`undo:${id}`);
    expect(calls.map((c) => c.method)).toEqual(['deleteMessage', 'editMessageText', 'answerCallbackQuery']);
    expect(calls[0].fields.message_id).toBe(String(promptId));
    expect(keyboardOf(calls[1])[0].map((b) => b.callback_data)).toEqual([`ok:${id}`, `no:${id}`]);
    expect((await statusOf(id)).body).toEqual({ status: 'pending' });
    // Після скасування підтвердити ще можна.
    await press(`ok:${id}`);
    expect((await statusOf(id)).body).toEqual({ status: 'approved' });
  });

  it('повторне натискання після рішення нічого не змінює', async () => {
    const { id } = await sendSubmission();
    await press(`ok:${id}`);
    calls = [];
    await press(`no:${id}`);
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect((await statusOf(id)).body).toEqual({ status: 'approved' });
  });

  it('заявка, якої сервер не знає (перезапуск), — попередження техспеціалісту, сайт отримує unknown', async () => {
    await press('ok:00000000-0000-0000-0000-000000000000');
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(calls[0].fields.show_alert).toBe('true');
    expect(await statusOf('00000000-0000-0000-0000-000000000000')).toEqual({ code: 404, body: { status: 'unknown' } });
  });

  it('відповідь на застаріле прохання (сервер перезапускався) — бот видаляє це прохання', async () => {
    const stale = { message_id: 555, from: { id: 1, is_bot: true }, text: 'Kolya, напишіть причину відмови для «Іван» у відповідь на це повідомлення.' };
    await update({ message: { chat: { id: -100123 }, from: tech, text: 'тест', reply_to_message: stale } });
    expect(calls.map((c) => c.method)).toEqual(['deleteMessage']);
    expect(calls[0].fields.message_id).toBe('555');
  });

  it('відповіді не на запит причини й порожні відповіді ігноруються', async () => {
    const { id } = await sendSubmission();
    calls = [];
    await reply(999, 'просто повідомлення');
    await press(`no:${id}`);
    const promptId = calls.find((c) => c.method === 'sendMessage').messageId;
    calls = [];
    await reply(promptId, '   ');
    expect(calls).toEqual([]);
    expect((await statusOf(id)).body).toEqual({ status: 'pending' });
  });
});

describe('захист вебхука', () => {
  it('без правильного секрету — 403, нічого не змінюється', async () => {
    const { id } = await sendSubmission();
    calls = [];
    const res = await update({ callback_query: { id: 'x', from: tech, data: `ok:${id}`, message: { chat: { id: -100123 } } } }, 'wrong');
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect((await statusOf(id)).body).toEqual({ status: 'pending' });
  });

  it('натискання з іншого чату ігнорується', async () => {
    const { id } = await sendSubmission();
    calls = [];
    await press(`ok:${id}`, '-100999');
    expect(calls).toEqual([]);
    expect((await statusOf(id)).body).toEqual({ status: 'pending' });
  });

  it('секрет вебхука не задано — 503', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect((await update({}, '')).status).toBe(503);
  });

  it('помилка Telegram під час обробки — все одно 200, щоб Telegram не повторював', async () => {
    const { id } = await sendSubmission();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 400 })));
    expect((await press(`ok:${id}`)).status).toBe(200);
  });
});

describe('локальне опитування (getUpdates)', () => {
  it('отримує натискання й обробляє їх так само, як вебхук; offset рухається вперед', async () => {
    const { id } = await sendSubmission();
    const stop = new AbortController();
    const requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const method = String(url).split('/').pop();
        const fields = Object.fromEntries([...init.body.entries()]);
        requests.push({ method, fields });
        if (method !== 'getUpdates') return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        if (fields.offset === '0') {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [{ update_id: 7, callback_query: { id: 'cb', from: tech, data: `ok:${id}`, message: { chat: { id: -100123 } } } }],
            }),
          );
        }
        stop.abort();
        return new Response(JSON.stringify({ ok: true, result: [] }));
      }),
    );
    await startPolling(stop.signal);
    const polls = requests.filter((r) => r.method === 'getUpdates');
    expect(polls.map((r) => r.fields.offset)).toEqual(['0', '8']);
    expect(JSON.parse(polls[0].fields.allowed_updates)).toEqual(['callback_query', 'message']);
    expect((await statusOf(id)).body).toEqual({ status: 'approved' });
  });

  it('якщо в бота є вебхук (Conflict) — опитування зупиняється, вебхук не чіпаємо', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        expect(String(url)).not.toMatch(/deleteWebhook|setWebhook/);
        return new Response(JSON.stringify({ ok: false, description: 'Conflict: can\'t use getUpdates method while webhook is active' }), { status: 409 });
      }),
    );
    await startPolling(new AbortController().signal); // завершується сам
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handleUpdate без налаштувань нічого не робить', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await handleUpdate({ callback_query: { id: 'x', data: 'ok:1', message: { chat: { id: -100123 } } } });
    expect(calls).toEqual([]);
  });
});
