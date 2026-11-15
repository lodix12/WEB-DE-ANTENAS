import { describe, expect, it } from 'vitest';
import type { AntennaRecord } from '../types/antena';
import {
  SPAIN_REGION_PRESETS,
  bearingToCardinal,
  calculateBearingDeg,
  createCirclePolygonGeoJSON,
  findNearestAntennas,
  formatDistance,
  groupColocatedAntennasForMap,
  haversineDistanceKm,
} from './geo';

const SAMPLE_ANTENNAS: AntennaRecord[] = [
  {
    id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
    gid: '2800001',
    op: 'movistar',
    opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
    lat: 40.418,
    lon: -3.7038,
    dir: 'C/ Gran Vía, 28',
    mun: 'Madrid',
    prov: 'Madrid',
  },
  {
    id: 'VODAFONE ESPAÑA, S.A.U. - 2800002',
    gid: '2800002',
    op: 'vodafone',
    opRaw: 'VODAFONE ESPAÑA, S.A.U.',
    lat: 40.4255,
    lon: -3.691,
    dir: 'Paseo de la Castellana, 14',
    mun: 'Madrid',
    prov: 'Madrid',
  },
  {
    id: 'ORANGE ESPAGNE, S.A.U. - 2800003',
    gid: '2800003',
    op: 'orange',
    opRaw: 'ORANGE ESPAGNE, S.A.U.',
    lat: 40.4531,
    lon: -3.6883,
    dir: 'Av. de Concha Espina, 1',
    mun: 'Madrid',
    prov: 'Madrid',
  },
  {
    id: 'DS MOBILE NETWORKS, S.L. - 0800001',
    gid: '0800001',
    op: 'digi',
    opRaw: 'DS MOBILE NETWORKS, S.L.',
    lat: 41.387,
    lon: 2.17,
    dir: 'Plaça de Catalunya, 1',
    mun: 'Barcelona',
    prov: 'Barcelona',
  },
];

describe('haversineDistanceKm', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineDistanceKm(40.4168, -3.7038, 40.4168, -3.7038)).toBe(0);
  });

  it('is symmetric between two geographic points', () => {
    const d1 = haversineDistanceKm(40.4168, -3.7038, 37.3891, -5.9845);
    const d2 = haversineDistanceKm(37.3891, -5.9845, 40.4168, -3.7038);
    expect(d1).toBeCloseTo(d2, 10);
  });

  it('computes accurate distance for 1 degree of latitude along a meridian (~111.195 km)', () => {
    const dist = haversineDistanceKm(40.0, -3.0, 41.0, -3.0);
    expect(dist).toBeGreaterThan(111.1);
    expect(dist).toBeLessThan(111.3);
  });

  it('computes geodesic distance between Madrid and Barcelona (~504-506 km)', () => {
    const madridToBcn = haversineDistanceKm(40.4168, -3.7038, 41.387, 2.17);
    expect(madridToBcn).toBeGreaterThan(503);
    expect(madridToBcn).toBeLessThan(507);
  });

  it('computes geodesic distance between Madrid and Canary Islands (~1737.5 km)', () => {
    const madridToGranCanaria = haversineDistanceKm(
      40.4168,
      -3.7038,
      28.1235,
      -15.4363,
    );
    expect(madridToGranCanaria).toBeGreaterThan(1730);
    expect(madridToGranCanaria).toBeLessThan(1745);
  });
});

describe('calculateBearingDeg', () => {
  it('computes cardinal bearings N (0°), E (90°), S (180°), and W (270°)', () => {
    expect(calculateBearingDeg(40.0, -3.0, 41.0, -3.0)).toBeCloseTo(0, 5);
    expect(calculateBearingDeg(0.0, 0.0, 0.0, 1.0)).toBeCloseTo(90, 5);
    expect(calculateBearingDeg(41.0, -3.0, 40.0, -3.0)).toBeCloseTo(180, 5);
    expect(calculateBearingDeg(0.0, 0.0, 0.0, -1.0)).toBeCloseTo(270, 5);
  });

  it('normalizes initial bearing into [0, 360) for southwest trajectories', () => {
    // Madrid -> Sevilla (suroeste)
    const bearing = calculateBearingDeg(40.4168, -3.7038, 37.3891, -5.9845);
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(360);
    expect(bearing).toBeGreaterThan(205);
    expect(bearing).toBeLessThan(225);
  });
});

