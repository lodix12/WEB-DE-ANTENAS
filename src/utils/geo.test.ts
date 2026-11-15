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

  it('groups antennas of distinct operators within < 35 m (~28 m) by default into 1 multi-operator MapSiteEntry in canonical OPERATOR_ORDER', () => {
    // ~14 m y ~28 m en latitud (todas las parejas distan < 35 m: 14 m, 14 m y 28 m)
    const offset14m = 0.000126;
    const offset28m = 0.000252;

    const digi: AntennaRecord = {
      id: 'DS MOBILE NETWORKS, S.L. - 2809003',
      gid: '2809003',
      op: 'digi',
      opRaw: 'DS MOBILE NETWORKS, S.L.',
      lat: baseLat + offset28m,
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
      lat: baseLat + offset14m,
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
    expect(maxPairwiseDistMeters).toBeGreaterThan(27);
    expect(maxPairwiseDistMeters).toBeLessThan(35);

    // Pasamos los registros desordenados y sin umbral explícito para verificar el defecto de 35 m
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

  it('groups distinct operators separated ~30 m in longitude at northern latitudes (~43.7° N) accurately', () => {
    const northLat = 43.7;
    const northLon = -7.85;
    // A 43.7° N, 0.00037° de longitud ≈ 29.8 m (< 35 m)
    const lonOffset30m = 0.00037;

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
      lon: northLon + lonOffset30m,
      dir: 'Monte Faro',
      mun: 'Ortigueira',
      prov: 'A Coruña',
    };

    const distMeters =
      haversineDistanceKm(orange.lat, orange.lon, vodafone.lat, vodafone.lon) *
      1000;
    expect(distMeters).toBeGreaterThan(28);
    expect(distMeters).toBeLessThan(35);

    const sites = groupColocatedAntennasForMap([vodafone, orange]);
    expect(sites).toHaveLength(1);
    expect(sites[0].isMultiOperator).toBe(true);
    expect(sites[0].operators).toEqual(['orange', 'vodafone']);
  });

  it('keeps antennas of distinct operators at >= 35 m (~37 m) as separate individual entries', () => {
    // 0.000333° de latitud ≈ 37.0 m (>= 35 m)
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
    expect(distMeters).toBeGreaterThanOrEqual(35);
    expect(distMeters).toBeLessThan(39);

    const sites = groupColocatedAntennasForMap([movistar, digi]);

    expect(sites).toHaveLength(2);
    expect(sites[0].isMultiOperator).toBe(false);
    expect(sites[0].operators).toEqual(['movistar']);
    expect(sites[1].isMultiOperator).toBe(false);
    expect(sites[1].operators).toEqual(['digi']);
  });

  it('NEVER fuses two Telefónica (movistar) antennas with each other, whether at 0 m or 20 m', () => {
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
    };

    const zeroMeterSites = groupColocatedAntennasForMap([
      movSameSpotA,
      movSameSpotB,
    ]);
    expect(zeroMeterSites).toHaveLength(2);
    expect(zeroMeterSites.every((s) => !s.isMultiOperator)).toBe(true);
    expect(zeroMeterSites.map((s) => s.siteId)).toEqual([
      movSameSpotA.id,
      movSameSpotB.id,
    ]);

    const mov20m: AntennaRecord = {
      ...movSameSpotB,
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2809303',
      gid: '2809303',
      lat: baseLat + 0.00018, // ~20.0 m (< 35 m)
    };
    const dist20m =
      haversineDistanceKm(
        movSameSpotA.lat,
        movSameSpotA.lon,
        mov20m.lat,
        mov20m.lon,
      ) * 1000;
    expect(dist20m).toBeGreaterThan(19);
    expect(dist20m).toBeLessThan(21);

    const twentyMeterSites = groupColocatedAntennasForMap([
      movSameSpotA,
      mov20m,
    ]);
    expect(twentyMeterSites).toHaveLength(2);
    expect(twentyMeterSites.every((s) => !s.isMultiOperator)).toBe(true);
    expect(twentyMeterSites.map((s) => s.iconKey)).toEqual([
      'single:movistar',
      'single:movistar',
    ]);
  });

  it('in mixed sites (Movistar #1 at 0 m + Orange #1 at 2 m + Movistar #2 at 20 m from Orange #1), pairs Movistar #1 + Orange #1 and keeps Movistar #2 separate', () => {
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
      lat: baseLat + 0.000018 + 0.00018, // ~20.0 m de Orange #1 y ~22.0 m de Movistar #1 (ambas < 35 m)
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
    expect(dOrangeMov2).toBeCloseTo(20, 0);
    expect(dMov1Mov2).toBeLessThan(35);

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

  it('prevents transitive chaining beyond 35 m via complete-linkage (e.g. 26 m + 30 m = 56 m)', () => {
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
      lat: baseLat + 0.000234, // ~26 m (< 35 m)
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
      lat: baseLat + 0.000504, // ~56 m de Movistar (>= 35 m), pero ~30 m de Orange (< 35 m)
      lon: baseLon,
      dir: 'C/ Serrano, 5',
      mun: 'Madrid',
      prov: 'Madrid',
    };

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

  it('defensively fuses residual repeated Vodafone records at 25 m (< 35 m) into 1 entry while keeping >= 35 m separate', () => {
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
      lat: 41.387 + 0.000225, // ~25.0 m (< 35 m)
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

    const vodFar: AntennaRecord = {
      ...vodB,
      id: 'VODAFONE ESPAÑA, S.A.U. - 2809403',
      gid: '2809403',
      lat: 41.387 + 0.000342, // ~38.0 m (>= 35 m)
    };
    const separateVodSites = groupColocatedAntennasForMap([vodA, vodFar]);
    expect(separateVodSites).toHaveLength(2);
  });
});

