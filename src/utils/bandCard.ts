import {
  OPERATOR_META,
  type AntennaRecord,
  type ConcesionBanda,
  type OperatorKey,
} from '../types/antena';
import type { MapSiteEntry } from './geo';

export const ALL_BAND_CODES_ASC = [
  'N28',
  'N28+',
  'B20',
  'G9',
  'B3',
  'B1',
  'B38',
  'B7',
  'B7+',
  'N78',
  'N258',
] as const;

export type BandCode =
  | 'N258'
  | 'N78'
  | 'B7+'
  | 'B7'
  | 'B38'
  | 'B1'
  | 'B3'
  | 'G9'
  | 'B20'
  | 'N28+'
  | 'N28';

export type AntennaBandSource = Partial<
  Pick<AntennaRecord, 'bandas' | 'frecuencias' | 'concesiones'>
>;

export interface BandCardRow {
  op: OperatorKey;
  color: string;
  text: string;
}

export const BAND_CARD_KEY_PREFIX = 'bandcard:';
export const BAND_CARD_PIXEL_RATIO = 2;
export const BAND_SEPARATOR_DOT_COLOR = '#1E293B';
export const BAND_SEPARATOR_DOT_RADIUS = 2.2;
export const BAND_SEPARATOR_GAP_PX = 14;

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

const DIRECT_BAND_CODE_RE =
  /^(N258|N78|B7\+|B7|B38|B1|B3|G9|B20|N28\+|N28)$/i;
const FREQ_RANGE_RE =
  /^\s*(\d+(?:[.,]\d+)?)\s*(mhz|ghz)?\s*[-–—]\s*(\d+(?:[.,]\d+)?)\s*(mhz|ghz)?\s*$/i;
const SINGLE_FREQ_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(mhz|ghz)?\s*$/i;
const GENERIC_2600_BUCKET_RE =
  /^\s*(?:2600(?:\.0+)?(?:\s*mhz)?|2[.,]6(?:\d*)?\s*ghz)\s*$/i;
const GENERIC_700_BUCKET_RE = /^\s*700(?:\.0+)?(?:\s*mhz)?\s*$/i;
const LITERAL_N28_RE = /^n28$/i;
const LITERAL_N28_PLUS_RE = /^n28\+$/i;
const TRAILING_MHZ_RE = /\s*mhz$/i;

const BAND_CODE_SORT_MHZ: Record<BandCode, number> = {
  N258: 26000,
  N78: 3500,
  'B7+': 2685,
  B7: 2650,
  B38: 2595,
  B1: 2100,
  B3: 1800,
  G9: 900,
  B20: 800,
  'N28+': 773,
  N28: 700,
};

const BAND_CARD_SPRITE_CACHE = new Map<string, ImageData>();

interface ParsedFrequencySpan {
  loMhz: number;
  hiMhz: number;
  isRange: boolean;
}

function parseNumericValue(raw: string): number {
  return Number.parseFloat(raw.replace(',', '.'));
}

function parseFrequencySpanMhz(trimmed: string): ParsedFrequencySpan | null {
  const rangeMatch = FREQ_RANGE_RE.exec(trimmed);
  if (rangeMatch) {
    const rawLo = parseNumericValue(rangeMatch[1]);
    const unitLo = rangeMatch[2]?.toLowerCase();
    const rawHi = parseNumericValue(rangeMatch[3]);
    const unitHi = rangeMatch[4]?.toLowerCase();
    if (!Number.isFinite(rawLo) || !Number.isFinite(rawHi)) {
      return null;
    }
    const loIsGhz = unitLo === 'ghz' || (!unitLo && unitHi === 'ghz');
    const hiIsGhz = unitHi === 'ghz' || (!unitHi && unitLo === 'ghz');
    const loMhz = loIsGhz ? rawLo * 1000 : rawLo;
    const hiMhz = hiIsGhz ? rawHi * 1000 : rawHi;
    if (loMhz > hiMhz) {
      return null;
    }
    return { loMhz, hiMhz, isRange: true };
  }

  const singleMatch = SINGLE_FREQ_RE.exec(trimmed);
  if (singleMatch) {
    const rawVal = parseNumericValue(singleMatch[1]);
    const unit = singleMatch[2]?.toLowerCase();
    if (!Number.isFinite(rawVal)) {
      return null;
    }
    const mhz = unit === 'ghz' ? rawVal * 1000 : rawVal;
    return { loMhz: mhz, hiMhz: mhz, isRange: false };
  }

  return null;
}

