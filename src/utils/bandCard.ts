import { compareBandLabels } from '../hooks/useAntenasData';
import { OPERATOR_META, type OperatorKey } from '../types/antena';
import type { MapSiteEntry } from './geo';

export interface BandCardRow {
  op: OperatorKey;
  color: string;
  text: string;
}

export const BAND_CARD_KEY_PREFIX = 'bandcard:';
export const BAND_CARD_PIXEL_RATIO = 2;

const BAND_CARD_FONT =
  '700 21px "Plus Jakarta Sans", Inter, system-ui, -apple-system, sans-serif';
const PAD_X = 14;
const PAD_Y = 8;
const LINE_HEIGHT = 26;
const CORNER_RADIUS = 10;
const SHADOW_PAD_X = 8;
const SHADOW_PAD_TOP = 4;
const SHADOW_PAD_BOTTOM = 10;
const FALLBACK_CHAR_WIDTH = 12.2;

const MMWAVE_26GHZ_MISBUCKET_RE = /^2[67]\s*mhz$/i;
const TRAILING_MHZ_RE = /\s*mhz$/i;

const BAND_CARD_SPRITE_CACHE = new Map<string, ImageData>();

function normalizeMmwaveBandLabel(trimmed: string): string {
  if (MMWAVE_26GHZ_MISBUCKET_RE.test(trimmed)) {
    return '26 GHz';
  }
  return trimmed;
}

function isValidOperatorKey(value: string): value is OperatorKey {
  return (
    value === 'movistar' ||
    value === 'vodafone' ||
    value === 'orange' ||
    value === 'masmovil' ||
    value === 'digi' ||
    value === 'otros'
  );
}

function createEmptyImageData(width: number, height: number): ImageData {
  const safeWidth = Math.max(1, Math.ceil(width));
  const safeHeight = Math.max(1, Math.ceil(height));
  if (typeof ImageData !== 'undefined') {
    return new ImageData(safeWidth, safeHeight);
  }
  return {
    width: safeWidth,
    height: safeHeight,
    data: new Uint8ClampedArray(safeWidth * safeHeight * 4),
  } as ImageData;
}

function traceRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function formatCompactBandToken(band: string): string {
  const trimmed = band.trim();
  if (!trimmed) {
    return '';
  }
  if (MMWAVE_26GHZ_MISBUCKET_RE.test(trimmed)) {
    return '26 GHz';
  }
  if (TRAILING_MHZ_RE.test(trimmed)) {
    return trimmed.replace(TRAILING_MHZ_RE, '').trim();
  }
  return trimmed;
}

export function formatAntennaBandsCompact(
  bandas: readonly string[] | undefined | null,
): string {
  if (!bandas || bandas.length === 0) {
    return '';
  }

  const uniqueNormalizedLabels = new Set<string>();
  for (let i = 0; i < bandas.length; i++) {
    const raw = bandas[i];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    uniqueNormalizedLabels.add(normalizeMmwaveBandLabel(trimmed));
  }

  if (uniqueNormalizedLabels.size === 0) {
    return '';
  }

  const sortedLabels = Array.from(uniqueNormalizedLabels).sort(
    compareBandLabels,
  );

  const uniqueTokens: string[] = [];
  const seenTokens = new Set<string>();
  for (let i = 0; i < sortedLabels.length; i++) {
    const token = formatCompactBandToken(sortedLabels[i]);
    if (token && !seenTokens.has(token)) {
      seenTokens.add(token);
      uniqueTokens.push(token);
    }
  }

  return uniqueTokens.join(' ');
}

export function buildSiteBandCardRows(
  site: Pick<MapSiteEntry, 'members'>,
): BandCardRow[] {
  const rows: BandCardRow[] = [];
  const members = site.members;
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const text = formatAntennaBandsCompact(member.bandas);
    if (!text) {
      continue;
    }
    rows.push({
      op: member.op,
      color: OPERATOR_META[member.op]?.color ?? OPERATOR_META.otros.color,
      text,
    });
  }
  return rows;
}

