// Стан заявки для сторінки очікування: GET /api/status?id=… → pending | approved | rejected (з причиною) | unknown.
// id — випадковий UUID, який знає лише та сторінка, що надіслала заявку.

import { getReview, publicStatus } from '../lib/reviews.js';
import { json } from '../lib/telegram.js';

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const status = publicStatus(getReview(id));
  return json(status.status === 'unknown' ? 404 : 200, status);
}
