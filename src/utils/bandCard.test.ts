import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_META, type AntennaRecord } from '../types/antena';
import {
  BAND_CARD_KEY_PREFIX,
  BAND_CARD_PIXEL_RATIO,
  buildSiteBandCardKey,
  buildSiteBandCardRows,
  classifyFrequencyRangeToBandCode,
  clearBandCardSpriteCache,
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

function createMockCanvasEnvironment(options?: {
  measureWidthPerChar?: number;
  nullContext?: boolean;
}) {
  const measureWidthPerChar = options?.measureWidthPerChar ?? 11.5;
  const fills: FillCapture[] = [];
  const strokes: StrokeCapture[] = [];
  const fillTexts: FillTextCapture[] = [];
  const pathOps: string[] = [];

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

  const mockCtx = {
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
      pathOps.push('beginPath');
    }),
    moveTo: vi.fn(() => {
      pathOps.push('moveTo');
    }),
    lineTo: vi.fn(() => {
      pathOps.push('lineTo');
    }),
    quadraticCurveTo: vi.fn(() => {
      pathOps.push('quadraticCurveTo');
    }),
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
    }),
    getImageData: vi.fn((_sx: number, _sy: number, sw: number, sh: number) => ({
      width: sw,
      height: sh,
      data: new Uint8ClampedArray(sw * sh * 4),
    })),
  };

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
    pathOps,
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
    // N28 (700 MHz / 703..788 MHz)
    expect(classifyFrequencyRangeToBandCode('700 MHz')).toBe('N28');
    expect(classifyFrequencyRangeToBandCode('703.00 - 733.00')).toBe('N28');
    expect(classifyFrequencyRangeToBandCode('758.00 - 788.00')).toBe('N28');
    expect(formatCompactBandToken('700 MHz')).toBe('N28');

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

    // B7 (2600 MHz FDD)
    expect(classifyFrequencyRangeToBandCode('2600 MHz')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2620.00 - 2640.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2660.00 - 2680.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2500.00 - 2570.00')).toBe('B7');
    expect(formatCompactBandToken('2600 MHz')).toBe('B7');

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

  it('enforces exact [2570, 2620] MHz inclusive boundaries for TDD B38 vs FDD B7', () => {
    // Inside [2570, 2620] inclusive -> B38
    expect(classifyFrequencyRangeToBandCode('2570.00 - 2620.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2575.00 - 2585.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2575.00 - 2595.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2595.00 - 2605.00')).toBe('B38');
    expect(classifyFrequencyRangeToBandCode('2605.00 - 2615.00')).toBe('B38');

    // Touching 2620 or 2570 but extending outside [2570, 2620] -> B7
    expect(classifyFrequencyRangeToBandCode('2620.00 - 2640.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2640.00 - 2660.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2680.00 - 2690.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2550.00 - 2570.00')).toBe('B7');
    expect(classifyFrequencyRangeToBandCode('2500.00 - 2570.00')).toBe('B7');

    // Reversed / malformed range rejected
    expect(classifyFrequencyRangeToBandCode('2620.00 - 2570.00')).toBeNull();
  });

  it('normalizes already-formatted band codes case-insensitively and handles unknown/empty strings', () => {
    expect(formatCompactBandToken('n258')).toBe('N258');
    expect(formatCompactBandToken('n78')).toBe('N78');
    expect(formatCompactBandToken('b7')).toBe('B7');
    expect(formatCompactBandToken('b38')).toBe('B38');
    expect(formatCompactBandToken('b1')).toBe('B1');
    expect(formatCompactBandToken('b3')).toBe('B3');
    expect(formatCompactBandToken('g9')).toBe('G9');
    expect(formatCompactBandToken('b20')).toBe('B20');
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

describe('extractAntennaBandCodes & formatAntennaBandsCompact', () => {
  it('sorts all 9 canonical band codes strictly descending: N258 N78 B7 B38 B1 B3 G9 B20 N28', () => {
    expect(
      formatAntennaBandsCompact(
        [
          '700 MHz',
          '800 MHz',
          '900 MHz',
          '1800 MHz',
          '2100 MHz',
          '2600 MHz',
          '3500 MHz',
          '26 MHz',
        ],
        ['2575.00 - 2595.00', '2660.00 - 2680.00'],
      ),
    ).toBe('N258 N78 B7 B38 B1 B3 G9 B20 N28');
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

  it('separates B38-only, B7-only, dual B7+B38, and synthetic 2600 MHz fallback stations accurately', () => {
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

  it('orders multi-operator < 35 m shared sites canonically with exact OPERATOR_META colors and descending band codes', () => {
    // Input intentionally unsorted: Vodafone + Movistar + DIGI + Orange within ~10 m (< 35 m)
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

    const sites = groupColocatedAntennasForMap(rawAntennas, 35);
    expect(sites).toHaveLength(1);
    expect(sites[0].isMultiOperator).toBe(true);

    const rows = buildSiteBandCardRows(sites[0]);
    expect(rows).toEqual([
      {
        op: 'movistar',
        color: OPERATOR_META.movistar.color,
        text: 'N78 B3 B20 N28',
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
      {
        op: 'digi',
        color: OPERATOR_META.digi.color,
        text: 'B1 B3',
      },
    ]);

    const key = buildSiteBandCardKey(sites[0]);
    expect(key).toBe(
      'bandcard:movistar:N78 B3 B20 N28|orange:N258 N78 N28|vodafone:N78 B7 B38 G9 N28|digi:B1 B3',
    );
    expect(parseSiteBandCardKey(key)).toEqual(rows);
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
          id: 'MAS-1',
          gid: '2800203',
          op: 'masmovil',
          bandas: ['2100 MHz', '1800 MHz'],
        }),
      ],
    };

    const rows = buildSiteBandCardRows(site);
    expect(rows).toEqual([
      { op: 'movistar', color: '#0066CC', text: 'B3 B20' },
      { op: 'masmovil', color: '#0D9488', text: 'B1 B3' },
    ]);
    expect(buildSiteBandCardKey(site)).toBe(
      'bandcard:movistar:B3 B20|masmovil:B1 B3',
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
  it('renders High-DPI card with drop shadow, #FFFFFF fill, crisp border, and centered operator-colored rows', () => {
    expect(BAND_CARD_PIXEL_RATIO).toBe(2);

    const env = createMockCanvasEnvironment({ measureWidthPerChar: 12 });
    const rows: BandCardRow[] = [
      { op: 'movistar', color: '#0066CC', text: 'N78 B7 B3 B20 N28' },
      { op: 'digi', color: '#7C3AED', text: 'N78 B7 B38 B3' },
    ];

    const sprite = renderBandCardSprite(rows);

    // Longest row has 17 chars * 12px = 204px -> boxW = 204 + 28 = 232 -> canvasW = 232 + 16 = 248
    // 2 rows * 26px + 16px = 68px -> canvasH = 68 + 4 + 10 = 82
    expect(sprite.width).toBe(248);
    expect(sprite.height).toBe(82);
    expect(sprite.data).toHaveLength(248 * 82 * 4);
    expect(env.getCanvasSize()).toEqual({ width: 248, height: 82 });

    // Rounded rect manual quadraticCurveTo path (works without ctx.roundRect)
    expect(env.pathOps).toContain('beginPath');
    expect(env.pathOps).toContain('quadraticCurveTo');
    expect(env.pathOps).toContain('closePath');

    // Card background fill with soft drop shadow inside save/restore
    expect(env.mockCtx.save).toHaveBeenCalledTimes(1);
    expect(env.mockCtx.restore).toHaveBeenCalledTimes(1);
    expect(env.fills).toEqual([
      {
        fillStyle: '#FFFFFF',
        shadowColor: 'rgba(15, 23, 42, 0.22)',
        shadowBlur: 7,
        shadowOffsetX: 0,
        shadowOffsetY: 3,
      },
    ]);

    // Subtle crisp border without shadow bleed
    expect(env.strokes).toEqual([
      {
        strokeStyle: 'rgba(15, 23, 42, 0.14)',
        lineWidth: 1.5,
        shadowBlur: 0,
      },
    ]);

    // Centered bold rows in exact operator colors at 2x coordinates
    const expectedCenterX = 8 + 232 / 2; // 124
    expect(env.fillTexts).toHaveLength(2);
    expect(env.fillTexts[0]).toMatchObject({
      text: 'N78 B7 B3 B20 N28',
      x: expectedCenterX,
      y: 4 + 8 + 13,
      fillStyle: '#0066CC',
      textAlign: 'center',
      textBaseline: 'middle',
      shadowBlur: 0,
    });
    expect(env.fillTexts[0].font).toContain('700 21px');
    expect(env.fillTexts[1]).toMatchObject({
      text: 'N78 B7 B38 B3',
      x: expectedCenterX,
      y: 4 + 8 + 26 + 13,
      fillStyle: '#7C3AED',
      textAlign: 'center',
      textBaseline: 'middle',
      shadowBlur: 0,
    });
  });

  it('uses deterministic fallback width when getContext("2d") is null or measureText returns 0', () => {
    const nullCtxEnv = createMockCanvasEnvironment({ nullContext: true });
    const row: BandCardRow[] = [
      { op: 'orange', color: '#EA580C', text: 'N78 B38 B3 N28' },
    ];
    const fallbackSprite = renderBandCardSprite(row);
    // 14 chars * 12.2 = 170.8 -> ceil = 171 -> boxW = 199 -> canvasW = 215
    // 1 row * 26 + 16 = 42 -> canvasH = 42 + 14 = 56
    expect(fallbackSprite.width).toBe(215);
    expect(fallbackSprite.height).toBe(56);
    expect(nullCtxEnv.getCanvasSize()).toEqual({ width: 215, height: 56 });

    const zeroMeasureEnv = createMockCanvasEnvironment({
      measureWidthPerChar: 0,
    });
    const zeroMeasureSprite = renderBandCardSprite(row);
    expect(zeroMeasureSprite.width).toBe(215);
    expect(zeroMeasureSprite.height).toBe(56);
    expect(zeroMeasureEnv.fillTexts[0]?.fillStyle).toBe('#EA580C');

    vi.unstubAllGlobals();
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('ImageData', undefined);
    const headlessSprite = renderBandCardSprite(row);
    expect(headlessSprite.width).toBe(215);
    expect(headlessSprite.height).toBe(56);
    expect(headlessSprite.data).toBeInstanceOf(Uint8ClampedArray);
    expect(headlessSprite.data).toHaveLength(215 * 56 * 4);
  });

  it('caches sprites by key and re-renders after clearBandCardSpriteCache()', () => {
    const env = createMockCanvasEnvironment({ measureWidthPerChar: 12 });
    const key = 'bandcard:vodafone:N78 B7 B38 B1 B3 G9 B20 N28';

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
  });
});