export function classifyFrequencyRangeToBandCode(raw: string): BandCode | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const directMatch = DIRECT_BAND_CODE_RE.exec(trimmed);
  if (directMatch) {
    return directMatch[1].toUpperCase() as BandCode;
  }

  const span = parseFrequencySpanMhz(trimmed);
  if (!span) {
    return null;
  }

  const { loMhz, hiMhz, isRange } = span;

  // 26 GHz mmWave: MINETUR GHz-as-MHz bug (24..29.5) or true MHz (24000..29500)
  if ((loMhz >= 24 && hiMhz <= 29.5) || (loMhz >= 24000 && hiMhz <= 29500)) {
    return 'N258';
  }

  // 3500 MHz C-band (3300..3900 MHz)
  if (loMhz >= 3300 && hiMhz <= 3900) {
    return 'N78';
  }

  // 2600 MHz family (2490..2700 MHz): upper 2680..2690 block B7+, TDD B38 within [2570, 2620], else FDD B7
  if (loMhz >= 2490 && hiMhz <= 2700) {
    if (
      isRange &&
      loMhz >= 2679.5 &&
      loMhz <= 2680.5 &&
      hiMhz >= 2689.5 &&
      hiMhz <= 2690.5
    ) {
      return 'B7+';
    }
    if (
      (isRange && loMhz >= 2570 && hiMhz <= 2620) ||
      (!isRange && loMhz > 2570 && hiMhz < 2620 && loMhz !== 2600)
    ) {
      return 'B38';
    }
    return 'B7';
  }

  // 2100 MHz (1920..2170 MHz + nominal 2100 MHz)
  if (loMhz >= 1900 && hiMhz <= 2170) {
    return 'B1';
  }

  // 1800 MHz (1710..1880 MHz)
  if (loMhz >= 1710 && hiMhz <= 1880) {
    return 'B3';
  }

  // 900 MHz (880..960 MHz)
  if (loMhz >= 880 && hiMhz <= 960) {
    return 'G9';
  }

  // 800 MHz (791..862 MHz)
  if (loMhz >= 791 && hiMhz <= 862) {
    return 'B20';
  }

  // 700 MHz (703..788 MHz + nominal 700 MHz; 30 MHz 758..788 MHz block -> N28+)
  if (loMhz >= 698 && hiMhz <= 788.5) {
    if (
      isRange &&
      loMhz >= 757.5 &&
      loMhz <= 758.5 &&
      hiMhz >= 787.5 &&
      hiMhz <= 788.5
    ) {
      return 'N28+';
    }
    return 'N28';
  }

  return null;
}

function getBandTokenSortWeightMhz(
  token: string,
  unknownFallback: number,
): number {
  if (Object.hasOwn(BAND_CODE_SORT_MHZ, token)) {
    return BAND_CODE_SORT_MHZ[token as BandCode];
  }
  const classified = classifyFrequencyRangeToBandCode(token);
  if (classified) {
    return BAND_CODE_SORT_MHZ[classified];
  }
  const span = parseFrequencySpanMhz(token.trim());
  if (span) {
    return (span.loMhz + span.hiMhz) / 2;
  }
  return unknownFallback;
}

function compareBandTokensDescending(a: string, b: string): number {
  const weightA = getBandTokenSortWeightMhz(a, Number.NEGATIVE_INFINITY);
  const weightB = getBandTokenSortWeightMhz(b, Number.NEGATIVE_INFINITY);
  if (weightA !== weightB) {
    return weightB - weightA;
  }
  return a.localeCompare(b);
}

export function compareBandCodesAscending(a: string, b: string): number {
  const weightA = getBandTokenSortWeightMhz(a, Number.POSITIVE_INFINITY);
  const weightB = getBandTokenSortWeightMhz(b, Number.POSITIVE_INFINITY);
  if (weightA !== weightB) {
    return weightA - weightB;
  }
  return a.localeCompare(b);
}