describe('bearingToCardinal', () => {
  it('maps standard compass angles to Spanish cardinal abbreviations', () => {
    expect(bearingToCardinal(0)).toBe('N (0°)');
    expect(bearingToCardinal(45)).toBe('NE (45°)');
    expect(bearingToCardinal(90)).toBe('E (90°)');
    expect(bearingToCardinal(135)).toBe('SE (135°)');
    expect(bearingToCardinal(180)).toBe('S (180°)');
    expect(bearingToCardinal(225)).toBe('SO (225°)');
    expect(bearingToCardinal(270)).toBe('O (270°)');
    expect(bearingToCardinal(315)).toBe('NO (315°)');
  });

  it('normalizes negative angles and angles >= 360° cleanly', () => {
    expect(bearingToCardinal(360)).toBe('N (0°)');
    expect(bearingToCardinal(-90)).toBe('O (270°)');
    expect(bearingToCardinal(405)).toBe('NE (45°)');
    expect(bearingToCardinal(359.6)).toBe('N (360°)');
  });
});

describe('formatDistance', () => {
  it('formats distances below 1 km in rounded meters', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(0.1334)).toBe('133 m');
    expect(formatDistance(0.8756)).toBe('876 m');
  });

  it('formats distances between 1 km and 10 km with 2 decimal digits in es-ES format', () => {
    expect(formatDistance(1)).toBe('1,00 km');
    expect(formatDistance(2.346)).toBe('2,35 km');
    expect(formatDistance(9.991)).toBe('9,99 km');
  });

  it('formats distances >= 10 km with 1 decimal digit in es-ES format', () => {
    expect(formatDistance(10)).toBe('10,0 km');
    expect(formatDistance(42.76)).toBe('42,8 km');
  });
});

describe('findNearestAntennas', () => {
  const puertaDelSol = { lat: 40.4168, lon: -3.7038 };

  it('returns empty array when input list is empty', () => {
    expect(
      findNearestAntennas([], puertaDelSol.lat, puertaDelSol.lon),
    ).toEqual([]);
  });

  it('sorts stations ascending by distanceKm and populates bearing & cardinal', () => {
    const nearest = findNearestAntennas(
      SAMPLE_ANTENNAS,
      puertaDelSol.lat,
      puertaDelSol.lon,
      10,
    );

    expect(nearest).toHaveLength(4);
    expect(nearest[0].gid).toBe('2800001');
    expect(nearest[1].gid).toBe('2800002');
    expect(nearest[2].gid).toBe('2800003');
    expect(nearest[3].gid).toBe('0800001');

    for (let i = 1; i < nearest.length; i++) {
      expect(nearest[i].distanceKm).toBeGreaterThanOrEqual(
        nearest[i - 1].distanceKm,
      );
    }

    // Gran Vía está justo al norte de Puerta del Sol (~133 m, rumbo ~0° N)
    expect(nearest[0].distanceKm).toBeLessThan(0.2);
    expect(nearest[0].cardinal).toBe('N (0°)');
  });

  it('honors the limit parameter', () => {
    const topTwo = findNearestAntennas(
      SAMPLE_ANTENNAS,
      puertaDelSol.lat,
      puertaDelSol.lon,
      2,
    );
    expect(topTwo).toHaveLength(2);
    expect(topTwo.map((a) => a.gid)).toEqual(['2800001', '2800002']);
  });

  it('filters out stations beyond maxRadiusKm accurately', () => {
    const withinTwoKm = findNearestAntennas(
      SAMPLE_ANTENNAS,
      puertaDelSol.lat,
      puertaDelSol.lon,
      10,
      2,
    );
    // Gran Vía (~0.13 km) y Castellana 14 (~1.45 km) están a <= 2 km; Concha Espina (~4.2 km) y BCN (~504 km) quedan fuera
    expect(withinTwoKm.map((a) => a.gid)).toEqual(['2800001', '2800002']);
    for (const item of withinTwoKm) {
      expect(item.distanceKm).toBeLessThanOrEqual(2);
    }
  });
});

