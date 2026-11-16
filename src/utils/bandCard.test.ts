import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_META, type AntennaRecord } from '../types/antena';
import {
  BAND_CARD_KEY_PREFIX,
  BAND_CARD_PIXEL_RATIO,
  buildSiteBandCardKey,
  buildSiteBandCardRows,
  clearBandCardSpriteCache,
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

describe('formatCompactBandToken', () => {
  it('strips trailing MHz case-insensitively and trims whitespace', () => {
    expect(formatCompactBandToken('700 MHz')).toBe('700');
    expect(formatCompactBandToken('1800 mhz')).toBe('1800');
    expect(formatCompactBandToken('3500MHz')).toBe('3500');
    expect(formatCompactBandToken('  2100 MHz  ')).toBe('2100');
    expect(formatCompactBandToken('2600 MHz')).toBe('2600');
  });

  it('normalizes MINETUR 26 MHz and 27 MHz mmWave buckets to 26 GHz', () => {
    expect(formatCompactBandToken('26 MHz')).toBe('26 GHz');
    expect(formatCompactBandToken('27 MHz')).toBe('26 GHz');
    expect(formatCompactBandToken('  26 mhz ')).toBe('26 GHz');
    expect(formatCompactBandToken('27MHz')).toBe('26 GHz');
  });

  it('preserves GHz labels and handles empty strings cleanly', () => {
    expect(formatCompactBandToken('26 GHz')).toBe('26 GHz');
    expect(formatCompactBandToken('  26 GHz  ')).toBe('26 GHz');
    expect(formatCompactBandToken('')).toBe('');
    expect(formatCompactBandToken('   ')).toBe('');
  });
});

describe('formatAntennaBandsCompact', () => {
  it('sorts unsorted MHz bands ascending and joins compact tokens with spaces', () => {
    expect(
      formatAntennaBandsCompact([
        '3500 MHz',
        '1800 MHz',
        '700 MHz',
        '2600 MHz',
        '800 MHz',
        '2100 MHz',
        '900 MHz',
      ]),
    ).toBe('700 800 900 1800 2100 2600 3500');
  });

  it('deduplicates repeated bands and normalizes 26 MHz / 27 MHz to 26 GHz after 3500', () => {
    expect(
      formatAntennaBandsCompact([
        '26 MHz',
        '3500 MHz',
        '1800 mhz',
        '27 MHz',
        '700 MHz',
        '1800 MHz',
        '700',
      ]),
    ).toBe('700 1800 3500 26 GHz');
  });

  it('returns empty string for null, undefined, or empty band arrays', () => {
    expect(formatAntennaBandsCompact(undefined)).toBe('');
    expect(formatAntennaBandsCompact(null)).toBe('');
    expect(formatAntennaBandsCompact([])).toBe('');
    expect(formatAntennaBandsCompact(['', '   '])).toBe('');
  });
});

describe('buildSiteBandCardRows, buildSiteBandCardKey & parseSiteBandCardKey', () => {
  it('builds single-operator rows and keys with exact OPERATOR_META colors (Movistar, Orange, DIGI)', () => {
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
        text: '700 800 1800 3500',
      },
    ]);
    const movKey = buildSiteBandCardKey(movistarSite);
    expect(movKey).toBe('bandcard:movistar:700 800 1800 3500');
    expect(parseSiteBandCardKey(movKey)).toEqual(
      buildSiteBandCardRows(movistarSite),
    );

    const orangeSite = {
      members: [
        makeAntenna({
          id: 'ORA-1',
          gid: '2800002',
          op: 'orange',
          bandas: ['2100 MHz', '900 MHz'],
        }),
      ],
    };
    expect(buildSiteBandCardRows(orangeSite)).toEqual([
      {
        op: 'orange',
        color: '#EA580C',
        text: '900 2100',
      },
    ]);

    const digiSite = {
      members: [
        makeAntenna({
          id: 'DIG-1',
          gid: '2800003',
          op: 'digi',
          bandas: ['2600 MHz', '1800 MHz', '3500 MHz'],
        }),
      ],
    };
    const digiRows = buildSiteBandCardRows(digiSite);
    expect(digiRows).toEqual([
      {
        op: 'digi',
        color: '#7C3AED',
        text: '1800 2600 3500',
      },
    ]);
    const digiKey = buildSiteBandCardKey(digiSite);
    expect(digiKey).toBe(`${BAND_CARD_KEY_PREFIX}digi:1800 2600 3500`);
    expect(parseSiteBandCardKey(digiKey)).toEqual(digiRows);
  });

  it('orders multi-operator < 35 m shared sites canonically with exact OPERATOR_META colors', () => {
    // Input intentionally unsorted: Vodafone + Movistar + DIGI + Orange within ~10 m (< 35 m)
    const rawAntennas: AntennaRecord[] = [
      makeAntenna({
        id: 'VOD-1',
        gid: '2800103',
        op: 'vodafone',
        lat: 40.4168,
        lon: -3.7038,
        bandas: ['900 MHz', '700 MHz', '3500 MHz'],
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
        bandas: ['26 MHz', '3500 MHz', '700 MHz'],
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
        text: '700 800 1800 3500',
      },
      {
        op: 'orange',
        color: OPERATOR_META.orange.color,
        text: '700 3500 26 GHz',
      },
      {
        op: 'vodafone',
        color: OPERATOR_META.vodafone.color,
        text: '700 900 3500',
      },
      {
        op: 'digi',
        color: OPERATOR_META.digi.color,
        text: '1800 2100',
      },
    ]);

    const key = buildSiteBandCardKey(sites[0]);
    expect(key).toBe(
      'bandcard:movistar:700 800 1800 3500|orange:700 3500 26 GHz|vodafone:700 900 3500|digi:1800 2100',
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
      { op: 'movistar', color: '#0066CC', text: '800 1800' },
      { op: 'masmovil', color: '#0D9488', text: '1800 2100' },
    ]);
    expect(buildSiteBandCardKey(site)).toBe(
      'bandcard:movistar:800 1800|masmovil:1800 2100',
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
      parseSiteBandCardKey('bandcard:invalidOp:700|digi:  |otros:900'),
    ).toEqual([{ op: 'otros', color: '#64748B', text: '900' }]);
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
      { op: 'movistar', color: '#0066CC', text: '700 800 1800 3500' },
      { op: 'digi', color: '#7C3AED', text: '1800 2600 3500' },
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
      text: '700 800 1800 3500',
      x: expectedCenterX,
      y: 4 + 8 + 13,
      fillStyle: '#0066CC',
      textAlign: 'center',
      textBaseline: 'middle',
      shadowBlur: 0,
    });
    expect(env.fillTexts[0].font).toContain('700 21px');
    expect(env.fillTexts[1]).toMatchObject({
      text: '1800 2600 3500',
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
      { op: 'orange', color: '#EA580C', text: '700 1800 3500' },
    ];
    const fallbackSprite = renderBandCardSprite(row);
    // 13 chars * 12.2 = 158.6 -> ceil = 159 -> boxW = 187 -> canvasW = 203
    // 1 row * 26 + 16 = 42 -> canvasH = 42 + 14 = 56
    expect(fallbackSprite.width).toBe(203);
    expect(fallbackSprite.height).toBe(56);
    expect(nullCtxEnv.getCanvasSize()).toEqual({ width: 203, height: 56 });

    const zeroMeasureEnv = createMockCanvasEnvironment({
      measureWidthPerChar: 0,
    });
    const zeroMeasureSprite = renderBandCardSprite(row);
    expect(zeroMeasureSprite.width).toBe(203);
    expect(zeroMeasureSprite.height).toBe(56);
    expect(zeroMeasureEnv.fillTexts[0]?.fillStyle).toBe('#EA580C');

    vi.unstubAllGlobals();
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('ImageData', undefined);
    const headlessSprite = renderBandCardSprite(row);
    expect(headlessSprite.width).toBe(203);
    expect(headlessSprite.height).toBe(56);
    expect(headlessSprite.data).toBeInstanceOf(Uint8ClampedArray);
    expect(headlessSprite.data).toHaveLength(203 * 56 * 4);
  });

  it('caches sprites by key and re-renders after clearBandCardSpriteCache()', () => {
    const env = createMockCanvasEnvironment({ measureWidthPerChar: 12 });
    const key = 'bandcard:vodafone:700 800 900 1800 2100 3500';

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