export function buildSiteBandCardKey(
  site: Pick<MapSiteEntry, 'members'>,
): string {
  const rows = buildSiteBandCardRows(site);
  if (rows.length === 0) {
    return '';
  }
  return (
    BAND_CARD_KEY_PREFIX + rows.map((row) => `${row.op}:${row.text}`).join('|')
  );
}

export function parseSiteBandCardKey(key: string): BandCardRow[] {
  if (!key.startsWith(BAND_CARD_KEY_PREFIX)) {
    return [];
  }
  const payload = key.slice(BAND_CARD_KEY_PREFIX.length);
  if (!payload) {
    return [];
  }
  const segments = payload.split('|');
  const rows: BandCardRow[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const colonIdx = segment.indexOf(':');
    if (colonIdx <= 0) {
      continue;
    }
    const opRaw = segment.slice(0, colonIdx);
    const text = segment.slice(colonIdx + 1).trim();
    if (!isValidOperatorKey(opRaw) || text.length === 0) {
      continue;
    }
    rows.push({
      op: opRaw,
      color: OPERATOR_META[opRaw].color,
      text,
    });
  }

  return rows;
}

export function renderBandCardSprite(rows: readonly BandCardRow[]): ImageData {
  const canvas =
    typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas ? canvas.getContext('2d') : null;

  if (ctx) {
    ctx.font = BAND_CARD_FONT;
  }

  let maxTextWidth = 0;
  for (let i = 0; i < rows.length; i++) {
    const text = rows[i].text;
    const measuredWidth = ctx ? (ctx.measureText(text)?.width ?? 0) : 0;
    const rowWidth =
      Number.isFinite(measuredWidth) && measuredWidth > 0
        ? Math.ceil(measuredWidth)
        : Math.ceil(text.length * FALLBACK_CHAR_WIDTH);
    if (rowWidth > maxTextWidth) {
      maxTextWidth = rowWidth;
    }
  }

  const boxX = SHADOW_PAD_X;
  const boxY = SHADOW_PAD_TOP;
  const boxW = Math.max(1, maxTextWidth + PAD_X * 2);
  const boxH = Math.max(1, rows.length * LINE_HEIGHT + PAD_Y * 2);
  const canvasWidth = boxW + SHADOW_PAD_X * 2;
  const canvasHeight = boxH + SHADOW_PAD_TOP + SHADOW_PAD_BOTTOM;

  if (canvas) {
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
  }

  if (!ctx) {
    return createEmptyImageData(canvasWidth, canvasHeight);
  }

  ctx.save();
  traceRoundedRectPath(ctx, boxX, boxY, boxW, boxH, CORNER_RADIUS);
  ctx.shadowColor = 'rgba(15, 23, 42, 0.22)';
  ctx.shadowBlur = 7;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();

  traceRoundedRectPath(ctx, boxX, boxY, boxW, boxH, CORNER_RADIUS);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.14)';
  ctx.stroke();

  ctx.font = BAND_CARD_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const centerX = boxX + boxW / 2;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowY = boxY + PAD_Y + i * LINE_HEIGHT + LINE_HEIGHT / 2;
    ctx.fillStyle = row.color;
    ctx.fillText(row.text, centerX, rowY);
  }

  return ctx.getImageData(0, 0, canvasWidth, canvasHeight);
}

export function getOrCreateBandCardSprite(key: string): ImageData | null {
  if (!key) {
    return null;
  }
  const cached = BAND_CARD_SPRITE_CACHE.get(key);
  if (cached) {
    return cached;
  }
  const rows = parseSiteBandCardKey(key);
  if (rows.length === 0) {
    return null;
  }
  const sprite = renderBandCardSprite(rows);
  BAND_CARD_SPRITE_CACHE.set(key, sprite);
  return sprite;
}

export function clearBandCardSpriteCache(): void {
  BAND_CARD_SPRITE_CACHE.clear();
}
