// Шрифти бренд-буку з npm: файли лежать разом із сайтом, без звернень до Google Fonts.
import '@fontsource-variable/commissioner';
import '@fontsource-variable/roboto-condensed';
import './styles.css';
import { config } from './config';
import { isMobileDevice, readDeviceEnv } from './env';
import { MediaManager } from './media/mediaManager';
import { isQuickTest, quickCaptures } from './debug/quickTest';
import { loadReview, saveReview } from './review/review';
import type { Captures } from './screens/captureControls';
import { createDevicesScreen } from './screens/devicesScreen';
import { createReviewScreen } from './screens/reviewScreen';
import { createSetupScreen } from './screens/setupScreen';
import { createSubmitScreen } from './screens/submitScreen';
import { applyTexts, byId, showScreen } from './ui/dom';
import { applyIcons } from './ui/icons';
import { initScale } from './ui/scale';
import { loadVisionModels, type VisionModels } from './vision/models';

function boot() {
  applyTexts();
  applyIcons();
  initScale();

  byId('consent-notice').hidden = !config.ui.showConsentNotice;

  // Телефон чи планшет: лише приклади правильного налаштування й пояснення, що пройти
  // можна з комп'ютера. Кнопки «Почати» немає, тож камеру, мікрофон і моделі не запитуємо.
  if (config.ui.blockMobile && isMobileDevice(readDeviceEnv())) {
    byId('phone-note').hidden = false;
    byId('screen-start').classList.add('phone-view');
    byId('btn-start').remove();
    showScreen('start');
    return;
  }

  const review = createReviewScreen();
  const discord = byId<HTMLAnchorElement>('done-discord');
  if (config.ui.discordUrl) discord.href = config.ui.discordUrl;
  byId('done-test-mode').hidden = !config.submit.testMode;

  // Заявку вже надіслано (людина закрила вкладку й повернулася) — одразу екран очікування,
  // без камери й моделей.
  // У швидкому тесті кожен раз нова заявка.
  const quick = isQuickTest();
  const pending = quick ? null : loadReview(config.review);
  if (pending) {
    showScreen('done');
    review.start(pending);
    return;
  }

  const media = new MediaManager();

  // Моделі (~10 МБ + wasm) починаємо вантажити одразу після «Почати»,
  // поки людина дає дозвіл і обирає пристрої. Після помилки дозволяємо повторити.
  let modelsPromise: Promise<VisionModels> | null = null;
  const getModels = () => {
    modelsPromise ??= loadVisionModels().catch((err) => {
      modelsPromise = null;
      throw err;
    });
    return modelsPromise;
  };

  const setup = createSetupScreen(media, getModels);
  const devices = createDevicesScreen(media, () => {
    showScreen('setup');
    void setup.enter();
  });

  byId('btn-start').addEventListener('click', () => {
    getModels().catch(() => {
      /* помилку покаже екран налаштування */
    });
    showScreen('devices');
    void devices.enter();
  });

  // Фото й звук готові → форма відправки. Камеру не вимикаємо: людина може повернутися й перезняти.
  let quickData: Captures | null = null;
  const submit = createSubmitScreen({
    collect: () => ({
      captures: quickData ?? setup.getCaptures(),
      network: setup.getNetwork(),
      devices: { camera: media.videoLabel, microphone: media.audioLabel },
      userAgent: navigator.userAgent,
    }),
    onBack: () => {
      if (quick) {
        location.href = location.pathname; // зі швидкого тесту — у звичайну перевірку
        return;
      }
      showScreen('setup');
      void setup.enter();
    },
    onDone: (id) => {
      media.stop();
      const sent = id ? { id, sentAt: Date.now() } : null;
      if (sent) saveReview(config.review, sent);
      showScreen('done');
      review.start(sent);
    },
  });

  setup.onSend(() => {
    setup.leave();
    showScreen('submit');
    submit.enter();
  });

  // Рядок «Тестовий режим…» — лише коли відправку вимкнено в налаштуваннях.
  byId('submit-test-mode').hidden = !config.submit.testMode;

  byId('btn-change-devices').addEventListener('click', () => {
    setup.leave();
    showScreen('devices');
    void devices.enter();
  });

  // Звільняємо камеру й мікрофон, коли людина закриває вкладку.
  window.addEventListener('pagehide', () => media.stop());

  // ТИМЧАСОВО: швидкий тест — одразу форма, замість фото й звуку заглушки.
  if (quick) {
    void quickCaptures().then((captures) => {
      quickData = captures;
      const note = byId('submit-test-mode');
      note.textContent = 'Швидкий тест: замість фото й звуку надсилається заглушка. У Telegram прийде справжня заявка з кнопками.';
      note.hidden = false;
      showScreen('submit');
      submit.enter();
    });
    return;
  }

  showScreen('start');
}

boot();
