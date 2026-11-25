import { describe, expect, it } from 'vitest';
import type { AntennaRecord } from '../types/antena';
import {
  MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
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

  it('groups antennas of distinct operators within < 15 m (~14 m) by default into 1 multi-operator MapSiteEntry in canonical OPERATOR_ORDER', () => {
    // ~7 m y ~14 m en latitud (todas las parejas distan < 15 m: 7 m, 7 m y 14 m)
    const offset7m = 0.000063;
    const offset14m = 0.000126;

    const digi: AntennaRecord = {
      id: 'DS MOBILE NETWORKS, S.L. - 2809003',
      gid: '2809003',
      op: 'digi',
      opRaw: 'DS MOBILE NETWORKS, S.L.',
      lat: baseLat + offset14m,
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
      lat: baseLat + offset7m,
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

    const maxPairwiseDistMeters =
      haversineDistanceKm(movistar.lat, movistar.lon, digi.lat, digi.lon) *
      1000;
    expect(maxPairwiseDistMeters).toBeGreaterThan(13);
    expect(maxPairwiseDistMeters).toBeLessThan(15);

    // Pasamos los registros desordenados y sin umbral explícito para verificar el defecto de 15 m
    const sites = groupColocatedAntennasForMap([digi, orange, movistar]);

    expect(sites).toHaveLength(1);
    const site = sites[0];
    expect(site.isMultiOperator).toBe(true);
    expect(site.operators).toEqual(['movistar', 'orange', 'digi']);
    expect(site.iconKey).toBe('multi:movistar|orange|digi');
    expect(site.members.map((m) => m.op)).toEqual([
      'movistar',
      'orange',
      'digi',
    ]);
    expect(site.primary.id).toBe(movistar.id);
    expect(site.siteId).toBe(
      `site:${movistar.id}||${orange.id}||${digi.id}`,
    );
    expect(site.lat).toBeCloseTo(
      (movistar.lat + orange.lat + digi.lat) / 3,
      7,
    );
    expect(site.lon).toBeCloseTo(baseLon, 7);
  });

  it('groups distinct operators separated < 15 m (~14.5 m) in longitude at northern latitudes (~43.7° N) accurately', () => {
    const northLat = 43.7;
    const northLon = -7.85;
    // A 43.7° N, 0.00018° de longitud ≈ 14.47 m (< 15 m)
    const lonOffset = 0.00018;

    const orange: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - 1500101',
      gid: '1500101',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: northLat,
      lon: northLon,
      dir: 'Monte Faro',
      mun: 'Ortigueira',
      prov: 'A Coruña',
    };
    const vodafone: AntennaRecord = {
      id: 'VODAFONE ESPAÑA, S.A.U. - 1500102',
      gid: '1500102',
      op: 'vodafone',
      opRaw: 'VODAFONE ESPAÑA, S.A.U.',
      lat: northLat,
      lon: northLon + lonOffset,
      dir: 'Monte Faro',
      mun: 'Ortigueira',
      prov: 'A Coruña',
    };

    const distMeters =
      haversineDistanceKm(orange.lat, orange.lon, vodafone.lat, vodafone.lon) *
      1000;
    expect(distMeters).toBeGreaterThan(13.5);
    expect(distMeters).toBeLessThan(15);

    const sites = groupColocatedAntennasForMap([vodafone, orange]);
    expect(sites).toHaveLength(1);
    expect(sites[0].isMultiOperator).toBe(true);
    expect(sites[0].operators).toEqual(['orange', 'vodafone']);
  });

  it('keeps antennas of distinct operators at ~16.7 m (>= 15 m and < 30 m) as 2 separate individual entries under the 15 m default', () => {
    // 0.00015° de latitud ≈ 16.7 m (>= 15 m y < 30 m: antes se habrían unido bajo 30 m)
    const offset16_7m = 0.00015;

    const movistar: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809111',
      gid: '2809111',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Azotea Este',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const digi: AntennaRecord = {
      id: 'DS MOBILE NETWORKS, S.L. - 2809112',
      gid: '2809112',
      op: 'digi',
      opRaw: 'DS MOBILE NETWORKS, S.L.',
      lat: baseLat + offset16_7m,
      lon: baseLon,
      dir: 'Azotea Oeste',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    expect(MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS).toBe(15);

    const distMeters =
      haversineDistanceKm(movistar.lat, movistar.lon, digi.lat, digi.lon) *
      1000;
    expect(distMeters).toBeGreaterThanOrEqual(15);
    expect(distMeters).toBeLessThan(30);

    const sites = groupColocatedAntennasForMap([movistar, digi]);

    expect(sites).toHaveLength(2);
    expect(sites[0].isMultiOperator).toBe(false);
    expect(sites[0].operators).toEqual(['movistar']);
    expect(sites[0].iconKey).toBe('single:movistar');
    expect(sites[1].isMultiOperator).toBe(false);
    expect(sites[1].operators).toEqual(['digi']);
    expect(sites[1].iconKey).toBe('single:digi');

    // Contraste con la antigua regla de 30 m: bajo maxDistanceMeters = 30 sí se habrían fusionado
    const legacy30mSites = groupColocatedAntennasForMap([movistar, digi], 30);
    expect(legacy30mSites).toHaveLength(1);
    expect(legacy30mSites[0].isMultiOperator).toBe(true);
  });

  it('keeps antennas of distinct operators at >= 15 m (~37 m) as separate individual entries', () => {
    // 0.000333° de latitud ≈ 37.0 m (>= 15 m)
    const offset37m = 0.000333;

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
      lat: baseLat + offset37m,
      lon: baseLon,
      dir: 'Azotea Sur',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    const distMeters =
      haversineDistanceKm(movistar.lat, movistar.lon, digi.lat, digi.lon) *
      1000;
    expect(distMeters).toBeGreaterThanOrEqual(15);
    expect(distMeters).toBeGreaterThan(35);
    expect(distMeters).toBeLessThan(39);

    const sites = groupColocatedAntennasForMap([movistar, digi]);

    expect(sites).toHaveLength(2);
    expect(sites[0].isMultiOperator).toBe(false);
    expect(sites[0].operators).toEqual(['movistar']);
    expect(sites[1].isMultiOperator).toBe(false);
    expect(sites[1].operators).toEqual(['digi']);
  });

  it('fuses two Telefónica (movistar) antennas at the exact same coordinate (0 m) into 1 entry, while keeping distinct coordinates (~10 m, < 15 m) strictly separate', () => {
    const movSameSpotA: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809301',
      gid: '2809301',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Av. América, 10',
      mun: 'Madrid',
      prov: 'Madrid',
      bandas: ['800 MHz', '1800 MHz'],
      frecuencias: ['852.00 - 862.00', '1805.10 - 1825.10'],
    };
    const movSameSpotB: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809302',
      gid: '2809302',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Av. América, 10',
      mun: 'Madrid',
      prov: 'Madrid',
      bandas: ['3500 MHz'],
      frecuencias: ['3460.00 - 3600.00'],
    };

    const zeroMeterSites = groupColocatedAntennasForMap([
      movSameSpotA,
      movSameSpotB,
    ]);
    expect(zeroMeterSites).toHaveLength(1);
    expect(zeroMeterSites[0].isMultiOperator).toBe(false);
    expect(zeroMeterSites[0].operators).toEqual(['movistar']);
    expect(zeroMeterSites[0].iconKey).toBe('single:movistar');
    expect(zeroMeterSites[0].siteId).toBe(movSameSpotA.id);
    expect(zeroMeterSites[0].primary.mergedGids).toEqual(['2809301', '2809302']);
    expect(zeroMeterSites[0].primary.bandas).toEqual([
      '800 MHz',
      '1800 MHz',
      '3500 MHz',
    ]);
    expect(zeroMeterSites[0].memberIds).toEqual([
      movSameSpotA.id,
      movSameSpotB.id,
    ]);

    const mov10m: AntennaRecord = {
      ...movSameSpotB,
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809303',
      gid: '2809303',
      lat: baseLat + 0.00009, // ~10.0 m (< 15 m, distinta coordenada)
    };
    const dist10m =
      haversineDistanceKm(
        movSameSpotA.lat,
        movSameSpotA.lon,
        mov10m.lat,
        mov10m.lon,
      ) * 1000;
    expect(dist10m).toBeGreaterThan(9);
    expect(dist10m).toBeLessThan(11);
    expect(dist10m).toBeLessThan(15);

    const tenMeterSites = groupColocatedAntennasForMap([
      movSameSpotA,
      mov10m,
    ]);
    expect(tenMeterSites).toHaveLength(2);
    expect(tenMeterSites.every((s) => !s.isMultiOperator)).toBe(true);
    expect(tenMeterSites.map((s) => s.iconKey)).toEqual([
      'single:movistar',
      'single:movistar',
    ]);
  });

  it('in mixed sites (Movistar #1 at 0 m + Orange #1 at 2 m + Movistar #2 at 10 m from Orange #1), pairs Movistar #1 + Orange #1 and keeps Movistar #2 separate', () => {
    const mov1: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809501',
      gid: '2809501',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Paseo de Recoletos, 12',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const orange1: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - 2809502',
      gid: '2809502',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: baseLat + 0.000018, // ~2.0 m de Movistar #1
      lon: baseLon,
      dir: 'Paseo de Recoletos, 12',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const mov2: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809503',
      gid: '2809503',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat + 0.000018 + 0.00009, // ~10.0 m de Orange #1 y ~12.0 m de Movistar #1 (ambas < 15 m)
      lon: baseLon,
      dir: 'Paseo de Recoletos, 14',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    const dMov1Orange =
      haversineDistanceKm(mov1.lat, mov1.lon, orange1.lat, orange1.lon) * 1000;
    const dOrangeMov2 =
      haversineDistanceKm(orange1.lat, orange1.lon, mov2.lat, mov2.lon) * 1000;
    const dMov1Mov2 =
      haversineDistanceKm(mov1.lat, mov1.lon, mov2.lat, mov2.lon) * 1000;

    expect(dMov1Orange).toBeCloseTo(2, 0);
    expect(dOrangeMov2).toBeCloseTo(10, 0);
    expect(dMov1Mov2).toBeLessThan(15);

    // Probamos incluso pasando Movistar #2 primero en el array
    const sitesReverse = groupColocatedAntennasForMap([mov2, orange1, mov1]);
    const sitesForward = groupColocatedAntennasForMap([mov1, orange1, mov2]);

    for (const sites of [sitesReverse, sitesForward]) {
      expect(sites).toHaveLength(2);

      const sharedSite = sites.find((s) => s.isMultiOperator);
      const standaloneSite = sites.find((s) => !s.isMultiOperator);

      expect(sharedSite).toBeDefined();
      expect(standaloneSite).toBeDefined();

      expect(sharedSite?.operators).toEqual(['movistar', 'orange']);
      expect(sharedSite?.iconKey).toBe('multi:movistar|orange');
      expect(sharedSite?.members.map((m) => m.id)).toEqual([
        mov1.id,
        orange1.id,
      ]);
      // Jamás más de 1 antena de Movistar en el mismo MapSiteEntry
      expect(
        sharedSite?.members.filter((m) => m.op === 'movistar'),
      ).toHaveLength(1);

      expect(standaloneSite?.operators).toEqual(['movistar']);
      expect(standaloneSite?.iconKey).toBe('single:movistar');
      expect(standaloneSite?.primary.id).toBe(mov2.id);
      expect(standaloneSite?.members.map((m) => m.id)).toEqual([mov2.id]);
    }
  });

  it('prevents transitive chaining beyond 15 m via complete-linkage (e.g. 11.1 m + 12.2 m = 23.4 m)', () => {
    const movistar: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809601',
      gid: '2809601',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'C/ Serrano, 1',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const orange: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - 2809602',
      gid: '2809602',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: baseLat + 0.0001, // ~11.1 m de Movistar (< 15 m)
      lon: baseLon,
      dir: 'C/ Serrano, 3',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const digi: AntennaRecord = {
      id: 'DS MOBILE NETWORKS, S.L. - 2809603',
      gid: '2809603',
      op: 'digi',
      opRaw: 'DS MOBILE NETWORKS, S.L.',
      lat: baseLat + 0.00021, // ~23.4 m de Movistar (>= 15 m), pero ~12.2 m de Orange (< 15 m)
      lon: baseLon,
      dir: 'C/ Serrano, 5',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    const dMovOrange =
      haversineDistanceKm(movistar.lat, movistar.lon, orange.lat, orange.lon) *
      1000;
    const dOrangeDigi =
      haversineDistanceKm(orange.lat, orange.lon, digi.lat, digi.lon) * 1000;
    const dMovDigi =
      haversineDistanceKm(movistar.lat, movistar.lon, digi.lat, digi.lon) *
      1000;

    expect(dMovOrange).toBeLessThan(15);
    expect(dOrangeDigi).toBeLessThan(15);
    expect(dMovDigi).toBeGreaterThanOrEqual(15);

    const sites = groupColocatedAntennasForMap([movistar, orange, digi]);
    expect(sites).toHaveLength(2);
    expect(sites[0].isMultiOperator).toBe(true);
    expect(sites[0].operators).toEqual(['movistar', 'orange']);
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

    const combined = groupColocatedAntennasForMap([movistar, orange]);
    expect(combined).toHaveLength(1);
    expect(combined[0].isMultiOperator).toBe(true);

    // Al filtrar solo Orange en el mapa, pasa a marcador individual de Orange
    const onlyOrange = groupColocatedAntennasForMap([orange]);
    expect(onlyOrange).toHaveLength(1);
    expect(onlyOrange[0].isMultiOperator).toBe(false);
    expect(onlyOrange[0].operators).toEqual(['orange']);
    expect(onlyOrange[0].iconKey).toBe('single:orange');
  });

  it('defensively fuses residual repeated Vodafone records at ~25 m and ~32 m (< 35 m) into 1 entry while keeping ~38 m (>= 35 m) separate', () => {
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
      lat: 41.387 + 0.000225, // ~25.0 m (>= 15 m y < 35 m)
      lon: 2.17,
      dir: 'Diagonal, 100',
      mun: 'Barcelona',
      prov: 'Barcelona',
    };

    const distMeters =
      haversineDistanceKm(vodA.lat, vodA.lon, vodB.lat, vodB.lon) * 1000;
    expect(distMeters).toBeGreaterThan(24);
    expect(distMeters).toBeLessThan(26);

    const vodSites = groupColocatedAntennasForMap([vodB, vodA]);
    expect(vodSites).toHaveLength(1);
    expect(vodSites[0].isMultiOperator).toBe(false);
    expect(vodSites[0].operators).toEqual(['vodafone']);
    expect(vodSites[0].primary.mergedGids).toEqual(['2809401', '2809402']);
    expect(vodSites[0].memberIds).toEqual([vodB.id, vodA.id]);

    // Incluso entre 15 m y 35 m (~32.0 m), el pase defensivo de Vodafone sigue fusionando duplicados residuales (< 35 m)
    const vod32m: AntennaRecord = {
      ...vodB,
      id: 'VODAFONE ESPAÑA, S.A.U. - 2809404',
      gid: '2809404',
      lat: 41.387 + 0.000288, // ~32.0 m (>= 15 m y < 35 m)
    };
    const dist32Meters =
      haversineDistanceKm(vodA.lat, vodA.lon, vod32m.lat, vod32m.lon) * 1000;
    expect(dist32Meters).toBeGreaterThanOrEqual(15);
    expect(dist32Meters).toBeLessThan(35);

    const vod32Sites = groupColocatedAntennasForMap([vod32m, vodA]);
    expect(vod32Sites).toHaveLength(1);
    expect(vod32Sites[0].isMultiOperator).toBe(false);
    expect(vod32Sites[0].operators).toEqual(['vodafone']);
    expect(vod32Sites[0].primary.mergedGids).toEqual(['2809401', '2809404']);
    expect(vod32Sites[0].memberIds).toEqual([vod32m.id, vodA.id]);

    const vodFar: AntennaRecord = {
      ...vodB,
      id: 'VODAFONE ESPAÑA, S.A.U. - 2809403',
      gid: '2809403',
      lat: 41.387 + 0.000342, // ~38.0 m (>= 35 m)
    };
    const dist38Meters =
      haversineDistanceKm(vodA.lat, vodA.lon, vodFar.lat, vodFar.lon) * 1000;
    expect(dist38Meters).toBeGreaterThanOrEqual(35);

    const separateVodSites = groupColocatedAntennasForMap([vodA, vodFar]);
    expect(separateVodSites).toHaveLength(2);
  });

  it('fuses same-operator exact-coordinate duplicates (Orange, Telefónica, DIGI, Otros same opRaw) even in multi-op sites while keeping non-exact (< 1 m / 10 m) and distinct Otros separate', () => {
    // 1) Dos Orange en la misma coordenada exacta + una 3.ª Orange a ~0.33 m (distinta coord)
    const oraA: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - GALR0044A',
      gid: 'GALR0044A',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: 43.353278,
      lon: -8.423861,
      dir: 'CL COPERNICO, 6',
      mun: 'A CORUÑA',
      prov: 'A CORUÑA',
      bandas: ['700 MHz', '900 MHz'],
      frecuencias: ['758.00 - 768.00', '925.10 - 935.10'],
    };
    const oraC: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - GALR0044C',
      gid: 'GALR0044C',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: 43.353278,
      lon: -8.423861,
      dir: 'CL COPÉRNICO, 6',
      mun: 'A CORUÑA',
      prov: 'A CORUÑA',
      bandas: ['800 MHz', '900 MHz'],
      frecuencias: ['832.00 - 842.00', '925.10 - 935.10'],
    };
    const oraNearDistinct: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - GALR0044Z',
      gid: 'GALR0044Z',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: 43.353281, // ~0.33 m distinta coordenada
      lon: -8.423861,
      dir: 'CL COPERNICO, 6',
      mun: 'A CORUÑA',
      prov: 'A CORUÑA',
      bandas: ['1800 MHz'],
      frecuencias: ['1859.90 - 1879.90'],
    };

    const orangeSites = groupColocatedAntennasForMap([oraC, oraA, oraNearDistinct]);
    expect(orangeSites).toHaveLength(2);
    const fusedOrange = orangeSites.find((s) => s.primary.gid === 'GALR0044A');
    expect(fusedOrange).toBeDefined();
    expect(fusedOrange?.primary.mergedGids).toEqual(['GALR0044A', 'GALR0044C']);
    expect(fusedOrange?.primary.bandas).toEqual(['700 MHz', '800 MHz', '900 MHz']);
    expect(fusedOrange?.memberIds).toEqual([oraC.id, oraA.id]);
    expect(orangeSites.some((s) => s.primary.gid === 'GALR0044Z')).toBe(true);

    // Incluso con maxDistanceMeters = 0 (sin agrupación multioperador), misma coord exacta sigue fusionando
    const zeroMaxSites = groupColocatedAntennasForMap([oraC, oraA], 0);
    expect(zeroMaxSites).toHaveLength(1);
    expect(zeroMaxSites[0].primary.mergedGids).toEqual(['GALR0044A', 'GALR0044C']);

    // 2) Emplazamiento mixto: 2 Telefónica exactas a 0 m + 2 Orange exactas a ~2 m + 3.ª Telefónica a ~10 m
    const movA: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 0600001',
      gid: '0600001',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Torre Mixta 1',
      mun: 'Madrid',
      prov: 'Madrid',
      bandas: ['700 MHz', '800 MHz'],
    };
    const movB: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 600001',
      gid: '600001',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'Torre Mixta 1',
      mun: 'Madrid',
      prov: 'Madrid',
      bandas: ['3500 MHz'],
    };
    const oraMixA: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - MADR1001A',
      gid: 'MADR1001A',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: baseLat + 0.000018, // ~2 m
      lon: baseLon,
      dir: 'Torre Mixta 1',
      mun: 'Madrid',
      prov: 'Madrid',
      bandas: ['800 MHz'],
    };
    const oraMixB: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - MADR1001B',
      gid: 'MADR1001B',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: baseLat + 0.000018, // exacta a oraMixA
      lon: baseLon,
      dir: 'Torre Mixta 1',
      mun: 'Madrid',
      prov: 'Madrid',
      bandas: ['3500 MHz'],
    };
    const movSeparate: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809999',
      gid: '2809999',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat + 0.00009, // ~10 m (distinta coord)
      lon: baseLon,
      dir: 'Torre Mixta 2',
      mun: 'Madrid',
      prov: 'Madrid',
      bandas: ['1800 MHz'],
    };

    const mixedSites = groupColocatedAntennasForMap([
      movB,
      oraMixB,
      movSeparate,
      oraMixA,
      movA,
    ]);
    expect(mixedSites).toHaveLength(2);
    const shared = mixedSites.find((s) => s.isMultiOperator);
    const alone = mixedSites.find((s) => !s.isMultiOperator);
    expect(shared?.operators).toEqual(['movistar', 'orange']);
    expect(shared?.members).toHaveLength(2);
    expect(shared?.members[0].gid).toBe('0600001');
    expect(shared?.members[0].mergedGids).toEqual(['0600001', '600001']);
    expect(shared?.members[0].bandas).toEqual(['700 MHz', '800 MHz', '3500 MHz']);
    expect(shared?.members[1].gid).toBe('MADR1001A');
    expect(shared?.members[1].mergedGids).toEqual(['MADR1001A', 'MADR1001B']);
    expect(shared?.members[1].bandas).toEqual(['800 MHz', '3500 MHz']);
    expect(new Set(shared?.memberIds)).toEqual(
      new Set([movA.id, movB.id, oraMixA.id, oraMixB.id]),
    );
    expect(alone?.primary.id).toBe(movSeparate.id);

    // 3) Otros: misma razón social en misma coord exacta fusiona; distinta razón social queda separada
    const otrosA1: AntennaRecord = {
      id: 'RETEVISION MOVIL SA - R1',
      gid: 'R1',
      op: 'otros',
      opRaw: 'RETEVISION MOVIL SA',
      lat: 41.4,
      lon: 2.15,
      dir: 'Torre',
      mun: 'Barcelona',
      prov: 'Barcelona',
      bandas: ['900 MHz'],
    };
    const otrosA2: AntennaRecord = {
      id: 'RETEVISION MOVIL SA - R2',
      gid: 'R2',
      op: 'otros',
      opRaw: 'RETEVISIÓN MOVIL SA',
      lat: 41.4,
      lon: 2.15,
      dir: 'Torre',
      mun: 'Barcelona',
      prov: 'Barcelona',
      bandas: ['1800 MHz'],
    };
    const otrosB: AntennaRecord = {
      id: 'TELEAST DIGITAL, SL - T1',
      gid: 'T1',
      op: 'otros',
      opRaw: 'TELEAST DIGITAL, SL',
      lat: 41.4,
      lon: 2.15,
      dir: 'Torre',
      mun: 'Barcelona',
      prov: 'Barcelona',
      bandas: ['2600 MHz'],
    };
    const otrosSites = groupColocatedAntennasForMap([otrosA1, otrosA2, otrosB]);
    expect(otrosSites).toHaveLength(2);
    expect(otrosSites.find((s) => s.primary.gid === 'R1')?.primary.mergedGids).toEqual([
      'R1',
      'R2',
    ]);
    expect(otrosSites.find((s) => s.primary.gid === 'T1')?.primary.mergedGids).toBeUndefined();
  });

  it('does NOT fuse two Telefónica (Movistar) antennas at the exact same coordinate when each has band N78, while still fusing Orange N78 duplicates', () => {
    const movN78A: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2811896',
      gid: '2811896',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: 40.419803,
      lon: -3.706108,
      dir: 'PZ Callao, 00001',
      mun: 'MADRID',
      prov: 'MADRID',
      bandas: ['2600 MHz', '3500 MHz'],
      frecuencias: ['2620.00 - 2640.00', '3460.00 - 3600.00'],
      concesiones: [
        { ref: 'M M -2503308', freq: '2620.00 - 2640.00' },
        { ref: 'M M -2503307', freq: '3460.00 - 3600.00' },
      ],
    };
    const movN78B: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2811897',
      gid: '2811897',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: 40.419803,
      lon: -3.706108,
      dir: 'CL Preciados, 00032',
      mun: 'MADRID',
      prov: 'MADRID',
      bandas: ['2600 MHz', '3500 MHz'],
      frecuencias: ['2620.00 - 2640.00', '3460.00 - 3600.00'],
      concesiones: [
        { ref: 'M M -2600525', freq: '2620.00 - 2640.00' },
        { ref: 'M M -2600524', freq: '3460.00 - 3600.00' },
      ],
    };

    // 1) Sin otros operadores: permanecen como 2 MapSiteEntry independientes (tanto con 15 m como con 0 m)
    const separateDefault = groupColocatedAntennasForMap([movN78A, movN78B]);
    expect(separateDefault).toHaveLength(2);
    expect(separateDefault.map((s) => s.primary.gid).sort()).toEqual([
      '2811896',
      '2811897',
    ]);
    expect(separateDefault.every((s) => s.primary.mergedGids === undefined)).toBe(
      true,
    );

    const separateZero = groupColocatedAntennasForMap([movN78A, movN78B], 0);
    expect(separateZero).toHaveLength(2);

    // 2) Con un tercer operador (Orange) en la misma coordenada exacta:
    //    la regla de Telefónica en clusterMultiOperatorSitesByCompleteLinkage impide unir las 2 Movistar transitivamente
    const orangeAtSame: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - MAD9999A',
      gid: 'MAD9999A',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: 40.419803,
      lon: -3.706108,
      dir: 'PZ Callao, 1',
      mun: 'MADRID',
      prov: 'MADRID',
      bandas: ['3500 MHz'],
      frecuencias: ['3600.00 - 3700.00'],
    };
    const orangeDupN78: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - MAD9999B',
      gid: 'MAD9999B',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: 40.419803,
      lon: -3.706108,
      dir: 'PZ Callao, 1',
      mun: 'MADRID',
      prov: 'MADRID',
      bandas: ['3500 MHz'],
      frecuencias: ['3600.00 - 3700.00'],
    };

    const withOrange = groupColocatedAntennasForMap([
      movN78A,
      movN78B,
      orangeAtSame,
      orangeDupN78,
    ]);
    // Las 2 Orange con N78 SÍ se fusionan entre sí en 1 Orange, que se agrupa con 1 Movistar; la 2.ª Movistar queda aparte
    expect(withOrange).toHaveLength(2);
    const multiSite = withOrange.find((s) => s.isMultiOperator);
    const singleMovSite = withOrange.find((s) => !s.isMultiOperator);
    expect(multiSite?.operators).toEqual(['movistar', 'orange']);
    expect(multiSite?.members.filter((m) => m.op === 'movistar')).toHaveLength(1);
    const orangeMember = multiSite?.members.find((m) => m.op === 'orange');
    expect(orangeMember?.mergedGids).toEqual(['MAD9999A', 'MAD9999B']);
    expect(singleMovSite?.operators).toEqual(['movistar']);
    expect(singleMovSite?.primary.mergedGids).toBeUndefined();
  });
});