describe('createCirclePolygonGeoJSON', () => {
  it('creates a closed GeoJSON Polygon ring with exact vertex count and radius metadata', () => {
    const centerLon = -3.7038;
    const centerLat = 40.4168;
    const radiusKm = 2.5;
    const steps = 48;

    const poly = createCirclePolygonGeoJSON(
      centerLon,
      centerLat,
      radiusKm,
      steps,
    );

    expect(poly.type).toBe('Feature');
    expect(poly.geometry.type).toBe('Polygon');
    expect(poly.properties).toEqual({ radiusKm: 2.5 });

    const ring = poly.geometry.coordinates[0];
    expect(ring).toHaveLength(steps + 1);

    // El primer y último vértice deben cerrar el anillo
    expect(ring[0][0]).toBeCloseTo(ring[ring.length - 1][0], 10);
    expect(ring[0][1]).toBeCloseTo(ring[ring.length - 1][1], 10);

    // Cada vértice del polígono debe distar `radiusKm` del centro geodésico
    for (const [lon, lat] of ring) {
      const dist = haversineDistanceKm(centerLat, centerLon, lat, lon);
      expect(dist).toBeCloseTo(radiusKm, 3);
    }
  });

  it('exposes Spain region presets covering Peninsula, Canarias, Baleares, and Ceuta/Melilla', () => {
    const ids = SPAIN_REGION_PRESETS.map((p) => p.id);
    expect(ids).toContain('peninsula');
    expect(ids).toContain('canarias');
    expect(ids).toContain('baleares');
    expect(ids).toContain('ceuta-melilla');
  });
});

