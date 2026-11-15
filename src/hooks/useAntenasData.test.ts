import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AntenasDataset } from '../types/antena';
import {
  buildCustomJsonExportPayload,
  normalizeSearchText,
  parseCoordinateInput,
} from '../utils/export';
import {
  buildDerivedAntenasStructures,
  importAntenasJsonDataset,
  parseCustomAntenasJson,
} from './useAntenasData';

function createSampleCustomDataset(): AntenasDataset {
  return {
    updatedAt: '2026-11-15T04:00:00Z',
    sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
    total: 3,
    crawlStats: {
      requestsCount: 2,
      durationSeconds: 2.4,
      gridBoxesVisited: 2,
      subdividedBoxes: 0,
      zoomParam: 7,
      delaySeconds: 1.0,
    },
    operators: {
      movistar: {
        key: 'movistar',
        name: 'Movistar (Telefónica)',
        count: 2,
        legalEntities: ['TELEFONICA MOVILES ESPAÑA, S.A.U.'],
      },
      orange: {
        key: 'orange',
        name: 'Orange (MasOrange)',
        count: 1,
        legalEntities: ['ORANGE ESPAGNE, S.A.U.'],
      },
      vodafone: {
        key: 'vodafone',
        name: 'Vodafone España',
        count: 0,
        legalEntities: [],
      },
      masmovil: {
        key: 'masmovil',
        name: 'Yoigo / Grupo MásMóvil',
        count: 0,
        legalEntities: [],
      },
      digi: {
        key: 'digi',
        name: 'DIGI Spain',
        count: 0,
        legalEntities: [],
      },
      otros: {
        key: 'otros',
        name: 'Otros Operadores',
        count: 0,
        legalEntities: [],
      },
    },
    provinces: [
      {
        provincia: 'MADRID',
        count: 2,
        byOperator: { movistar: 1, orange: 1 },
      },
      {
        provincia: 'ÁLAVA',
        count: 1,
        byOperator: { movistar: 1 },
      },
    ],
    antenas: [
      {
        id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
        gid: '2800001',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        lat: 40.4168,
        lon: -3.7038,
        dir: 'GRAN VIA 28',
        mun: 'MADRID',
        prov: 'MADRID',
      },
      {
        id: 'ORANGE ESPAGNE, S.A.U. - 2800002',
        gid: '2800002',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 40.48,
        lon: -3.36,
        dir: 'PLAZA CERVANTES 1',
        mun: 'ALCALÁ DE HENARES',
        prov: 'MADRID',
      },
      {
        id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 0100001',
        gid: '0100001',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        lat: 42.8467,
        lon: -2.6716,
        dir: 'CALLE DATO 5',
        mun: 'VITORIA-GASTEIZ',
        prov: 'ÁLAVA',
      },
    ],
  };
}

describe('normalizeSearchText y parseCoordinateInput', () => {
  it('elimina tildes y convierte a minúsculas', () => {
    expect(normalizeSearchText('Alcalá de Guadaíra (Málaga)')).toBe(
      'alcala de guadaira (malaga)',
    );
  });

  it('detecta coordenadas WGS84 válidas en distintos formatos', () => {
    expect(parseCoordinateInput('40.4168, -3.7038')).toEqual({
      lat: 40.4168,
      lon: -3.7038,
    });
    expect(parseCoordinateInput('28.1235 -15.4363')).toEqual({
      lat: 28.1235,
      lon: -15.4363,
    });
    expect(parseCoordinateInput('40,4168; -3,7038')).toEqual({
      lat: 40.4168,
      lon: -3.7038,
    });
  });

  it('rechaza búsquedas de texto o valores fuera de rango WGS84', () => {
    expect(parseCoordinateInput('Madrid Centro 28001')).toBeNull();
    expect(parseCoordinateInput('3600449')).toBeNull();
    expect(parseCoordinateInput('95.123, -3.7038')).toBeNull();
  });
});

describe('parseCustomAntenasJson e importAntenasJsonDataset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('valida y devuelve intacto un dataset con el esquema JSON propio AntenasDataset', () => {
    const sample = createSampleCustomDataset();
    const parsed = parseCustomAntenasJson(sample);
    expect(parsed).toEqual(sample);
    expect(parsed.antenas).toHaveLength(3);
    expect(parsed.antenas[0].gid).toBe('2800001');
  });

  it('rechaza explícitamente una FeatureCollection GeoJSON exigiendo el JSON propio de RadioMapa', () => {
    const rawGeoJson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] },
          properties: {
            Gis_ID: '2800001',
            Operador: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          },
        },
      ],
    };

    expect(() => parseCustomAntenasJson(rawGeoJson)).toThrow(
      /Formato GeoJSON.*JSON propio/i,
    );
  });

  it('rechaza entidades GeoJSON infiltradas dentro del array antenas', () => {
    const sample = createSampleCustomDataset();
    const corrupted = {
      ...sample,
      antenas: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] },
          properties: {},
        },
      ],
    };

    expect(() => parseCustomAntenasJson(corrupted)).toThrow(
      /GeoJSON.*JSON propio/i,
    );
  });

  it('importAntenasJsonDataset solicita data/antenas.json y rechaza respuestas GeoJSON', async () => {
    const sample = createSampleCustomDataset();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sample), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ type: 'FeatureCollection', features: [] }),
          { status: 200, headers: { 'Content-Type': 'application/geo+json' } },
        ),
      );

    const loaded = await importAntenasJsonDataset();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/data\/antenas\.json$/);
    expect(loaded.total).toBe(3);

    await expect(importAntenasJsonDataset()).rejects.toThrow(
      /Formato GeoJSON.*JSON propio/i,
    );
  });
});

describe('buildDerivedAntenasStructures y exportación en JSON propio', () => {
  it('construye índices rápidos por provincia, municipio, operador y Gis_ID', () => {
    const sample = createSampleCustomDataset();

    const derived = buildDerivedAntenasStructures(sample);
    expect(derived.totalUniqueMunicipalities).toBe(3);
    expect(derived.operatorCounts.movistar).toBe(2);
    expect(derived.operatorCounts.orange).toBe(1);
    expect(derived.byGid.get('2800002')?.mun).toBe('ALCALÁ DE HENARES');
    expect(derived.provincesByAlpha[0].provincia).toBe('ÁLAVA');
    expect(derived.municipalitiesByProvince.get('MADRID')).toHaveLength(2);
    expect(derived.searchIndex[1]).toContain('alcala de henares');
  });

  it('genera payload de exportación en esquema JSON propio con y sin radarPoint', () => {
    const sample = createSampleCustomDataset();

    const withoutRadar = buildCustomJsonExportPayload(sample.antenas);
    expect(withoutRadar.source).toBe('RadioMapa España');
    expect(withoutRadar.total).toBe(3);
    expect(withoutRadar.radarPoint).toBeUndefined();
    expect(withoutRadar.antenas[0].fichaMinetur).toContain('detalleEstacion.do');
    expect(withoutRadar.antenas[0].distanciaMetros).toBeUndefined();

    const withRadar = buildCustomJsonExportPayload(sample.antenas, {
      lat: 40.4168,
      lon: -3.7038,
      radiusKm: 5,
    });
    expect(withRadar.radarPoint).toEqual({
      lat: 40.4168,
      lon: -3.7038,
      radiusKm: 5,
    });
    expect(withRadar.antenas[0].distanciaMetros).toBe(0);
    expect(typeof withRadar.antenas[1].acimutGrados).toBe('number');
    expect(withRadar.antenas[1].rumboCardinal).toBeTruthy();
  });
});
