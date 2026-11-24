import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_META, type AntennaRecord } from '../types/antena';
import {
  ALL_BAND_CODES_ASC,
  BAND_CARD_KEY_PREFIX,
  BAND_CARD_OPERATOR_ORDER,
  BAND_CARD_PIXEL_RATIO,
  BAND_N78_PLUS_BG_COLOR,
  BAND_SEPARATOR_DOT_COLOR,
  BAND_SEPARATOR_DOT_RADIUS,
  BAND_SEPARATOR_GAP_PX,
  buildSiteBandCardKey,
  buildSiteBandCardRows,
  classifyFrequencyRangeToBandCode,
  clearBandCardSpriteCache,
  compareBandCodesAscending,
  extractAntennaBandCodes,
  formatAntennaBandsCompact,
  formatCompactBandToken,
  getOrCreateBandCardSprite,
  parseSiteBandCardKey,
  renderBandCardSprite,
  type BandCardRow,
} from './bandCard';
import { groupColocatedAntennasForMap } from './geo';

interface FillCapture {
  fillStyle: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

interface StrokeCapture {
  strokeStyle: string;
  lineWidth: number;
  shadowBlur: number;
}

interface FillTextCapture {
  text: string;
  x: number;
  y: number;
  fillStyle: string;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  shadowBlur: number;
}

interface ArcCapture {
  x: number;
  y: number;
  radius: number;
  startAngle: number;
  endAngle: number;
}

function createMockCanvasEnvironment(options?: {
  measureWidthPerChar?: number;
  nullContext?: boolean;
  withoutArc?: boolean;
}) {
  const measureWidthPerChar = options?.measureWidthPerChar ?? 11.5;
  const fills: FillCapture[] = [];
  const strokes: StrokeCapture[] = [];
  const fillTexts: FillTextCapture[] = [];
  const arcs: ArcCapture[] = [];
  const pathOps: string[] = [];
  const drawOrder: Array<
    | {
        kind: 'fill';
        fillStyle: string;
        shadowBlur: number;
        bounds: { minX: number; maxX: number; minY: number; maxY: number } | null;
      }
    | {
        kind: 'fillText';
        text: string;
        x: number;
        y: number;
        fillStyle: string;
      }
  > = [];

  let currentPathPoints: Array<[number, number]> = [];
  const recordPoint = (x?: number, y?: number) => {
    if (typeof x === 'number' && typeof y === 'number') {
      currentPathPoints.push([x, y]);
    }
  };
  const computeCurrentBounds = () => {
    if (currentPathPoints.length === 0) {
      return null;
    }
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < currentPathPoints.length; i++) {
      const [px, py] = currentPathPoints[i];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    return { minX, maxX, minY, maxY };
  };

  let canvasWidth = 0;
  let canvasHeight = 0;

  type CtxState = {
    font: string;
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    shadowColor: string;
    shadowBlur: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
    textAlign: CanvasTextAlign;
    textBaseline: CanvasTextBaseline;
  };

  const defaultState = (): CtxState => ({
    font: '10px sans-serif',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    textAlign: 'start',
    textBaseline: 'alphabetic',
  });

  let state: CtxState = defaultState();
  const stack: CtxState[] = [];

  const mockCtx: Record<string, unknown> = {
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value: string) {
      state.fillStyle = value;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(value: string) {
      state.strokeStyle = value;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(value: number) {
      state.lineWidth = value;
    },
    get shadowColor() {
      return state.shadowColor;
    },
    set shadowColor(value: string) {
      state.shadowColor = value;
    },
    get shadowBlur() {
      return state.shadowBlur;
    },
    set shadowBlur(value: number) {
      state.shadowBlur = value;
    },
    get shadowOffsetX() {
      return state.shadowOffsetX;
    },
    set shadowOffsetX(value: number) {
      state.shadowOffsetX = value;
    },
    get shadowOffsetY() {
      return state.shadowOffsetY;
    },
    set shadowOffsetY(value: number) {
      state.shadowOffsetY = value;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(value: CanvasTextAlign) {
      state.textAlign = value;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(value: CanvasTextBaseline) {
      state.textBaseline = value;
    },
    save: vi.fn(() => {
      stack.push({ ...state });
    }),
    restore: vi.fn(() => {
      const prev = stack.pop();
      if (prev) {
        state = prev;
      }
    }),
    beginPath: vi.fn(() => {
      currentPathPoints = [];
      pathOps.push('beginPath');
    }),
    moveTo: vi.fn((x?: number, y?: number) => {
      recordPoint(x, y);
      pathOps.push('moveTo');
    }),
    lineTo: vi.fn((x?: number, y?: number) => {
      recordPoint(x, y);
      pathOps.push('lineTo');
    }),
    quadraticCurveTo: vi.fn(
      (cpx?: number, cpy?: number, x?: number, y?: number) => {
        recordPoint(cpx, cpy);
        recordPoint(x, y);
        pathOps.push('quadraticCurveTo');
      },
    ),
    arcTo: vi.fn(() => {
      pathOps.push('arcTo');
    }),
    closePath: vi.fn(() => {
      pathOps.push('closePath');
    }),
    fill: vi.fn(() => {
      fills.push({
        fillStyle: state.fillStyle,
        shadowColor: state.shadowColor,
        shadowBlur: state.shadowBlur,
        shadowOffsetX: state.shadowOffsetX,
        shadowOffsetY: state.shadowOffsetY,
      });
      drawOrder.push({
        kind: 'fill',
        fillStyle: state.fillStyle,
        shadowBlur: state.shadowBlur,
        bounds: computeCurrentBounds(),
      });
    }),
    stroke: vi.fn(() => {
      strokes.push({
        strokeStyle: state.strokeStyle,
        lineWidth: state.lineWidth,
        shadowBlur: state.shadowBlur,
      });
    }),
    measureText: vi.fn((text: string) => ({
      width: text.length * measureWidthPerChar,
    })),
    fillText: vi.fn((text: string, x: number, y: number) => {
      fillTexts.push({
        text,
        x,
        y,
        fillStyle: state.fillStyle,
        font: state.font,
        textAlign: state.textAlign,
        textBaseline: state.textBaseline,
        shadowBlur: state.shadowBlur,
      });
      drawOrder.push({
        kind: 'fillText',
        text,
        x,
        y,
        fillStyle: state.fillStyle,
      });
    }),
    getImageData: vi.fn((_sx: number, _sy: number, sw: number, sh: number) => ({
      width: sw,
      height: sh,
      data: new Uint8ClampedArray(sw * sh * 4),
    })),
  };

  if (!options?.withoutArc) {
    mockCtx.arc = vi.fn(
      (
        x: number,
        y: number,
        radius: number,
        startAngle: number,
        endAngle: number,
      ) => {
        pathOps.push('arc');
        arcs.push({ x, y, radius, startAngle, endAngle });
      },
    );
  }

  const createElement = vi.fn((tagName: string) => {
    if (tagName !== 'canvas') {
      throw new Error(`Unexpected tag: ${tagName}`);
    }
    return {
      get width() {
        return canvasWidth;
      },
      set width(value: number) {
        canvasWidth = value;
        // Real HTMLCanvasElement resets 2D context state whenever width/height changes
        state = defaultState();
      },
      get height() {
        return canvasHeight;
      },
      set height(value: number) {
        canvasHeight = value;
        state = defaultState();
      },
      getContext: vi.fn(() =>
        options?.nullContext
          ? null
          : (mockCtx as unknown as CanvasRenderingContext2D),
      ),
    };
  });

  vi.stubGlobal('document', { createElement });

  return {
    createElement,
    mockCtx,
    fills,
    strokes,
    fillTexts,
    arcs,
    pathOps,
    drawOrder,
    getCanvasSize: () => ({ width: canvasWidth, height: canvasHeight }),
  };
}

function makeAntenna(
  partial: Partial<AntennaRecord> & Pick<AntennaRecord, 'id' | 'gid' | 'op'>,
): AntennaRecord {
  return {
    opRaw: partial.op.toUpperCase(),
    lat: 40.4168,
    lon: -3.7038,
    dir: 'Calle Mayor, 1',
    mun: 'Madrid',
    prov: 'Madrid',
    ...partial,
  };
}

afterEach(() => {
  clearBandCardSpriteCache();
  vi.unstubAllGlobals();
});

describe('classifyFrequencyRangeToBandCode & formatCompactBandToken', () => {
  it('maps every standard RF band label and frequency range to its canonical band code', () => {
    // N28 (700 MHz / 703..788 MHz sub-blocks) & N28+ (full 30 MHz 758..788 MHz block)
    expect(classifyFrequencyRangeToBandCode('700 MHz')).toBe('N28');
    expect(classifyFrequencyRangeToBandCode('703.00 - 733.00')).toBe('N28');
    expect(classifyFrequencyRangeToBandCode('758.00 - 768.00')).toBe('N28');
    expect(classifyFrequencyRangeToBandCode('768.00 - 778.00')).toBe('N28');
    expect(classifyFrequencyRangeToBandCode('778.00 - 788.00')).toBe('N28');
    expect(classifyFrequencyRangeToBandCode('758.00 - 788.00')).toBe('N28+');
    expect(classifyFrequencyRangeToBandCode('758.00 -788.00')).toBe('N28+');
    expect(classifyFrequencyRangeToBandCode('758-788')).toBe('N28+');
    expect(classifyFrequencyRangeToBandCode('758 - 788 MHz')).toBe('N28+');
    expect(formatCompactBandToken('700 MHz')).toBe('N28');
    expect(formatCompactBandToken('758.00 -788.00')).toBe('N28+');

    // B20 (800 MHz / 791..862 MHz)
    expect(classifyFrequencyRangeToBandCode('800 MHz')).toBe('B20');
    expect(classifyFrequencyRangeToBandCode('791.00 - 801.00')).toBe('B20');
    expect(classifyFrequencyRangeToBandCode('832.00 - 862.00')).toBe('B20');
    expect(formatCompactBandToken('800 MHz')).toBe('B20');

    // G9 (900 MHz / 880..960 MHz)
    expect(classifyFrequencyRangeToBandCode('900 MHz')).toBe('G9');
    expect(classifyFrequencyRangeToBandCode('880.00 - 915.00')).toBe('G9');
    expect(classifyFrequencyRangeToBandCode('935.00 - 950.00')).toBe('G9');
    expect(formatCompactBandToken('900 MHz')).toBe('G9');

    // B3 (1800 MHz / 1710..1880 MHz)
    expect(classifyFrequencyRangeToBandCode('1800 MHz')).toBe('B3');
    expect(classifyFrequencyRangeToBandCode('1710.00 - 1785.00')).toBe('B3');
    expect(classifyFrequencyRangeToBandCode('1805.00 - 1825.00')).toBe('B3');
    expect(formatCompactBandToken('1800 mhz')).toBe('B3');

    // B1 (2100 MHz / 1920..2170 MHz)
    expect(classifyFrequencyRangeToBandCode('2100 MHz')).toBe('B1');
    expect(classifyFrequencyRangeToBandCode('1920.00 - 1980.00')).toBe('B1');
    expect(classifyFrequencyRangeToBandCode('2110.00 - 2130.00')).toBe('B1');
    expect(formatCompactBandToken('  2100 MHz  ')).toBe('B1');

    // B7 (2600 MHz FDD) & B7+ (2680.00 - 2690.00 upper 10 MHz block)
    expect(classifyFrequencyRangeToBandCode('2600 MHz')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2620.00 - 2640.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2660.00 - 2680.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2500.00 - 2570.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2680.00 - 2690.00')).toBe('B7+');
    expect(classifyFrequencyRangeToBandCode('2680-2690')).toBe('B7+');
    expect(classifyFrequencyRangeToBandCode('2680 - 2690 MHz')).toBe('B7+');
    expect(formatCompactBandToken('2600 MHz')).toBe('B7');
    expect(formatCompactBandToken('2680.00 - 2690.00')).toBe('B7+');

    // N78 (3500 MHz / 3300..3900 MHz)
    expect(classifyFrequencyRangeToBandCode('3500 MHz')).toBe('N78');
    expect(classifyFrequencyRangeToBandCode('3460.00 - 3600.00')).toBe('N78');
    expect(classifyFrequencyRangeToBandCode('3710.00 - 3800.00')).toBe('N78');
    expect(formatCompactBandToken('3500MHz')).toBe('N78');

    // N258 (26 GHz / 27 GHz / MINETUR 26 MHz & 27 MHz bug / 25.70-27.10)
    expect(classifyFrequencyRangeToBandCode('26 MHz')).toBe('N258');
    expect(classifyFrequencyRangeToBandCode('27 MHz')).toBe('N258');
    expect(classifyFrequencyRangeToBandCode('26 GHz')).toBe('N258');
    expect(classifyFrequencyRangeToBandCode('27 GHz')).toBe('N258');
    expect(classifyFrequencyRangeToBandCode('25.70 - 26.70')).toBe('N258');
    expect(classifyFrequencyRangeToBandCode('26.70 - 27.10')).toBe('N258');
    expect(classifyFrequencyRangeToBandCode('24250.00 - 27500.00')).toBe(
      'N258',
    );
    expect(formatCompactBandToken('26 MHz')).toBe('N258');
    expect(formatCompactBandToken('27 MHz')).toBe('N258');
    expect(formatCompactBandToken('26 GHz')).toBe('N258');
  });

  it('enforces exact boundaries for TDD B38 ([2570, 2620] MHz), upper FDD B7+ (2680..2690 MHz), and standard FDD B7', () => {
    // Inside [2570, 2620] inclusive -> B38
    expect(classifyFrequencyRangeToBandCode('2570.00 - 2620.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2575.00 - 2585.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2575.00 - 2595.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2595.00 - 2605.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2605.00 - 2615.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2595 MHz')).toBe('B38');

    // Dedicated upper 10 MHz DL block 2680.00 - 2690.00 -> B7+
    expect(classifyFrequencyRangeToBandCode('2680.00 - 2690.00')).toBe('B7+');

    // Touching 2620 or 2570 or wider 2600 FDD blocks -> B7
    expect(classifyFrequencyRangeToBandCode('2620.00 - 2640.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2640.00 - 2660.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2660.00 - 2680.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2660.00 - 2690.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2550.00 - 2570.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2500.00 - 2570.00')).toBe('B7');

    // Reversed / malformed range rejected
    expect(classifyFrequencyRangeToBandCode('2620.00 - 2570.00')).toBeNull();
  });

  it('normalizes already-formatted band codes case-insensitively and handles unknown/empty strings', () => {
    expect(formatCompactBandToken('n258')).toBe('N258');
    expect(formatCompactBandToken('n78')).toBe('N78');
    expect(formatCompactBandToken('b7+')).toBe('B7+');
    expect(formatCompactBandToken('b7')).toBe('B7');
    expect(formatCompactBandToken('b38')).toBe('B38');
    expect(formatCompactBandToken('b1')).toBe('B1');
    expect(formatCompactBandToken('b3')).toBe('B3');
    expect(formatCompactBandToken('g9')).toBe('G9');
    expect(formatCompactBandToken('b20')).toBe('B20');
    expect(formatCompactBandToken('n28+')).toBe('N28+');
    expect(formatCompactBandToken('n28')).toBe('N28');

    // Unknown future frequency keeps compact MHz-stripped token
    expect(classifyFrequencyRangeToBandCode('1500 MHz')).toBeNull();
    expect(formatCompactBandToken('1500 MHz')).toBe('1500');

    expect(classifyFrequencyRangeToBandCode('')).toBeNull();
    expect(classifyFrequencyRangeToBandCode('   ')).toBeNull();
    expect(formatCompactBandToken('')).toBe('');
    expect(formatCompactBandToken('   ')).toBe('');
  });
});

describe('extractAntennaBandCodes, formatAntennaBandsCompact & compareBandCodesAscending', () => {
  it('sorts all 11 canonical band codes strictly descending and ascending', () => {
    expect(
      formatAntennaBandsCompact(
        [
          'N28',
          '800 MHz',
          '900 MHz',
          '1800 MHz',
          '2100 MHz',
          '2600 MHz',
          '3500 MHz',
          '26 MHz',
        ],
        [
          '758.00 - 788.00',
          '2575.00 - 2595.00',
          '2660.00 - 2680.00',
          '2680.00 - 2690.00',
        ],
      ),
    ).toBe('N258 N78 B7+ B7 B38 B1 B3 G9 B20 N28+ N28');

    expect(ALL_BAND_CODES_ASC).toEqual([
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
    ]);

    const shuffled = [
      'N78',
      'OTRA',
      'B7+',
      'N28+',
      'B3',
      'N258',
      'N28',
      '1500',
      'B38',
      'G9',
      'B7',
      'ALFA',
      'B20',
      'B1',
    ];
    expect([...shuffled].sort(compareBandCodesAscending)).toEqual([
      'N28',
      'N28+',
      'B20',
      'G9',
      '1500',
      'B3',
      'B1',
      'B38',
      'B7',
      'B7+',
      'N78',
      'N258',
      'ALFA',
      'OTRA',
    ]);
  });

  it('matches real-world Spanish stations (standard 7-band FDD, Vodafone #57833 Getafe, Movistar #3300033 Oviedo)', () => {
    // Standard 7-band FDD station
    expect(
      formatAntennaBandsCompact([
        '700 MHz',
        '800 MHz',
        '900 MHz',
        '1800 MHz',
        '2100 MHz',
        '2600 MHz',
        '3500 MHz',
      ]),
    ).toBe('N78 B7 B1 B3 G9 B20 N28');

    // Vodafone #57833 in Getafe (B7 + B38 + N78 + sub-2.1GHz)
    const vodafoneGetafe = makeAntenna({
      id: 'VOD-57833',
      gid: '57833',
      op: 'vodafone',
      bandas: [
        '700 MHz',
        '800 MHz',
        '900 MHz',
        '1800 MHz',
        '2100 MHz',
        '2600 MHz',
        '3500 MHz',
      ],
      frecuencias: [
        '758.00 - 768.00',
        '791.00 - 801.00',
        '935.00 - 950.00',
        '1805.00 - 1825.00',
        '2110.00 - 2130.00',
        '2575.00 - 2595.00',
        '2660.00 - 2680.00',
        '3710.00 - 3800.00',
      ],
    });
    expect(extractAntennaBandCodes(vodafoneGetafe)).toEqual([
      'N78',
      'B7',
      'B38',
      'B1',
      'B3',
      'G9',
      'B20',
      'N28',
    ]);
    expect(
      formatAntennaBandsCompact(
        vodafoneGetafe.bandas,
        vodafoneGetafe.frecuencias,
      ),
    ).toBe('N78 B7 B38 B1 B3 G9 B20 N28');

    // Movistar #3300033 in Oviedo (N258 + N78 + B7 + sub-2.1GHz)
    expect(
      formatAntennaBandsCompact(
        [
          '26 MHz',
          '700 MHz',
          '800 MHz',
          '900 MHz',
          '1800 MHz',
          '2100 MHz',
          '2600 MHz',
          '3500 MHz',
        ],
        [
          '25.70 - 26.70',
          '768.00 - 778.00',
          '801.00 - 811.00',
          '925.00 - 935.00',
          '1825.00 - 1845.00',
          '2130.00 - 2150.00',
          '2620.00 - 2640.00',
          '3460.00 - 3600.00',
        ],
      ),
    ).toBe('N258 N78 B7 B1 B3 G9 B20 N28');
  });

  it('separates B7+-only, B38-only, B7-only, dual B7+ & B7, dual B7+B38, and synthetic 2600 MHz fallback stations accurately', () => {
    // B7+-only station via frecuencias -> ONLY B7+ (must NOT add false B7 from generic "2600 MHz")
    expect(
      extractAntennaBandCodes({
        bandas: ['2600 MHz'],
        frecuencias: ['2680.00 - 2690.00'],
      }),
    ).toEqual(['B7+']);

    // B7+-only station via concesiones -> ONLY B7+
    expect(
      extractAntennaBandCodes(['2600 MHz'], undefined, [
        { ref: 'M M -2680', freq: '2680.00 - 2690.00' },
      ]),
    ).toEqual(['B7+']);

    // Dual B7 + B7+ station -> ['B7+', 'B7']
    expect(
      extractAntennaBandCodes({
        bandas: ['2600 MHz'],
        frecuencias: ['2640.00 - 2660.00', '2680.00 - 2690.00'],
      }),
    ).toEqual(['B7+', 'B7']);

    // B38-only station via frecuencias -> ONLY B38 (must NOT add false B7 from "2600 MHz")
    expect(
      formatAntennaBandsCompact(['2600 MHz'], ['2595.00 - 2605.00']),
    ).toBe('B38');

    // B38-only station via concesiones -> ONLY B38
    expect(
      formatAntennaBandsCompact(['2600 MHz'], undefined, [
        { ref: 'M M -2605', freq: '2605.00 - 2615.00' },
      ]),
    ).toBe('B38');

    // B7-only station -> ONLY B7
    expect(
      formatAntennaBandsCompact(['2600 MHz'], ['2620.00 - 2640.00']),
    ).toBe('B7');

    // Dual B7 + B38 + N78 station -> N78 B7 B38
    expect(
      formatAntennaBandsCompact(
        ['2600 MHz', '3500 MHz'],
        ['2575.00 - 2595.00', '2660.00 - 2680.00', '3710.00 - 3800.00'],
      ),
    ).toBe('N78 B7 B38');

    // Synthetic record with only bandas: ['2600 MHz'] -> falls back cleanly to B7
    expect(formatAntennaBandsCompact(['2600 MHz'])).toBe('B7');
  });

  it('separates 30 MHz N28+ stations from standard N28 and suppresses redundant 700 MHz buckets/sub-slices', () => {
    // N28+ station with generic "700 MHz" in bandas -> ONLY ['N28+']
    expect(
      extractAntennaBandCodes({
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 788.00'],
      }),
    ).toEqual(['N28+']);
    expect(
      extractAntennaBandCodes({
        bandas: ['700 MHz'],
        concesiones: [{ ref: 'M M -758', freq: '758.00 -788.00' }],
      }),
    ).toEqual(['N28+']);

    // Merged sub-slice + full 30 MHz block -> ONLY ['N28+']
    expect(
      extractAntennaBandCodes({
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00', '758.00 - 788.00'],
      }),
    ).toEqual(['N28+']);
    expect(
      extractAntennaBandCodes(['758.00 - 768.00', '758.00 - 788.00']),
    ).toEqual(['N28+']);

    // Standard 10 MHz N28 slices without full 30 MHz block -> ONLY ['N28']
    expect(
      extractAntennaBandCodes({
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00', '768.00 - 778.00'],
      }),
    ).toEqual(['N28']);

    // Explicit literal 'N28' in bandas alongside N28+ is preserved
    expect(extractAntennaBandCodes(['N28', 'N28+'])).toEqual(['N28+', 'N28']);
  });

  it('deduplicates 26 MHz + 27 MHz (25.70 - 26.70 + 26.70 - 27.10) into a single leading N258', () => {
    expect(
      formatAntennaBandsCompact(
        ['26 MHz', '3500 MHz', '1800 mhz', '27 MHz', '700 MHz', '1800 MHz'],
        ['25.70 - 26.70', '26.70 - 27.10', '3460.00 - 3600.00'],
      ),
    ).toBe('N258 N78 B3 N28');
  });

  it('slots unknown future frequencies by descending MHz value (e.g. 1500 MHz between B3 and G9)', () => {
    expect(
      formatAntennaBandsCompact(['900 MHz', '1500 MHz', '1800 MHz', '700 MHz']),
    ).toBe('B3 1500 G9 N28');
  });

  it('returns empty array / empty string for null, undefined, or empty inputs', () => {
    expect(extractAntennaBandCodes(undefined)).toEqual([]);
    expect(extractAntennaBandCodes(null)).toEqual([]);
    expect(formatAntennaBandsCompact(undefined)).toBe('');
    expect(formatAntennaBandsCompact(null)).toBe('');
    expect(formatAntennaBandsCompact([])).toBe('');
    expect(formatAntennaBandsCompact(['', '   '])).toBe('');
  });
});

describe('buildSiteBandCardRows, buildSiteBandCardKey & parseSiteBandCardKey', () => {
  it('builds single-operator rows and keys with exact OPERATOR_META colors and descending band codes', () => {
    const movistarSite = {
      members: [
        makeAntenna({
          id: 'MOV-1',
          gid: '2800001',
          op: 'movistar',
          bandas: ['3500 MHz', '700 MHz', '1800 MHz', '800 MHz'],
        }),
      ],
    };
    expect(buildSiteBandCardRows(movistarSite)).toEqual([
      {
        op: 'movistar',
        color: '#0066CC',
        text: 'N78 B3 B20 N28',
      },
    ]);
    const movKey = buildSiteBandCardKey(movistarSite);
    expect(movKey).toBe('bandcard:movistar:N78 B3 B20 N28');
    expect(parseSiteBandCardKey(movKey)).toEqual(
      buildSiteBandCardRows(movistarSite),
    );

    const orangeB38Site = {
      members: [
        makeAntenna({
          id: 'ORA-1',
          gid: '2800002',
          op: 'orange',
          bandas: ['2100 MHz', '900 MHz', '2600 MHz'],
          frecuencias: ['2595.00 - 2605.00'],
        }),
      ],
    };
    expect(buildSiteBandCardRows(orangeB38Site)).toEqual([
      {
        op: 'orange',
        color: '#EA580C',
        text: 'B38 B1 G9',
      },
    ]);

    const digiSite = {
      members: [
        makeAntenna({
          id: 'DIG-1',
          gid: '2800003',
          op: 'digi',
          bandas: ['2600 MHz', '1800 MHz', '3500 MHz'],
          concesiones: [
            { ref: 'M M -2575', freq: '2575.00 - 2595.00' },
            { ref: 'M M -2660', freq: '2660.00 - 2680.00' },
          ],
        }),
      ],
    };
    const digiRows = buildSiteBandCardRows(digiSite);
    expect(digiRows).toEqual([
      {
        op: 'digi',
        color: '#7C3AED',
        text: 'N78 B7 B38 B3',
      },
    ]);
    const digiKey = buildSiteBandCardKey(digiSite);
    expect(digiKey).toBe(`${BAND_CARD_KEY_PREFIX}digi:N78 B7 B38 B3`);
    expect(parseSiteBandCardKey(digiKey)).toEqual(digiRows);
  });

  it('orders multi-operator < 15 m shared sites with DIGI in 2nd row and upgrades Movistar N78 to N78+ when co-located with DIGI', () => {
    expect(BAND_CARD_OPERATOR_ORDER).toEqual([
      'movistar',
      'digi',
      'orange',
      'vodafone',
      'otros',
    ]);

    // Input intentionally unsorted: Vodafone + Movistar + DIGI + Orange within ~5 m (< 15 m)
    const rawAntennas: AntennaRecord[] = [
      makeAntenna({
        id: 'VOD-1',
        gid: '2800103',
        op: 'vodafone',
        lat: 40.4168,
        lon: -3.7038,
        bandas: ['900 MHz', '700 MHz', '2600 MHz', '3500 MHz'],
        frecuencias: ['2575.00 - 2595.00', '2660.00 - 2680.00'],
      }),
      makeAntenna({
        id: 'MOV-1',
        gid: '2800101',
        op: 'movistar',
        lat: 40.41684,
        lon: -3.70382,
        bandas: ['3500 MHz', '800 MHz', '1800 MHz', '700 MHz'],
      }),
      makeAntenna({
        id: 'DIG-1',
        gid: '2800104',
        op: 'digi',
        lat: 40.41682,
        lon: -3.70378,
        bandas: ['2100 MHz', '1800 MHz'],
      }),
      makeAntenna({
        id: 'ORA-1',
        gid: '2800102',
        op: 'orange',
        lat: 40.41681,
        lon: -3.70381,
        bandas: ['26 MHz', '27 MHz', '3500 MHz', '700 MHz'],
        frecuencias: ['25.70 - 26.70', '26.70 - 27.10'],
      }),
    ];

    const sites = groupColocatedAntennasForMap(rawAntennas);
    expect(sites).toHaveLength(1);
    expect(sites[0].isMultiOperator).toBe(true);

    const rows = buildSiteBandCardRows(sites[0]);
    expect(rows).toEqual([
      {
        op: 'movistar',
        color: OPERATOR_META.movistar.color,
        text: 'N78+ B3 B20 N28',
      },
      {
        op: 'digi',
        color: OPERATOR_META.digi.color,
        text: 'B1 B3',
      },
      {
        op: 'orange',
        color: OPERATOR_META.orange.color,
        text: 'N258 N78 N28',
      },
      {
        op: 'vodafone',
        color: OPERATOR_META.vodafone.color,
        text: 'N78 B7 B38 G9 N28',
      },
    ]);

    const key = buildSiteBandCardKey(sites[0]);
    expect(key).toBe(
      'bandcard:movistar:N78+ B3 B20 N28|digi:B1 B3|orange:N258 N78 N28|vodafone:N78 B7 B38 G9 N28',
    );
    expect(parseSiteBandCardKey(key)).toEqual(rows);
  });

  it('keeps Movistar N78 unchanged without DIGI, does not fabricate N78+ without 3500 MHz, and handles 5-operator & non-Movistar sites', () => {
    // 1. Movistar + Orange + Vodafone (NO DIGI): Movistar keeps plain N78, order stays movistar -> orange -> vodafone
    const noDigiSite = {
      members: [
        makeAntenna({
          id: 'MOV-NO-DIGI',
          gid: '2800401',
          op: 'movistar',
          bandas: ['3500 MHz', '1800 MHz'],
        }),
        makeAntenna({
          id: 'ORA-NO-DIGI',
          gid: '2800402',
          op: 'orange',
          bandas: ['3500 MHz', '700 MHz'],
        }),
        makeAntenna({
          id: 'VOD-NO-DIGI',
          gid: '2800403',
          op: 'vodafone',
          bandas: ['3500 MHz', '900 MHz'],
        }),
      ],
    };
    expect(buildSiteBandCardRows(noDigiSite)).toEqual([
      { op: 'movistar', color: OPERATOR_META.movistar.color, text: 'N78 B3' },
      { op: 'orange', color: OPERATOR_META.orange.color, text: 'N78 N28' },
      { op: 'vodafone', color: OPERATOR_META.vodafone.color, text: 'N78 G9' },
    ]);

    // 2. Movistar + DIGI + Orange + Vodafone + Otros (5 operators): DIGI is 2nd row, N258 stays ahead of N78+
    const fiveOpSite = {
      members: [
        makeAntenna({
          id: 'OTR-5',
          gid: '2800505',
          op: 'otros',
          bandas: ['900 MHz'],
        }),
        makeAntenna({
          id: 'VOD-5',
          gid: '2800504',
          op: 'vodafone',
          bandas: ['3500 MHz'],
        }),
        makeAntenna({
          id: 'ORA-5',
          gid: '2800503',
          op: 'orange',
          bandas: ['3500 MHz'],
        }),
        makeAntenna({
          id: 'DIG-5',
          gid: '2800502',
          op: 'digi',
          bandas: ['1800 MHz', '2100 MHz'],
        }),
        makeAntenna({
          id: 'MOV-5',
          gid: '2800501',
          op: 'movistar',
          bandas: ['26 GHz', '3500 MHz', '1800 MHz'],
        }),
      ],
    };
    expect(buildSiteBandCardRows(fiveOpSite)).toEqual([
      {
        op: 'movistar',
        color: OPERATOR_META.movistar.color,
        text: 'N258 N78+ B3',
      },
      { op: 'digi', color: OPERATOR_META.digi.color, text: 'B1 B3' },
      { op: 'orange', color: OPERATOR_META.orange.color, text: 'N78' },
      { op: 'vodafone', color: OPERATOR_META.vodafone.color, text: 'N78' },
      { op: 'otros', color: OPERATOR_META.otros.color, text: 'G9' },
    ]);

    // 3. Orange + Vodafone + DIGI (no Movistar): DIGI precedes Orange & Vodafone, nobody gets N78+
    const noMovistarSite = {
      members: [
        makeAntenna({
          id: 'ORA-NM',
          gid: '2800601',
          op: 'orange',
          bandas: ['3500 MHz'],
        }),
        makeAntenna({
          id: 'VOD-NM',
          gid: '2800602',
          op: 'vodafone',
          bandas: ['3500 MHz'],
        }),
        makeAntenna({
          id: 'DIG-NM',
          gid: '2800603',
          op: 'digi',
          bandas: ['3500 MHz', '1800 MHz'],
        }),
      ],
    };
    expect(buildSiteBandCardRows(noMovistarSite)).toEqual([
      { op: 'digi', color: OPERATOR_META.digi.color, text: 'N78 B3' },
      { op: 'orange', color: OPERATOR_META.orange.color, text: 'N78' },
      { op: 'vodafone', color: OPERATOR_META.vodafone.color, text: 'N78' },
    ]);

    // 4. Movistar (with N78) + DIGI (empty bandas): Movistar still gets N78+ and empty DIGI row is omitted
    const movWithEmptyDigiSite = {
      members: [
        makeAntenna({
          id: 'MOV-ED',
          gid: '2800701',
          op: 'movistar',
          frecuencias: ['3460.00 - 3560.00'],
        }),
        makeAntenna({
          id: 'DIG-ED',
          gid: '2800702',
          op: 'digi',
          bandas: [],
        }),
      ],
    };
    expect(buildSiteBandCardRows(movWithEmptyDigiSite)).toEqual([
      { op: 'movistar', color: OPERATOR_META.movistar.color, text: 'N78+' },
    ]);
  });

  it('skips members with empty bandas: [] in a multi-operator site', () => {
    const site = {
      members: [
        makeAntenna({
          id: 'MOV-1',
          gid: '2800201',
          op: 'movistar',
          bandas: ['800 MHz', '1800 MHz'],
        }),
        makeAntenna({
          id: 'ORA-1',
          gid: '2800202',
          op: 'orange',
          bandas: [],
        }),
        makeAntenna({
          id: 'DIG-1',
          gid: '2800203',
          op: 'digi',
          bandas: ['2100 MHz', '1800 MHz'],
        }),
      ],
    };

    const rows = buildSiteBandCardRows(site);
    expect(rows).toEqual([
      { op: 'movistar', color: '#0066CC', text: 'B3 B20' },
      { op: 'digi', color: '#7C3AED', text: 'B1 B3' },
    ]);
    expect(buildSiteBandCardKey(site)).toBe(
      'bandcard:movistar:B3 B20|digi:B1 B3',
    );
  });

  it('returns empty rows/key and null sprite when station has no bands or key is invalid', () => {
    const emptySite = {
      members: [
        makeAntenna({
          id: 'VOD-EMPTY',
          gid: '2800301',
          op: 'vodafone',
          bandas: [],
        }),
        makeAntenna({
          id: 'OTR-UNDEF',
          gid: '2800302',
          op: 'otros',
        }),
      ],
    };

    expect(buildSiteBandCardRows(emptySite)).toEqual([]);
    expect(buildSiteBandCardKey(emptySite)).toBe('');
    expect(parseSiteBandCardKey('')).toEqual([]);
    expect(parseSiteBandCardKey('bandcard:')).toEqual([]);
    expect(parseSiteBandCardKey('single:movistar')).toEqual([]);
    expect(
      parseSiteBandCardKey('bandcard:invalidOp:N28|digi:  |otros:G9'),
    ).toEqual([{ op: 'otros', color: '#64748B', text: 'G9' }]);
    expect(getOrCreateBandCardSprite('')).toBeNull();
    expect(getOrCreateBandCardSprite('bandcard:')).toBeNull();
    expect(getOrCreateBandCardSprite('multi:movistar|orange')).toBeNull();
  });
});

describe('renderBandCardSprite, getOrCreateBandCardSprite & clearBandCardSpriteCache', () => {
  it('renders High-DPI card with drop shadow, #FFFFFF fill, crisp border, operator-colored band tokens, and discreet #1E293B mini-dot separators', () => {
    expect(BAND_CARD_PIXEL_RATIO).toBe(2);
    expect(BAND_SEPARATOR_DOT_COLOR).toBe('#1E293B');
    expect(BAND_SEPARATOR_DOT_RADIUS).toBe(2.2);
    expect(BAND_SEPARATOR_GAP_PX).toBe(14);
    expect(BAND_N78_PLUS_BG_COLOR).toBe('#FFFF00');

    const env = createMockCanvasEnvironment({ measureWidthPerChar: 12 });
    const rows: BandCardRow[] = [
      { op: 'movistar', color: '#0066CC', text: 'N78 B7 B3 B20 N28' },
      { op: 'digi', color: '#7C3AED', text: 'N78 B7 B38 B3' },
    ];

    const sprite = renderBandCardSprite(rows);

    // Row 0: tokens [36, 24, 24, 36, 36] = 156 + 4 * 14 = 212px
    // Row 1: tokens [36, 24, 36, 24] = 120 + 3 * 14 = 162px
    // boxW = 212 + 28 = 240 -> canvasW = 240 + 16 = 256
    // 2 rows * 26px + 16px = 68px -> canvasH = 68 + 4 + 10 = 82
    expect(sprite.width).toBe(256);
    expect(sprite.height).toBe(82);
    expect(sprite.data).toHaveLength(256 * 82 * 4);
    expect(env.getCanvasSize()).toEqual({ width: 256, height: 82 });

    // Rounded rect manual quadraticCurveTo path + arc separator dots
    expect(env.pathOps).toContain('beginPath');
    expect(env.pathOps).toContain('quadraticCurveTo');
    expect(env.pathOps).toContain('arc');
    expect(env.pathOps).toContain('closePath');

    // Card background fill with soft drop shadow inside save/restore, followed by 7 discreet #1E293B separator dots
    expect(env.mockCtx.save).toHaveBeenCalledTimes(1);
    expect(env.mockCtx.restore).toHaveBeenCalledTimes(1);
    expect(env.fills[0]).toEqual({
      fillStyle: '#FFFFFF',
      shadowColor: 'rgba(15, 23, 42, 0.22)',
      shadowBlur: 7,
      shadowOffsetX: 0,
      shadowOffsetY: 3,
    });
    expect(env.fills).toHaveLength(1 + 7);
    for (let d = 1; d < env.fills.length; d++) {
      expect(env.fills[d]).toMatchObject({
        fillStyle: '#1E293B',
        shadowBlur: 0,
      });
    }

    // Subtle crisp border without shadow bleed
    expect(env.strokes).toEqual([
      {
        strokeStyle: 'rgba(15, 23, 42, 0.14)',
        lineWidth: 1.5,
        shadowBlur: 0,
      },
    ]);

    // Centered rows drawn left-to-right token-by-token in exact operator colors
    const row0Y = 4 + 8 + 13; // 25
    const row1Y = 4 + 8 + 26 + 13; // 51
    expect(env.fillTexts).toHaveLength(9);
    expect(env.fillTexts.slice(0, 5).map((t) => [t.text, t.x, t.y, t.fillStyle])).toEqual([
      ['N78', 22, row0Y, '#0066CC'],
      ['B7', 72, row0Y, '#0066CC'],
      ['B3', 110, row0Y, '#0066CC'],
      ['B20', 148, row0Y, '#0066CC'],
      ['N28', 198, row0Y, '#0066CC'],
    ]);
    expect(env.fillTexts[0]).toMatchObject({
      textAlign: 'left',
      textBaseline: 'middle',
      shadowBlur: 0,
    });
    expect(env.fillTexts[0].font).toContain('700 21px');

    expect(env.fillTexts.slice(5).map((t) => [t.text, t.x, t.y, t.fillStyle])).toEqual([
      ['N78', 47, row1Y, '#7C3AED'],
      ['B7', 97, row1Y, '#7C3AED'],
      ['B38', 135, row1Y, '#7C3AED'],
      ['B3', 185, row1Y, '#7C3AED'],
    ]);

    // 4 separator dots on row 0 and 3 separator dots on row 1, centered in each 14px gap
    expect(env.arcs).toHaveLength(7);
    expect(env.arcs.map((a) => [a.x, a.y, a.radius])).toEqual([
      [65, row0Y, 2.2],
      [103, row0Y, 2.2],
      [141, row0Y, 2.2],
      [191, row0Y, 2.2],
      [90, row1Y, 2.2],
      [128, row1Y, 2.2],
      [178, row1Y, 2.2],
    ]);
  });

  it('draws an electric yellow (#FFFF00) rounded pill behind Movistar N78+ only and keeps adjacent tokens/dots cleanly spaced', () => {
    const env = createMockCanvasEnvironment({ measureWidthPerChar: 12 });
    const rows: BandCardRow[] = [
      { op: 'movistar', color: '#0066CC', text: 'N258 N78+ B3' },
      { op: 'digi', color: '#7C3AED', text: 'B1 B3' },
      { op: 'orange', color: '#EA580C', text: 'N78 B3' },
    ];

    const sprite = renderBandCardSprite(rows);

    // Row 0: N258 (48) + N78+ pill (48 + 10 = 58) + B3 (24) + 2 * 14 = 158px
    // boxW = 158 + 28 = 186 -> canvasW = 186 + 16 = 202
    // 3 rows * 26 + 16 = 94 -> canvasH = 94 + 4 + 10 = 108
    expect(sprite.width).toBe(202);
    expect(sprite.height).toBe(108);

    const yellowFills = env.drawOrder.filter(
      (entry) =>
        entry.kind === 'fill' && entry.fillStyle === BAND_N78_PLUS_BG_COLOR,
    );
    expect(yellowFills).toHaveLength(1);
    expect(yellowFills[0]).toEqual({
      kind: 'fill',
      fillStyle: '#FFFF00',
      shadowBlur: 0,
      bounds: {
        minX: 84,
        maxX: 142,
        minY: 14,
        maxY: 36,
      },
    });

    // Yellow pill MUST be painted immediately before the Movistar 'N78+' text drawn inside it
    const pillIdx = env.drawOrder.findIndex(
      (entry) =>
        entry.kind === 'fill' && entry.fillStyle === BAND_N78_PLUS_BG_COLOR,
    );
    const n78PlusTextIdx = env.drawOrder.findIndex(
      (entry) => entry.kind === 'fillText' && entry.text === 'N78+',
    );
    expect(pillIdx).toBeGreaterThan(0);
    expect(n78PlusTextIdx).toBe(pillIdx + 1);
    expect(env.drawOrder[n78PlusTextIdx]).toEqual({
      kind: 'fillText',
      text: 'N78+',
      x: 89,
      y: 25,
      fillStyle: '#0066CC',
    });

    // Separator dots around the yellow pill remain centered in the 14px gap (x=77 before, x=149 after)
    expect(env.arcs.slice(0, 2).map((a) => [a.x, a.y])).toEqual([
      [77, 25],
      [149, 25],
    ]);

    // Total fills: 1 white card + 1 electric yellow pill + 4 separator dots
    expect(env.fills).toHaveLength(6);
    expect(
      env.fills.filter((f) => f.fillStyle === BAND_N78_PLUS_BG_COLOR),
    ).toHaveLength(1);
  });

  it('draws 0 separator dots for single-band rows, keeps B7+ and N28+ intact, and falls back to quadratic curves without ctx.arc', () => {
    const singleEnv = createMockCanvasEnvironment({ measureWidthPerChar: 12 });
    renderBandCardSprite([{ op: 'vodafone', color: '#E60000', text: 'N28+' }]);
    expect(singleEnv.fillTexts).toHaveLength(1);
    expect(singleEnv.fillTexts[0].text).toBe('N28+');
    expect(singleEnv.arcs).toHaveLength(0);
    // Only the card background fill (no separator dot fills)
    expect(singleEnv.fills).toHaveLength(1);

    const noArcEnv = createMockCanvasEnvironment({
      measureWidthPerChar: 12,
      withoutArc: true,
    });
    renderBandCardSprite([
      { op: 'orange', color: '#EA580C', text: 'N78 B7+ B7 N28+' },
    ]);
    expect(noArcEnv.fillTexts.map((t) => t.text)).toEqual([
      'N78',
      'B7+',
      'B7',
      'N28+',
    ]);
    // 1 card fill + 3 #1E293B dot fills drawn via quadraticCurveTo fallback
    expect(noArcEnv.fills).toHaveLength(4);
    expect(noArcEnv.fills.slice(1).map((f) => f.fillStyle)).toEqual([
      '#1E293B',
      '#1E293B',
      '#1E293B',
    ]);
  });

  it('uses deterministic fallback width when getContext("2d") is null or measureText returns 0', () => {
    const nullCtxEnv = createMockCanvasEnvironment({ nullContext: true });
    const row: BandCardRow[] = [
      { op: 'orange', color: '#EA580C', text: 'N78 B38 B3 N28' },
    ];
    const fallbackSprite = renderBandCardSprite(row);
    // Token widths: [37, 37, 25, 37] = 136 + 3 * 14 = 178 -> boxW = 206 -> canvasW = 222
    // 1 row * 26 + 16 = 42 -> canvasH = 42 + 14 = 56
    expect(fallbackSprite.width).toBe(222);
    expect(fallbackSprite.height).toBe(56);
    expect(nullCtxEnv.getCanvasSize()).toEqual({ width: 222, height: 56 });

    const zeroMeasureEnv = createMockCanvasEnvironment({
      measureWidthPerChar: 0,
    });
    const zeroMeasureSprite = renderBandCardSprite(row);
    expect(zeroMeasureSprite.width).toBe(222);
    expect(zeroMeasureSprite.height).toBe(56);
    expect(zeroMeasureEnv.fillTexts[0]?.fillStyle).toBe('#EA580C');

    vi.unstubAllGlobals();
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('ImageData', undefined);
    const headlessSprite = renderBandCardSprite(row);
    expect(headlessSprite.width).toBe(222);
    expect(headlessSprite.height).toBe(56);
    expect(headlessSprite.data).toBeInstanceOf(Uint8ClampedArray);
    expect(headlessSprite.data).toHaveLength(222 * 56 * 4);
  });

  it('caches sprites by key and re-renders after clearBandCardSpriteCache()', () => {
    const env = createMockCanvasEnvironment({ measureWidthPerChar: 12 });
    const key = 'bandcard:vodafone:N78 B7+ B7 B38 B1 B3 G9 B20 N28+';

    const first = getOrCreateBandCardSprite(key);
    expect(first).not.toBeNull();
    expect(env.createElement).toHaveBeenCalledTimes(1);

    const second = getOrCreateBandCardSprite(key);
    expect(second).toBe(first);
    expect(env.createElement).toHaveBeenCalledTimes(1);

    clearBandCardSpriteCache();

    const third = getOrCreateBandCardSprite(key);
    expect(third).not.toBeNull();
    expect(third).not.toBe(first);
    expect(env.createElement).toHaveBeenCalledTimes(2);

    // Distinct keys for Movistar N78 vs Movistar+DIGI N78+ stay isolated in cache
    const plainMov = getOrCreateBandCardSprite('bandcard:movistar:N78 B3');
    const boostedMov = getOrCreateBandCardSprite(
      'bandcard:movistar:N78+ B3|digi:B1 B3',
    );
    expect(plainMov).not.toBeNull();
    expect(boostedMov).not.toBeNull();
    expect(boostedMov).not.toBe(plainMov);
  });

  it('renders a single combined band row per operator when two Orange or Telefónica declarations share the exact same coordinate', () => {
    const sites = groupColocatedAntennasForMap([
      makeAntenna({
        id: 'ORANGE ESPAGNE, S.A.U. - GALR0044A',
        gid: 'GALR0044A',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 43.353278,
        lon: -8.423861,
        bandas: ['700 MHz', '900 MHz'],
        frecuencias: ['758.00 - 768.00', '925.10 - 935.10'],
      }),
      makeAntenna({
        id: 'ORANGE ESPAGNE, S.A.U. - GALR0044C',
        gid: 'GALR0044C',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 43.353278,
        lon: -8.423861,
        bandas: ['800 MHz', '3500 MHz'],
        frecuencias: ['832.00 - 842.00', '3600.00 - 3700.00'],
      }),
      makeAntenna({
        id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 0600001',
        gid: '0600001',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        lat: 43.353278,
        lon: -8.423861,
        bandas: ['800 MHz', '1800 MHz'],
        frecuencias: ['852.00 - 862.00', '1805.10 - 1825.10'],
      }),
      makeAntenna({
        id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 600001',
        gid: '600001',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        lat: 43.353278,
        lon: -8.423861,
        bandas: ['3500 MHz'],
        frecuencias: ['3460.00 - 3600.00'],
      }),
    ]);

    expect(sites).toHaveLength(1);
    expect(sites[0].members).toHaveLength(2);
    expect(buildSiteBandCardRows(sites[0])).toEqual([
      { op: 'movistar', color: OPERATOR_META.movistar.color, text: 'N78 B3 B20' },
      { op: 'orange', color: OPERATOR_META.orange.color, text: 'N78 G9 B20 N28' },
    ]);
  });
});
