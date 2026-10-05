/**
 * Label colors: the preset palette the color button cycles through, hex
 * parsing for custom colors, and chip styles with readable text on any
 * background. PRESET_COLORS mirrors LABEL_PALETTE in server/db.js.
 */
export const PRESET_COLORS = [
  '#d73a4a', '#f9a03f', '#fbca04', '#0e8a16', '#008672', '#1d76db',
  '#5319e7', '#d876e3', '#f143ab', '#e99695', '#0075ca', '#6e7781',
];

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** '#abc' / 'F143AB' / '#f143ab' → '#f143ab'; null if it isn't a hex color. */
export function normalizeHex(value) {
  const v = String(value ?? '').trim();
  if (!HEX_RE.test(v)) return null;
  let hex = v.replace('#', '').toLowerCase();
  if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
  return `#${hex}`;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black text, whichever reads better on `hex`. */
export function inkFor(hex) {
  const L = luminance(hex);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / (0.0118 + 0.05)) ? '#ffffff' : '#111111';
}

/** Inline style for a colored label chip (falls back to the plain chip). */
export function labelChipStyle(label) {
  const color = normalizeHex(label?.color);
  return color ? { background: color, borderColor: color, color: inkFor(color) } : null;
}

/** The preset after `current` (the first one if `current` isn't a preset). */
export function nextPreset(current) {
  const i = PRESET_COLORS.indexOf(normalizeHex(current));
  return PRESET_COLORS[(i + 1) % PRESET_COLORS.length];
}
