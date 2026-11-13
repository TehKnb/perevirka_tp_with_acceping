// ТИМЧАСОВО: швидкий тест відправки без камери й мікрофона (config.ui.quickTest + ?quick=1 у адресі).
// Замість фото — картинка з написом «ТЕСТ», замість запису — секунда тиші у WAV.

import { config } from '../config';
import type { Captures } from '../screens/captureControls';

export function isQuickTest(): boolean {
  return config.ui.quickTest && new URLSearchParams(location.search).has('quick');
}

function placeholderPhoto(): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#5a4bd1';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.font = 'bold 40px sans-serif';
  g.fillText('ТЕСТ', 320, 165);
  g.font = '24px sans-serif';
  g.fillText('без фото та звуку', 320, 210);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.9),
  );
}

/** Секунда тиші: WAV, 8 кГц, 8 біт, моно. */
function silentWav(): Blob {
  const rate = 8000;
  const view = new DataView(new ArrayBuffer(44 + rate));
  const ascii = (offset: number, s: string) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + rate, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, rate, true);
  for (let i = 0; i < rate; i++) view.setUint8(44 + i, 128);
  return new Blob([view.buffer], { type: 'audio/wav' });
}

/** Заглушки замість фото й запису. Результатів перевірок немає — у підсумку їх не буде. */
export async function quickCaptures(): Promise<Captures> {
  const now = new Date().toISOString();
  return {
    screenshot: { blob: await placeholderPhoto(), width: 640, height: 360, takenAt: now },
    audio: { blob: silentWav(), mime: 'audio/wav', durationMs: 1000, recordedAt: now, setup: null },
  } as unknown as Captures;
}
