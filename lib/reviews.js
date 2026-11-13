// Заявки, що чекають рішення техспеціаліста. Зберігаються в пам'яті сервера: після перезапуску
// (наприклад, нового розгортання на Railway) заявки, що ще чекали, втрачаються — сайт тоді
// покаже людині «Не вдалося отримати відповідь» і запропонує написати в Discord.

const MAX_AGE_MS = 48 * 60 * 60 * 1000;
// Захист пам'яті від засмічення: найстаріші заявки видаляємо першими.
const MAX_REVIEWS = 5000;

/** Стани: pending → (rejecting → rejected) або approved. rejecting — чекаємо текст причини. */
const reviews = new Map();

function prune(now) {
  for (const [id, r] of reviews) {
    if (now - r.createdAt > MAX_AGE_MS || reviews.size > MAX_REVIEWS) reviews.delete(id);
    else break; // Map зберігає порядок додавання: далі лише новіші
  }
}

export function createReview(id, data, now = Date.now()) {
  prune(now);
  const review = { ...data, id, status: 'pending', reason: null, by: null, promptMessageId: null, createdAt: now };
  reviews.set(id, review);
  return review;
}

export function getReview(id) {
  return reviews.get(id) ?? null;
}

/** Заявка, для якої надіслано запит причини відмови з цим message_id. */
export function findByPrompt(messageId) {
  for (const r of reviews.values()) if (r.status === 'rejecting' && r.promptMessageId === messageId) return r;
  return null;
}

/** Що бачить сайт: rejecting для людини — ще очікування. */
export function publicStatus(review) {
  if (!review) return { status: 'unknown' };
  if (review.status === 'approved') return { status: 'approved' };
  if (review.status === 'rejected') return { status: 'rejected', reason: review.reason };
  return { status: 'pending' };
}

/** Лише для тестів. */
export function clearReviews() {
  reviews.clear();
}
