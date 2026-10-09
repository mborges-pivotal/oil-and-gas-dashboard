/**
 * Avatar presets (mirrors server/avatars.js) and photo preparation: any
 * picture or camera frame is cropped to a centered square and shrunk to
 * 256 px before upload, so it stays small (WebP, else JPEG; ≤ 200 KB).
 */
export const AVATAR_EMOJIS = ['🦊', '🐻', '🐼', '🦉', '🐯', '🐸', '🐙', '🦁', '🐨', '🐧', '🦄', '🐳', '🐝', '🦋', '🐢', '🦜', '🐬', '🦒', '🦔', '🐿️', '🌵', '🌻', '🍀', '⚡', '🔥', '🛢️', '⛽', '🚀', '⭐', '🌙'];
export const AVATAR_COLORS = [1, 2, 3, 4, 5, 6, 7, 8]; // --series-N
export const randomPreset = () => ({
  emoji: AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)],
  color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
});

const SIZE = 256;
const MAX_BYTES = 200 * 1024;

/** An <img>, <video> or ImageBitmap source → square data URL ready to upload. */
export function squareDataUrl(source, srcW, srcH) {
  const side = Math.min(srcW, srcH);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, (srcW - side) / 2, (srcH - side) / 2, side, side, 0, 0, SIZE, SIZE);
  for (const [type, q] of [['image/webp', 0.85], ['image/webp', 0.7], ['image/jpeg', 0.85], ['image/jpeg', 0.6]]) {
    const url = canvas.toDataURL(type, q);
    if (url.startsWith(`data:${type}`) && url.length * 0.75 <= MAX_BYTES) return url;
  }
  throw new Error("Couldn't make that picture small enough");
}

/** A picked file → square data URL. */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) { reject(new Error('Pick an image file')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try { resolve(squareDataUrl(img, img.naturalWidth, img.naturalHeight)); } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be read")); };
    img.src = url;
  });
}
