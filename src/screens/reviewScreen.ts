import { config } from '../config';
import {
  clearReview,
  fetchReviewStatus,
  formatCountdown,
  isFinal,
  msLeft,
  reviewView,
  type ReviewStatus,
  type ReviewView,
  type StoredReview,
} from '../review/review';
import { t } from '../texts';
import { byId } from '../ui/dom';

const EMOJI: Record<ReviewView, string> = { waiting: '⏳', overdue: '⏳', approved: '🎉', rejected: '⚠️', lost: '⚠️' };

/**
 * Екран 5: після відправки — таймер очікування рішення техпідтримки (кнопки в Telegram),
 * потім «Технічне налаштування пройдено» або «відхилено» з причиною.
 * Сторінка питає сервер кожні кілька секунд; коли вкладка знову стає видимою — одразу.
 */
export function createReviewScreen() {
  const c = config.review;
  const screen = document.querySelector<HTMLElement>('[data-screen="done"]')!;
  const emoji = byId('review-emoji');
  const title = byId('review-title');
  const body = byId('review-body');
  const timerBox = byId('review-timer-box');
  const timer = byId('review-timer');
  const reasonBox = byId('review-reason-box');
  const reason = byId('review-reason');
  const discordCard = byId('review-discord-card');
  const discordText = byId('review-discord-text');
  const discordLink = byId<HTMLAnchorElement>('done-discord');
  const retry = byId<HTMLButtonElement>('btn-review-retry');
  const baseTitle = document.title;

  let review: StoredReview | null = null;
  let status: ReviewStatus = { status: 'pending' };
  let shown: ReviewView | null = null;
  let tick: number | undefined;
  let poll: number | undefined;

  retry.addEventListener('click', () => {
    clearReview(c);
    location.reload();
  });

  function discord(text: string | null) {
    discordCard.hidden = text === null;
    if (text !== null) discordText.textContent = text;
    discordLink.hidden = text === null || !config.ui.discordUrl;
  }

  function render(view: ReviewView) {
    if (view === 'waiting' || view === 'overdue') timer.textContent = formatCountdown(review ? msLeft(review.sentAt, Date.now(), c) : 0);
    if (view === shown) return;
    shown = view;
    screen.dataset.view = view;
    emoji.textContent = EMOJI[view];
    timerBox.hidden = view !== 'waiting';
    reasonBox.hidden = true;
    retry.hidden = !(view === 'rejected' || view === 'lost');
    const d = t.done;
    if (view === 'waiting') {
      title.textContent = d.waitingTitle;
      body.textContent = d.waitingBody(c.waitMinutes);
      discord(null);
    } else if (view === 'overdue') {
      title.textContent = d.overdueTitle;
      body.textContent = d.overdueBody;
      discord(d.overdueDiscord);
    } else if (view === 'approved') {
      title.textContent = d.approvedTitle;
      body.textContent = d.approvedBody;
      // Підтвердження техпідтримки — перевірку пройдено повністю, писати в Discord не потрібно.
      discord(null);
      document.title = `${d.tabApproved} · ${baseTitle}`;
    } else if (view === 'rejected') {
      title.textContent = d.rejectedTitle;
      body.textContent = d.rejectedBody;
      const text = status.status === 'rejected' ? status.reason : null;
      reasonBox.hidden = !text;
      reason.textContent = text ?? '';
      discord(d.rejectedDiscord);
      document.title = `${d.tabRejected} · ${baseTitle}`;
    } else {
      title.textContent = d.lostTitle;
      body.textContent = d.lostBody;
      discord(d.lostDiscord);
    }
  }

  function update() {
    if (!review) return render('waiting');
    const view = reviewView(status.status, msLeft(review.sentAt, Date.now(), c));
    render(view);
    // Рішення є — більше не питаємо й не пам'ятаємо заявку: після перезавантаження почнеться нова перевірка.
    if (isFinal(view)) {
      stop();
      clearReview(c);
    }
  }

  async function check() {
    if (!review) return;
    const next = await fetchReviewStatus(c, review.id);
    if (next) status = next;
    update();
  }

  function stop() {
    window.clearInterval(tick);
    window.clearInterval(poll);
    document.removeEventListener('visibilitychange', onVisible);
  }

  // У фоновій вкладці браузер рідко запускає таймери — коли людина повертається, питаємо одразу.
  function onVisible() {
    if (document.visibilityState === 'visible') void check();
  }

  return {
    /** review null — тестовий режим або сервер не дав id: лише екран очікування без опитування. */
    start(r: StoredReview | null) {
      stop();
      review = r;
      status = { status: 'pending' };
      shown = null;
      update();
      if (!r) return;
      tick = window.setInterval(update, 1000);
      poll = window.setInterval(() => void check(), c.pollMs);
      document.addEventListener('visibilitychange', onVisible);
      void check();
    },
  };
}