describe('groupColocatedAntennasForMap', () => {
  const baseLat = 40.4168;
  const baseLon = -3.7038;

  it('groups 2 or 3 antennas of distinct operators within < 5 m into 1 multi-operator MapSiteEntry in canonical OPERATOR_ORDER', () => {
    // 0.000034° de latitud ≈ 3.78 m (< 5 m)
    const offset3_8m = 0.000034;

    const vodafone: AntennaRecord = {
      id: 'VODAFONE ESPAÑA, S.A.U. - 2809003',
      gid: '2809003',
      op: 'vodafone',
      opRaw: 'VODAFONE ESPAÑA, S.A.U.',
      lat: baseLat + offset3_8m,
      lon: baseLon,
      dir: 'Torre Compartida, 1',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const orange: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - 2809002',
      gid: '2809002',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Torre Compartida, 1',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const movistar: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809001',
      gid: '2809001',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Torre Compartida, 1',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    const distMeters =
      haversineDistanceKm(orange.lat, orange.lon, vodafone.lat, vodafone.lon) *
      1000;
    expect(distMeters).toBeGreaterThan(3.5);
    expect(distMeters).toBeLessThan(5);

    // Pasamos los registros desordenados para verificar el orden canónico de salida
    const sites = groupColocatedAntennasForMap([vodafone, orange, movistar], 5);

    expect(sites).toHaveLength(1);
    const site = sites[0];
    expect(site.isMultiOperator).toBe(true);
    expect(site.operators).toEqual(['movistar', 'orange', 'vodafone']);
    expect(site.iconKey).toBe('multi:movistar|orange|vodafone');
    expect(site.members.map((m) => m.op)).toEqual([
      'movistar',
      'orange',
      'vodafone',
    ]);
    expect(site.primary.id).toBe(movistar.id);
    expect(site.siteId).toBe(
      `site:${movistar.id}||${orange.id}||${vodafone.id}`,
    );
    expect(site.lat).toBeCloseTo(
      (movistar.lat + orange.lat + vodafone.lat) / 3,
      7,
    );
    expect(site.lon).toBeCloseTo(baseLon, 7);
  });

  it('keeps antennas of distinct operators at >= 5 m (~6.2 m) as separate individual entries', () => {
    // 0.000056° de latitud ≈ 6.23 m (>= 5 m)
    const offset6_2m = 0.000056;

    const movistar: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809101',
      gid: '2809101',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Azotea Norte',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const digi: AntennaRecord = {
      id: 'DS MOBILE NETWORKS, S.L. - 2809102',
      gid: '2809102',
      op: 'digi',
      opRaw: 'DS MOBILE NETWORKS, S.L.',
      lat: baseLat + offset6_2m,
      lon: baseLon,
      dir: 'Azotea Sur',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    const distMeters =
      haversineDistanceKm(movistar.lat, movistar.lon, digi.lat, digi.lon) *
      1000;
    expect(distMeters).toBeGreaterThanOrEqual(5);

    const sites = groupColocatedAntennasForMap([movistar, digi], 5);

    expect(sites).toHaveLength(2);
    expect(sites[0].isMultiOperator).toBe(false);
    expect(sites[0].operators).toEqual(['movistar']);
    expect(sites[1].isMultiOperator).toBe(false);
    expect(sites[1].operators).toEqual(['digi']);
  });

  it('automatically transitions a shared site to isMultiOperator: false when filtered down to 1 active operator', () => {
    const movistar: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809201',
      gid: '2809201',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'C/ Alcalá, 50',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const orange: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - 2809202',
      gid: '2809202',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'C/ Alcalá, 50',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    const combined = groupColocatedAntennasForMap([movistar, orange], 5);
    expect(combined).toHaveLength(1);
    expect(combined[0].isMultiOperator).toBe(true);

    // Al filtrar solo Orange en el mapa, pasa a marcador individual de Orange
    const onlyOrange = groupColocatedAntennasForMap([orange], 5);
    expect(onlyOrange).toHaveLength(1);
    expect(onlyOrange[0].isMultiOperator).toBe(false);
    expect(onlyOrange[0].operators).toEqual(['orange']);
    expect(onlyOrange[0].iconKey).toBe('single:orange');
  });

  it('keeps same-operator non-Vodafone records (< 5 m) separate while defensively fusing residual Vodafone (< 10 m) into 1 entry', () => {
    const movA: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809301',
      gid: '2809301',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Av. América, 10',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const movB: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809302',
      gid: '2809302',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat + 0.000018, // ~2 m
      lon: baseLon,
      dir: 'Av. América, 10',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    const movSites = groupColocatedAntennasForMap([movA, movB], 5);
    expect(movSites).toHaveLength(2);
    expect(movSites.every((s) => !s.isMultiOperator)).toBe(true);

    // Dos declaraciones de Vodafone a ~7.5 m (< 10 m) se representan como 1 sola antena
    const vodA: AntennaRecord = {
      id: 'VODAFONE ESPAÑA, S.A.U. - 2809401',
      gid: '2809401',
      op: 'vodafone',
      opRaw: 'VODAFONE ESPAÑA, S.A.U.',
      lat: 41.387,
      lon: 2.17,
      dir: 'Diagonal, 100',
      mun: 'Barcelona',
      prov: 'Barcelona',
    };
    const vodB: AntennaRecord = {
      id: 'VODAFONE ESPAÑA, S.A.U. - 2809402',
      gid: '2809402',
      op: 'vodafone',
      opRaw: 'VODAFONE ESPAÑA, S.A.U.',
      lat: 41.387 + 0.000067, // ~7.45 m (< 10 m)
      lon: 2.17,
      dir: 'Diagonal, 100',
      mun: 'Barcelona',
      prov: 'Barcelona',
    };

    const vodSites = groupColocatedAntennasForMap([vodB, vodA], 5);
    expect(vodSites).toHaveLength(1);
    expect(vodSites[0].isMultiOperator).toBe(false);
    expect(vodSites[0].operators).toEqual(['vodafone']);
    expect(vodSites[0].primary.mergedGids).toEqual(['2809401', '2809402']);
    expect(vodSites[0].memberIds).toEqual([vodB.id, vodA.id]);
  });
});