function isAntennaBandSourceObject(
  value: AntennaBandSource | readonly string[] | undefined | null,
): value is AntennaBandSource {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidOperatorKey(value: string): value is OperatorKey {
  return (
    value === 'movistar' ||
    value === 'vodafone' ||
    value === 'orange' ||
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
  if (typeof band !== 'string') {
    return '';
  }
  const trimmed = band.trim();
  if (!trimmed) {
    return '';
  }
  const code = classifyFrequencyRangeToBandCode(trimmed);
  if (code) {
    return code;
  }
  if (TRAILING_MHZ_RE.test(trimmed)) {
    return trimmed.replace(TRAILING_MHZ_RE, '').trim();
  }
  return trimmed;
}

export function extractAntennaBandCodes(
  antenna: AntennaBandSource | undefined | null,
): string[];
export function extractAntennaBandCodes(
  bandas: readonly string[] | undefined | null,
  frecuencias?: readonly string[] | undefined | null,
  concesiones?: readonly Partial<ConcesionBanda>[] | undefined | null,
): string[];
export function extractAntennaBandCodes(
  bandasOrAntenna: AntennaBandSource | readonly string[] | undefined | null,
  frecuenciasArg?: readonly string[] | undefined | null,
  concesionesArg?: readonly Partial<ConcesionBanda>[] | undefined | null,
): string[] {
  let bandas: readonly string[] | undefined | null;
  let frecuencias: readonly string[] | undefined | null;
  let concesiones: readonly Partial<ConcesionBanda>[] | undefined | null;

  if (isAntennaBandSourceObject(bandasOrAntenna)) {
    bandas = bandasOrAntenna.bandas;
    frecuencias = bandasOrAntenna.frecuencias;
    concesiones = bandasOrAntenna.concesiones;
  } else {
    bandas = bandasOrAntenna;
    frecuencias = frecuenciasArg;
    concesiones = concesionesArg;
  }

  const tokens = new Set<string>();
  let resolved2600FromFreqs = false;
  let resolved700FromFreqs = false;
  let hasN28PlusFromFreqs = false;
  let hasExplicitLiteralN28InBandas = false;

  if (frecuencias) {
    for (let i = 0; i < frecuencias.length; i++) {
      const rawFreq = frecuencias[i];
      if (typeof rawFreq !== 'string') continue;
      const code = classifyFrequencyRangeToBandCode(rawFreq);
      if (code) {
        tokens.add(code);
        if (code === 'B7' || code === 'B7+' || code === 'B38') {
          resolved2600FromFreqs = true;
        } else if (code === 'N28' || code === 'N28+') {
          resolved700FromFreqs = true;
          if (code === 'N28+') {
            hasN28PlusFromFreqs = true;
          }
        }
      }
    }
  }

  if (concesiones) {
    for (let i = 0; i < concesiones.length; i++) {
      const rawFreq = concesiones[i]?.freq;
      if (typeof rawFreq !== 'string') continue;
      const code = classifyFrequencyRangeToBandCode(rawFreq);
      if (code) {
        tokens.add(code);
        if (code === 'B7' || code === 'B7+' || code === 'B38') {
          resolved2600FromFreqs = true;
        } else if (code === 'N28' || code === 'N28+') {
          resolved700FromFreqs = true;
          if (code === 'N28+') {
            hasN28PlusFromFreqs = true;
          }
        }
      }
    }
  }

  if (bandas) {
    for (let i = 0; i < bandas.length; i++) {
      const rawBand = bandas[i];
      if (typeof rawBand !== 'string') continue;
      const trimmed = rawBand.trim();
      if (!trimmed) continue;

      if (resolved2600FromFreqs && GENERIC_2600_BUCKET_RE.test(trimmed)) {
        continue;
      }
      if (resolved700FromFreqs && GENERIC_700_BUCKET_RE.test(trimmed)) {
        continue;
      }

      if (LITERAL_N28_RE.test(trimmed)) {
        hasExplicitLiteralN28InBandas = true;
      }

      const token = formatCompactBandToken(trimmed);
      if (token) {
        tokens.add(token);
        if (token === 'N28+' && !LITERAL_N28_PLUS_RE.test(trimmed)) {
          hasN28PlusFromFreqs = true;
        }
      }
    }
  }

  if (hasN28PlusFromFreqs && !hasExplicitLiteralN28InBandas) {
    tokens.delete('N28');
  }

  if (tokens.size === 0) {
    return [];
  }

  return Array.from(tokens).sort(compareBandTokensDescending);
}

export function formatAntennaBandsCompact(
  bandas: readonly string[] | undefined | null,
  frecuencias?: readonly string[] | undefined | null,
  concesiones?: readonly Partial<ConcesionBanda>[] | undefined | null,
): string {
  const codes = extractAntennaBandCodes(bandas, frecuencias, concesiones);
  return codes.join(' ');
}

export function buildSiteBandCardRows(
  site: Pick<MapSiteEntry, 'members'>,
): BandCardRow[] {
  const rows: BandCardRow[] = [];
  const members = site.members;
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const text = formatAntennaBandsCompact(
      member.bandas,
      member.frecuencias,
      member.concesiones,
    );
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

interface MeasuredBandCardRow {
  row: BandCardRow;
  tokens: string[];
  tokenWidths: number[];
  rowTotalWidth: number;
}

function measureTokenWidth(
  ctx: CanvasRenderingContext2D | null,
  token: string,
): number {
  const measured = ctx ? (ctx.measureText(token)?.width ?? 0) : 0;
  return Number.isFinite(measured) && measured > 0
    ? Math.ceil(measured)
    : Math.ceil(token.length * FALLBACK_CHAR_WIDTH);
}

function drawSeparatorDot(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  ctx.beginPath();
  if (typeof ctx.arc === 'function') {
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  } else {
    ctx.moveTo(cx + radius, cy);
    ctx.quadraticCurveTo(cx + radius, cy + radius, cx, cy + radius);
    ctx.quadraticCurveTo(cx - radius, cy + radius, cx - radius, cy);
    ctx.quadraticCurveTo(cx - radius, cy - radius, cx, cy - radius);
    ctx.quadraticCurveTo(cx + radius, cy - radius, cx + radius, cy);
  }
  ctx.closePath();
  ctx.fillStyle = BAND_SEPARATOR_DOT_COLOR;
  ctx.fill();
}

export function renderBandCardSprite(rows: readonly BandCardRow[]): ImageData {
  const canvas =
    typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas ? canvas.getContext('2d') : null;

  if (ctx) {
    ctx.font = BAND_CARD_FONT;
  }

  const measuredRows: MeasuredBandCardRow[] = [];
  let maxTextWidth = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tokens = row.text.trim().split(/\s+/).filter(Boolean);
    const tokenWidths: number[] = [];
    let tokensWidthSum = 0;
    for (let t = 0; t < tokens.length; t++) {
      const w = measureTokenWidth(ctx, tokens[t]);
      tokenWidths.push(w);
      tokensWidthSum += w;
    }
    const rowTotalWidth =
      tokensWidthSum + Math.max(0, tokens.length - 1) * BAND_SEPARATOR_GAP_PX;
    const roundedRowWidth = Math.ceil(rowTotalWidth);
    if (roundedRowWidth > maxTextWidth) {
      maxTextWidth = roundedRowWidth;
    }
    measuredRows.push({
      row,
      tokens,
      tokenWidths,
      rowTotalWidth,
    });
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
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const centerX = boxX + boxW / 2;
  for (let i = 0; i < measuredRows.length; i++) {
    const { row, tokens, tokenWidths, rowTotalWidth } = measuredRows[i];
    let cursorX = centerX - rowTotalWidth / 2;
    const rowY = boxY + PAD_Y + i * LINE_HEIGHT + LINE_HEIGHT / 2;

    for (let t = 0; t < tokens.length; t++) {
      ctx.fillStyle = row.color;
      ctx.fillText(tokens[t], cursorX, rowY);
      cursorX += tokenWidths[t];

      if (t < tokens.length - 1) {
        const dotX = cursorX + BAND_SEPARATOR_GAP_PX / 2;
        drawSeparatorDot(ctx, dotX, rowY, BAND_SEPARATOR_DOT_RADIUS);
        cursorX += BAND_SEPARATOR_GAP_PX;
      }
    }
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
