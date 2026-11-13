import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { loadEnv, type Connect, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Локальний аналог функції Vercel api/speedtest-upload.js: приймає дані для заміру віддачі
 * й відкидає їх. Потрібен, щоб перевірка інтернету працювала в `npm run dev` і `npm run preview`.
 */
function speedtestUpload(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/api/speedtest-upload')) return next();
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    req.on('data', () => {});
    req.on('end', () => {
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    });
  };
  return {
    name: 'speedtest-upload',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

/** Функції з api/, які запускаємо локально: шлях → метод і файл. Вебхук Telegram локально не працює. */
const LOCAL_API: Record<string, { method: 'GET' | 'POST'; file: string }> = {
  '/api/submit': { method: 'POST', file: 'api/submit.js' },
  '/api/status': { method: 'GET', file: 'api/status.js' },
};

/**
 * Локальний запуск функцій api/submit.js (відправка в Telegram) і api/status.js (стан заявки)
 * у `npm run dev` і `npm run preview`.
 * Токен і чат беруться з .env.local (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID).
 */
function localSubmitApi(): Plugin {
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const route = LOCAL_API[(req.url ?? '').split('?')[0]!];
    if (!route) return next();
    if (req.method !== route.method) {
      res.statusCode = 405;
      res.end();
      return;
    }
    try {
      // Сам файл перечитуємо на кожен запит; спільні модулі з lib/ (сховище заявок) лишаються одні.
      const mod = await import(`${pathToFileURL(resolve(route.file)).href}?t=${Date.now()}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: route.method,
        headers,
        ...(route.method === 'POST' ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
      } as RequestInit);
      const response: Response = await mod[route.method](request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      next(err);
    }
  };
  /**
   * Кнопки «Підтвердити» / «Відхилити» локально: вебхук до localhost не дійде, тож сервер сам питає
   * Telegram про натискання. Вимкнути — TELEGRAM_POLLING=0; з TELEGRAM_WEBHOOK_URL не вмикається.
   */
  function startTelegramPolling(httpServer: { once(event: 'close', cb: () => void): unknown } | null) {
    // Vitest теж піднімає сервер Vite з цими плагінами — у тестах до справжнього Telegram не звертаємося.
    if (process.env.VITEST) return;
    if (process.env.TELEGRAM_POLLING === '0' || process.env.TELEGRAM_WEBHOOK_URL || !process.env.TELEGRAM_BOT_TOKEN) return;
    const stop = new AbortController();
    httpServer?.once('close', () => stop.abort());
    void import(pathToFileURL(resolve('api/telegram.js')).href).then((m) => m.startPolling(stop.signal));
  }

  return {
    name: 'local-submit-api',
    configResolved(config) {
      Object.assign(process.env, loadEnv(config.mode, process.cwd(), 'TELEGRAM_'));
    },
    configureServer: (server) => {
      server.middlewares.use(handler);
      startTelegramPolling(server.httpServer);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler);
      startTelegramPolling(server.httpServer);
    },
  };
}

export default defineConfig({
  plugins: [speedtestUpload(), localSubmitApi()],
  server: {
    // Решта /api у розробці проксіюється на тестовий Node-сервер (етап 5).
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.js'],
    environment: 'node',
  },
});
