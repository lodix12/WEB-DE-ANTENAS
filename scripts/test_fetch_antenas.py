#!/usr/bin/env python3
"""Suite de pruebas unitarias para `scripts/fetch_antenas.py`."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import fetch_antenas as fa  # noqa: E402


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(round(seconds, 6))
        self.now += seconds


class FetchAntenasUnitTests(unittest.TestCase):
    def test_decode_iso_8859_1_preserves_spanish_characters(self) -> None:
        sample = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "TELEFÓNICA MÓVILES ESPAÑA, S.A.U. - 1500238",
                    "geometry": {"type": "Point", "coordinates": [-8.401234, 43.362345]},
                    "properties": {
                        "Gis_ID": "1500238",
                        "Gis_Latitud": "43.362345",
                        "Gis_Longitud": "-8.401234",
                        "Gis_Codigo": "TELEFÓNICA MÓVILES ESPAÑA, S.A.U. - 1500238",
                        "Dirección": "CL NUESTRA SEÑORA DE FÁTIMA, 33. CORUÑA (A), CORUÑA (A)",
                    },
                }
            ],
        }
        latin1_bytes = json.dumps(sample, ensure_ascii=False).encode("iso-8859-1")
        features = fa.decode_infoantenas_payload(latin1_bytes)
        self.assertEqual(len(features), 1)
        rec = fa.parse_feature(features[0])
        self.assertIsNotNone(rec)
        assert rec is not None
        self.assertEqual(rec["op"], "movistar")
        self.assertEqual(rec["opRaw"], "TELEFÓNICA MÓVILES ESPAÑA, S.A.U.")
        self.assertEqual(rec["dir"], "CL NUESTRA SEÑORA DE FÁTIMA, 33")
        self.assertEqual(rec["mun"], "CORUÑA (A)")
        self.assertEqual(rec["prov"], "A CORUÑA")

        # Gzipped Latin-1 payload & empty payloads
        gz_bytes = gzip.compress(latin1_bytes)
        self.assertEqual(len(fa.decode_infoantenas_payload(gz_bytes)), 1)
        self.assertEqual(fa.decode_infoantenas_payload(b"{}"), [])
        self.assertEqual(fa.decode_infoantenas_payload(b""), [])

    def test_operator_classification_all_groups(self) -> None:
        cases = [
            ("TELEFONICA MOVILES ESPAÑA, S.A.U.", "movistar"),
            ("MOVISTAR INFRAESTRUCTURAS", "movistar"),
            ("ORANGE ESPAGNE, S.A.U.", "orange"),
            ("VODAFONE ESPAÑA, S.A.U.", "vodafone"),
            ("XFERA MOVILES, S.A.U.", "masmovil"),
            ("GRUPO MÁSMÓVIL TELECOM", "masmovil"),
            ("YOIGO RED", "masmovil"),
            ("EUSKALTEL, S.A.", "masmovil"),
            ("R CABLE Y TELECOMUNICACIONES GALICIA, S.A.", "masmovil"),
            ("TELECABLE DE ASTURIAS, S.A.", "masmovil"),
            ("DS MOBILE NETWORKS, S.L.", "digi"),
            ("DIGI SPAIN TELECOM, S.L.U.", "digi"),
            ("TELEAST DIGITAL, SL", "otros"),
            ("TRADIA TELECOM, S.A.", "otros"),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(fa.classify_operator(raw), expected)

    def test_parse_direccion_with_dots_commas_and_ine_fallback(self) -> None:
        self.assertEqual(len(fa.INE_PROVINCES), 52)
        for code_num in range(1, 53):
            self.assertIn(f"{code_num:02d}", fa.INE_PROVINCES)

        # Calle con punto numérico y coma S/N
        d1, m1, p1 = fa.parse_direccion("MPG 20.304, S/N. MADRID, MADRID", gid="2809999")
        self.assertEqual((d1, m1, p1), ("MPG 20.304, S/N", "MADRID", "MADRID"))

        # Calle con múltiples comas
        d2, m2, p2 = fa.parse_direccion(
            "VP CALLE MANACOR, 4, 4. PALMA, ILLES BALEARS", gid="0700004"
        )
        self.assertEqual((d2, m2, p2), ("VP CALLE MANACOR, 4, 4", "PALMA", "ILLES BALEARS"))

        # Provincias bilingües o con artículo entre paréntesis
        _, _, p_las_palmas = fa.parse_direccion(
            "CL LEON Y CASTILLO, 244. PALMAS DE GRAN CANARIA (LAS), PALMAS (LAS)",
            gid="CANR0012A",
        )
        self.assertEqual(p_las_palmas, "LAS PALMAS")

        _, _, p_alava = fa.parse_direccion(
            "CL FRANCIA, 32. VITORIA-GASTEIZ, ARABA/ÁLAVA", gid="0100253"
        )
        self.assertEqual(p_alava, "ÁLAVA")

        # Dirección truncada sin municipio/provincia -> no debe tomar "14" como provincia; usa INE 41 (SEVILLA)
        d3, m3, p3 = fa.parse_direccion("CL MAYOR, 14", gid="4100123")
        self.assertEqual((d3, m3, p3), ("CL MAYOR, 14", "", "SEVILLA"))

        # Dirección vacía con GID alfanumérico de Ceuta / Canarias
        self.assertEqual(
            fa.parse_direccion("", gid="CYMR1001F", lat=35.889, lon=-5.316)[2],
            "CEUTA",
        )
        self.assertEqual(
            fa.parse_direccion("", gid="CANR9999Z", lat=28.463, lon=-16.251)[2],
            "SANTA CRUZ DE TENERIFE",
        )

    def test_grid_covers_all_spanish_borders_and_archipelagos(self) -> None:
        boxes = fa.build_initial_grid("all")
        self.assertGreaterEqual(len(boxes), 55)
        self.assertLessEqual(len(boxes), 80)

        must_cover_points = {
            "Estaca de Bares (Galicia N)": (-7.679, 43.789),
            "Cabo Fisterra (Galicia O)": (-9.272, 42.882),
            "A Guarda (Pontevedra SO)": (-8.874, 41.901),
            "Lobios / Xurés (Ourense S)": (-8.106, 41.835),
            "Fuentes de Oñoro (Salamanca O)": (-6.813, 40.589),
            "Olivenza (Badajoz O)": (-7.100, 38.685),
            "Ayamonte (Huelva SO)": (-7.406, 37.214),
            "Tarifa (Cádiz S)": (-5.606, 36.013),
            "Ceuta": (-5.316, 35.889),
            "Melilla": (-2.938, 35.292),
            "Islas Chafarinas": (-2.431, 35.181),
            "Isla de Alborán": (-3.034, 35.939),
            "Cabo de Gata (Almería SE)": (-2.192, 36.722),
            "Cabo de la Nao (Alicante E)": (0.233, 38.732),
            "Formentera (Baleares S)": (1.428, 38.695),
            "Palma (Mallorca)": (2.650, 39.570),
            "Maó (Menorca E)": (4.265, 39.888),
            "Cap de Creus (Girona E)": (3.316, 42.319),
            "Llívia (Girona Pirineos)": (1.981, 42.464),
            "Val d'Aran (Lleida N)": (0.796, 42.704),
            "Hondarribia (Gipuzkoa NE)": (-1.791, 43.362),
            "El Hierro (Canarias SO)": (-18.010, 27.740),
            "La Palma (Canarias NO)": (-17.850, 28.680),
            "Santa Cruz de Tenerife": (-16.252, 28.464),
            "Las Palmas de Gran Canaria": (-15.413, 28.100),
            "La Graciosa / Lanzarote (Canarias NE)": (-13.505, 29.252),
            "Madrid": (-3.704, 40.417),
            "Barcelona": (2.173, 41.385),
        }

        for name, (lon, lat) in must_cover_points.items():
            covered = any(
                b[0] <= lon <= b[2] and b[1] <= lat <= b[3] for b in boxes
            )
            self.assertTrue(covered, f"Punto español sin cobertura en rejilla: {name} ({lon}, {lat})")

    def test_quadtree_subdivision_dedup_rate_limit_retries_and_checkpoint(self) -> None:
        clock = FakeClock()
        attempts_on_ne = 0

        def make_fake_feature(idx: int, lon: float, lat: float) -> dict:
            gid = f"28{idx:05d}"
            code = f"VODAFONE ESPAÑA, S.A.U. - {gid}"
            return {
                "type": "Feature",
                "id": code,
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "Gis_ID": gid,
                    "Gis_Latitud": f"{lat:.6f}",
                    "Gis_Longitud": f"{lon:.6f}",
                    "Gis_Codigo": code,
                    "Dirección": f"CL ALCALÁ, {idx}. MADRID, MADRID",
                },
            }

        # La primera celda de `sample` devuelve 1000 -> subdivide en 4 cuadrantes.
        # Cada cuadrante devuelve 3 estaciones (con la #0 duplicada en todos los cuadrantes).
        sample_boxes = fa.build_initial_grid("sample")
        first_root = sample_boxes[0]

        def fake_fetch(bbox: fa.BBox, zoom: int) -> list[dict]:
            nonlocal attempts_on_ne
            self.assertEqual(zoom, 7)
            if bbox == first_root:
                return [make_fake_feature(i, -3.700, 40.415) for i in range(1000)]

            quadrants = fa.subdivide_bbox(first_root)
            if bbox == quadrants[1] and attempts_on_ne < 2:
                attempts_on_ne += 1
                raise urllib.error.URLError("transient timeout")

            base = int(abs(round(bbox[0] * 1000))) * 10
            return [
                make_fake_feature(0, -3.700, 40.415),  # Duplicada globalmente
                make_fake_feature(base + 1001, (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2),
            ]

        with tempfile.TemporaryDirectory() as tmpdir:
            ckpt_path = Path(tmpdir) / "crawl.checkpoint.json"
            out_path = Path(tmpdir) / "antenas.json"

            crawler = fa.InfoantenasCrawler(
                delay_seconds=1.0,
                checkpoint_path=ckpt_path,
                checkpoint_every=2,
                fetch_fn=fake_fetch,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            dataset = crawler.crawl(region="sample")
            size_bytes = fa.write_compact_dataset(dataset, out_path)

            # 1 raíz Madrid (1000 -> subdivide) + 4 hijos Madrid (con 2 reintentos en NE) + 1 raíz Barcelona = 8 llamadas HTTP
            self.assertEqual(crawler.subdivided_boxes, 1)
            self.assertEqual(crawler.grid_boxes_visited, 6)
            self.assertEqual(crawler.requests_count, 8)
            self.assertIn(2.0, clock.sleeps)
            self.assertIn(4.0, clock.sleeps)
            self.assertTrue(any(abs(s - 1.0) < 1e-6 for s in clock.sleeps))

            # Verificar JSON compacto y esquema AntenasDataset
            self.assertGreater(size_bytes, 100)
            loaded = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(
                set(loaded.keys()),
                {"updatedAt", "sourceUrl", "total", "crawlStats", "operators", "provinces", "antenas"},
            )
            self.assertEqual(loaded["total"], len(loaded["antenas"]))
            self.assertTrue(loaded["crawlStats"]["isPartialSeed"])
            self.assertEqual(set(loaded["operators"].keys()), set(fa.OPERATOR_ORDER))
            self.assertEqual(loaded["provinces"][0]["provincia"], "MADRID")

            # Verificar reanudación desde checkpoint sin repetir peticiones HTTP
            resumed = fa.InfoantenasCrawler(
                delay_seconds=1.0,
                checkpoint_path=ckpt_path,
                fetch_fn=lambda *_: (_ for _ in ()).throw(AssertionError("No debe hacer HTTP al reanudar")),
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            resumed_dataset = resumed.crawl(region="sample")
            self.assertEqual(resumed_dataset["total"], dataset["total"])

    def test_vodafone_duplicates_under_35m_fused_and_counted_as_one(self) -> None:
        self.assertEqual(fa.DEFAULT_VODAFONE_FUSION_M, 35.0)
        # 3 declaraciones de Vodafone en A Coruña a < 35 m (~0 m y ~28.0 m):
        # "00144693" (con 2 ceros), "0144693" (con 1 cero a ~28 m y dirección completa),
        # "144693" (canónico sin ceros, sin dir para comprobar relleno de campos).
        lat_base, lon_base = 42.897686, -8.704622
        lat_28m = 42.897938  # ~28.02 m al norte
        dist_28m = fa.haversine_m(lat_base, lon_base, lat_28m, lon_base)
        self.assertGreater(dist_28m, 25.0)
        self.assertLess(dist_28m, 35.0)

        records = [
            {
                "id": "VODAFONE ESPAÑA, S.A. - 00144693",
                "gid": "00144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.",
                "lat": lat_base,
                "lon": lon_base,
                "dir": "LG PG 78 PARC 9000 - ARUFE, S/N",
                "mun": "AMES",
                "prov": "A CORUÑA",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A. - 0144693",
                "gid": "0144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.",
                "lat": lat_28m,
                "lon": lon_base,
                "dir": "LG PG 78 PARC 9000 - ARUFE, S/N",
                "mun": "AMES",
                "prov": "A CORUÑA",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A.U. - 144693",
                "gid": "144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": lat_base,
                "lon": lon_base,
                "dir": "",
                "mun": "AMES",
                "prov": "A CORUÑA",
            },
        ]

        crawl_stats = {
            "requestsCount": 1,
            "durationSeconds": 1.0,
            "gridBoxesVisited": 1,
            "subdividedBoxes": 0,
            "zoomParam": 7,
            "delaySeconds": 1.0,
        }
        dataset = fa.build_dataset(records, crawl_stats=crawl_stats, updated_at="2026-11-15T18:51:08Z")

        self.assertEqual(dataset["crawlStats"]["vodafoneFusedDuplicates"], 2)
        self.assertEqual(dataset["total"], 1)
        self.assertEqual(len(dataset["antenas"]), 1)
        self.assertEqual(dataset["operators"]["vodafone"]["count"], 1)
        self.assertEqual(len(dataset["provinces"]), 1)
        self.assertEqual(dataset["provinces"][0]["provincia"], "A CORUÑA")
        self.assertEqual(dataset["provinces"][0]["count"], 1)
        self.assertEqual(dataset["provinces"][0]["byOperator"], {"vodafone": 1})

        fused_ant = dataset["antenas"][0]
        self.assertEqual(fused_ant["gid"], "144693")
        self.assertEqual(fused_ant["lat"], lat_base)
        self.assertEqual(fused_ant["lon"], lon_base)
        self.assertEqual(fused_ant["dir"], "LG PG 78 PARC 9000 - ARUFE, S/N")
        self.assertEqual(fused_ant["mergedGids"], ["144693", "0144693", "00144693"])

        # Verificación de malla espacial este-oeste en el extremo norte de España (lat = 43.8°):
        # 0.00042° de longitud equivalen a ~33.7 m (< 35 m) y no deben perderse entre celdas.
        north_lat = 43.800000
        lon_w = -7.680100
        lon_e = -7.679680  # ~33.7 m al este
        ew_dist = fa.haversine_m(north_lat, lon_w, north_lat, lon_e)
        self.assertGreater(ew_dist, 30.0)
        self.assertLess(ew_dist, 35.0)
        ew_fused, ew_dups = fa.fuse_vodafone_duplicates(
            [
                {
                    "id": "VODAFONE ESPAÑA, S.A.U. - 150901",
                    "gid": "150901",
                    "op": "vodafone",
                    "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                    "lat": north_lat,
                    "lon": lon_w,
                    "dir": "CABO ESTACA DE BARES",
                    "mun": "MAÑÓN",
                    "prov": "A CORUÑA",
                },
                {
                    "id": "VODAFONE ESPAÑA, S.A. - 0150901",
                    "gid": "0150901",
                    "op": "vodafone",
                    "opRaw": "VODAFONE ESPAÑA, S.A.",
                    "lat": north_lat,
                    "lon": lon_e,
                    "dir": "CABO ESTACA DE BARES",
                    "mun": "MAÑÓN",
                    "prov": "A CORUÑA",
                },
            ]
        )
        self.assertEqual(ew_dups, 1)
        self.assertEqual(len(ew_fused), 1)
        self.assertEqual(ew_fused[0]["mergedGids"], ["150901", "0150901"])

        # Idempotencia al volver a pasar el dataset ya fusionado por build_dataset
        rebuilt = fa.build_dataset(
            dataset["antenas"],
            crawl_stats=dataset["crawlStats"],
            updated_at=dataset["updatedAt"],
        )
        self.assertEqual(rebuilt["total"], 1)
        self.assertEqual(rebuilt["crawlStats"]["vodafoneFusedDuplicates"], 2)
        self.assertEqual(rebuilt["antenas"][0]["mergedGids"], ["144693", "0144693", "00144693"])

    def test_vodafone_stations_at_35m_or_more_are_not_fused(self) -> None:
        # 0.000342 grados de latitud son ~38.03 metros (>= 35 m)
        lat1, lon1 = 40.416800, -3.703800
        lat2, lon2 = 40.417142, -3.703800
        dist_m = fa.haversine_m(lat1, lon1, lat2, lon2)
        self.assertGreaterEqual(dist_m, 35.0)
        self.assertLess(dist_m, 40.0)

        records = [
            {
                "id": "VODAFONE ESPAÑA, S.A.U. - 280100",
                "gid": "280100",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": lat1,
                "lon": lon1,
                "dir": "PUERTA DEL SOL 1",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A.U. - 280101",
                "gid": "280101",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": lat2,
                "lon": lon2,
                "dir": "PUERTA DEL SOL 3",
                "mun": "MADRID",
                "prov": "MADRID",
            },
        ]

        fused, dup_count = fa.fuse_vodafone_duplicates(records)
        self.assertEqual(dup_count, 0)
        self.assertEqual(len(fused), 2)
        self.assertNotIn("mergedGids", fused[0])
        self.assertNotIn("mergedGids", fused[1])

    def test_telefonica_and_other_operators_under_35m_are_never_fused(self) -> None:
        # Estaciones de Telefónica (movistar) a 0 m, ~15 m y ~30 m entre sí JAMÁS
        # deben fusionarse entre ellas, ni tampoco con Orange o Vodafone.
        base_lat, base_lon = 40.416800, -3.703800
        lat_15m = 40.416935  # ~15.01 m
        lat_30m = 40.417070  # ~30.02 m
        self.assertAlmostEqual(fa.haversine_m(base_lat, base_lon, base_lat, base_lon), 0.0)
        self.assertTrue(14.0 <= fa.haversine_m(base_lat, base_lon, lat_15m, base_lon) <= 16.0)
        self.assertTrue(29.0 <= fa.haversine_m(base_lat, base_lon, lat_30m, base_lon) <= 31.0)

        records = [
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001",
                "gid": "2800001",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": base_lat,
                "lon": base_lon,
                "dir": "GRAN VIA 28",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800002",
                "gid": "2800002",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": base_lat,  # 0 m exactos respecto a 2800001
                "lon": base_lon,
                "dir": "GRAN VIA 28",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800003",
                "gid": "2800003",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": lat_15m,  # ~15 m
                "lon": base_lon,
                "dir": "GRAN VIA 30",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800004",
                "gid": "2800004",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": lat_30m,  # ~30 m (< 35 m)
                "lon": base_lon,
                "dir": "GRAN VIA 32",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 2800005",
                "gid": "2800005",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 40.416805,  # ~0.7 m
                "lon": -3.703805,
                "dir": "GRAN VIA 28",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A.U. - 289001",
                "gid": "289001",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": 40.416802,  # Co-ubicada con Movistar/Orange, pero única de Vodafone
                "lon": -3.703802,
                "dir": "GRAN VIA 28",
                "mun": "MADRID",
                "prov": "MADRID",
            },
        ]

        dataset = fa.build_dataset(
            records,
            crawl_stats={
                "requestsCount": 1,
                "durationSeconds": 0.5,
                "gridBoxesVisited": 1,
                "subdividedBoxes": 0,
                "zoomParam": 7,
                "delaySeconds": 1.0,
            },
        )
        self.assertEqual(dataset["crawlStats"]["vodafoneFusedDuplicates"], 0)
        self.assertEqual(dataset["total"], 6)
        self.assertEqual(dataset["operators"]["movistar"]["count"], 4)
        self.assertEqual(dataset["operators"]["orange"]["count"], 1)
        self.assertEqual(dataset["operators"]["vodafone"]["count"], 1)
        self.assertEqual(dataset["provinces"][0]["byOperator"]["movistar"], 4)
        movistar_antenas = [a for a in dataset["antenas"] if a["op"] == "movistar"]
        self.assertEqual(len(movistar_antenas), 4)
        for ant in movistar_antenas:
            self.assertNotIn("mergedGids", ant)

    def test_classify_frequency_band_all_spanish_allocations(self) -> None:
        cases = [
            (758.0, 768.0, "700 MHz"),
            (832.0, 842.0, "800 MHz"),
            (935.10, 949.90, "900 MHz"),
            (1452.0, 1472.0, "1500 MHz"),
            (1805.10, 1825.10, "1800 MHz"),
            (2155.0, 2170.0, "2100 MHz"),
            (2620.0, 2640.0, "2600 MHz"),
            (3460.0, 3600.0, "3500 MHz"),
            (26500.0, 27500.0, "26 GHz"),
            (450.0, 460.0, "455 MHz"),
        ]
        for min_mhz, max_mhz, expected in cases:
            with self.subTest(min_mhz=min_mhz, max_mhz=max_mhz):
                self.assertEqual(
                    fa.classify_frequency_band(min_mhz, max_mhz),
                    expected,
                )

        # Verificar orden numérico de bandas y frecuencias sin duplicados
        bandas, frecuencias = fa.summarize_frequency_ranges(
            [
                (26500.0, 27500.0),
                (3460.0, 3600.0),
                (935.1, 949.9),
                (935.10, 949.90),
                (758.0, 768.0),
                (2155.0, 2170.0),
                (832.0, 842.0),
                (2620.0, 2640.0),
                (1805.1, 1825.1),
            ]
        )
        self.assertEqual(
            bandas,
            [
                "700 MHz",
                "800 MHz",
                "900 MHz",
                "1800 MHz",
                "2100 MHz",
                "2600 MHz",
                "3500 MHz",
                "26 GHz",
            ],
        )
        self.assertEqual(
            frecuencias,
            [
                "758.00 - 768.00",
                "832.00 - 842.00",
                "935.10 - 949.90",
                "1805.10 - 1825.10",
                "2155.00 - 2170.00",
                "2620.00 - 2640.00",
                "3460.00 - 3600.00",
                "26500.00 - 27500.00",
            ],
        )

    def test_parse_detalle_estacion_html_extracts_caracteristicas_and_ignores_niveles_medidos(
        self,
    ) -> None:
        sample_html = """
        <html><body>
        <table class="tablaDetalleEstacion">
            <tr><td><h1>ESTACIONES DE TELEFON&Iacute;A M&Oacute;VIL</h1></td></tr>
            <tr><td><h2>LOCALIZACI&Oacute;N</h2></td></tr>
            <tr><td>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td><h3>C&oacute;digo</h3></td><td><h3>Direcci&oacute;n</h3></td></tr>
                    <tr>
                        <td><p>TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006</p></td>
                        <td><p>CL EMILIO FERRARI, 11. MADRID, MADRID</p></td>
                    </tr>
                </table>
            </td></tr>
            <tr><tr><td><h2>CARACTERISTICAS T&Eacute;CNICAS</h2></td></tr>
            <tr><tr><td>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr>
                        <td><h3>Operador</h3></td>
                        <td><h3>Referencia</h3></td>
                        <td><h3>Banda Asignada (MHz)</h3></td>
                    </tr>
                    <tr>
                        <td><p>TELEFONICA MOVILES ESPAÑA, S.A.U.</p></td>
                        <td><p>M M -2200490</p></td>
                        <td><p>935.10 - 949.90</p></td>
                    </tr>
                    <tr>
                        <td><p>DS MOBILE NETWORKS, S.L.</p></td>
                        <td><p>M M -2602235</p></td>
                        <td><p>1845.10 - 1855.10</p></td>
                    </tr>
                    <tr>
                        <td><p>TELEFONICA MOVILES ESPAÑA, S.A.U.</p></td>
                        <td><p>M M -2205199</p></td>
                        <td><p>3460.00 - 3600.00</p></td>
                    </tr>
                </table>
            </td></tr>
            <tr><td><h2>NIVELES MEDIDOS EN EL ENTORNO</h2></td></tr>
            <tr><td>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr>
                        <td><h3>Distancia (m)</h3></td>
                        <td><h3>(*) Acimut (&ordm;)</h3></td>
                        <td><h3>Valor Medido (&micro;W/cm<sup>2</sup>)</h3></td>
                    </tr>
                    <tr>
                        <td><p>84.0</p></td>
                        <td><p>120.0</p></td>
                        <td><p>0.21966</p></td>
                    </tr>
                    <tr>
                        <td><p>700.0 - 800.0</p></td>
                        <td><p>165.0</p></td>
                        <td><p>800.00 - 900.00</p></td>
                    </tr>
                </table>
            </td></tr>
        </table>
        </body></html>
        """
        latin1_bytes = sample_html.encode("iso-8859-1")
        decoded_html = fa.decode_detalle_estacion_payload(latin1_bytes)
        rows = fa.parse_detalle_estacion_html(decoded_html)
        self.assertEqual(len(rows), 3)
        self.assertEqual(
            [(r["op"], r["frecuencia"], r["banda"]) for r in rows],
            [
                ("movistar", "935.10 - 949.90", "900 MHz"),
                ("digi", "1845.10 - 1855.10", "1800 MHz"),
                ("movistar", "3460.00 - 3600.00", "3500 MHz"),
            ],
        )

        # Respuesta 200 válida sin filas de bandas (ej. código no válido o tabla vacía)
        empty_html = """
        <table class="tablaDetalleEstacion">
            <tr><td><h2>LOCALIZACI&Oacute;N</h2></td></tr>
            <tr><td><b>C&oacute;digo de emplazamiento no v&aacute;lido</b></td></tr>
        </table>
        """
        self.assertEqual(fa.parse_detalle_estacion_html(empty_html), [])
        self.assertEqual(
            fa.build_detalle_estacion_url("2800006"),
            "https://geoportal.minetur.gob.es/VCTEL/detalleEstacion.do?emplazamiento=2800006",
        )
        self.assertEqual(
            fa.build_detalle_estacion_url("A/B 12"),
            "https://geoportal.minetur.gob.es/VCTEL/detalleEstacion.do?emplazamiento=A%2FB%2012",
        )

    def test_enrich_bands_rate_limit_shared_gid_vodafone_merged_and_preservation(
        self,
    ) -> None:
        clock = FakeClock()
        fetched_gids: list[str] = []
        transient_failed_once = False

        html_by_gid: dict[str, str] = {
            # Emplazamiento compartido por Movistar y DIGI -> 1 sola petición HTTP
            "2800006": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>R1</td><td>3460.00 - 3600.00</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>R2</td><td>935.10 - 949.90</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>R3</td><td>935.10 - 949.90</td></tr>
                    <tr><td>DS MOBILE NETWORKS, S.L.</td><td>D1</td><td>2110.00 - 2120.00</td></tr>
                    <tr><td>DS MOBILE NETWORKS, S.L.</td><td>D2</td><td>1845.10 - 1855.10</td></tr>
                </table>
            """,
            # Vodafone fusionado (144693 + 0144693) -> unión de ambos GIDs
            "144693": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>VODAFONE ESPAÑA, S.A.U.</td><td>V1</td><td>842.00 - 852.00</td></tr>
                </table>
            """,
            "0144693": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>VODAFONE ESPAÑA, S.A.</td><td>V2</td><td>1825.10 - 1845.10</td></tr>
                    <tr><td>VODAFONE ESPAÑA, S.A.</td><td>V3</td><td>949.90 - 959.90</td></tr>
                </table>
            """,
            # Único registro con ese GID y razón social histórica/atípica -> respaldo a todas las filas
            "3309999": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>FILIAL REGIONAL CONCESIONARIA, S.L.</td><td>O1</td><td>758.00 - 768.00</td></tr>
                </table>
            """,
            # Estación 200 válida sin filas de frecuencias -> [] (no debe repetirse en bucle)
            "4108888": """
                <table class="tablaDetalleEstacion">
                    <tr><td><h2>LOCALIZACIÓN</h2></td></tr>
                </table>
            """,
        }

        def fake_detalle_fetch(gid: str) -> bytes:
            nonlocal transient_failed_once
            fetched_gids.append(gid)
            if gid == "0144693" and not transient_failed_once:
                transient_failed_once = True
                raise urllib.error.URLError("transient reset")
            return html_by_gid[gid].encode("iso-8859-1")

        raw_records = [
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                "gid": "2800006",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.434322,
                "lon": -3.642914,
                "dir": "CL EMILIO FERRARI, 11",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "DS MOBILE NETWORKS, S.L. - 2800006",
                "gid": "2800006",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "lat": 40.434322,
                "lon": -3.642914,
                "dir": "CL EMILIO FERRARI, 11",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A.U. - 144693",
                "gid": "144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": 42.897686,
                "lon": -8.704622,
                "dir": "LG PG 78 PARC 9000 - ARUFE, S/N",
                "mun": "AMES",
                "prov": "A CORUÑA",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A. - 0144693",
                "gid": "0144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.",
                "lat": 42.897900,
                "lon": -8.704622,
                "dir": "LG PG 78 PARC 9000 - ARUFE, S/N",
                "mun": "AMES",
                "prov": "A CORUÑA",
            },
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 3309999",
                "gid": "3309999",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 43.3619,
                "lon": -5.8494,
                "dir": "CL URÍA, 10",
                "mun": "OVIEDO",
                "prov": "ASTURIAS",
            },
            {
                "id": "XFERA MOVILES, S.A.U. - 4108888",
                "gid": "4108888",
                "op": "masmovil",
                "opRaw": "XFERA MOVILES, S.A.U.",
                "lat": 37.3891,
                "lon": -5.9845,
                "dir": "AV CONSTITUCIÓN, 1",
                "mun": "SEVILLA",
                "prov": "SEVILLA",
            },
        ]

        base_stats = {
            "requestsCount": 2,
            "durationSeconds": 2.0,
            "gridBoxesVisited": 2,
            "subdividedBoxes": 0,
            "zoomParam": 7,
            "delaySeconds": 1.0,
        }
        dataset = fa.build_dataset(raw_records, crawl_stats=base_stats)
        self.assertEqual(dataset["total"], 5)  # 2 de Vodafone fusionadas en 1

        with tempfile.TemporaryDirectory() as tmpdir:
            out_path = Path(tmpdir) / "antenas.json"
            # Incluso si se pasa delay_seconds < 1.0, BandEnricher fuerza estrictamente >= 1.0 s
            enricher = fa.BandEnricher(
                delay_seconds=0.2,
                checkpoint_path=out_path,
                checkpoint_every=2,
                fail_fast=True,
                fetch_fn=fake_detalle_fetch,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            self.assertGreaterEqual(enricher.delay_seconds, 1.0)
            enricher.enrich_dataset(dataset)

            # 2800006 consultado 1 sola vez (el primero por ser compartido en MADRID)
            self.assertEqual(fetched_gids[0], "2800006")
            self.assertEqual(fetched_gids.count("2800006"), 1)
            # 5 GIDs únicos + 1 reintento transitorio en 0144693 = 6 peticiones
            self.assertEqual(enricher.requests_count, 6)
            self.assertTrue(all(s >= 1.0 for s in clock.sleeps))
            self.assertIn(2.0, clock.sleeps)

            by_id = {a["id"]: a for a in dataset["antenas"]}

            # Movistar y DIGI en 2800006 tienen cada uno exclusivamente sus propias bandas
            mov = by_id["TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006"]
            digi = by_id["DS MOBILE NETWORKS, S.L. - 2800006"]
            self.assertEqual(mov["bandas"], ["900 MHz", "3500 MHz"])
            self.assertEqual(mov["frecuencias"], ["935.10 - 949.90", "3460.00 - 3600.00"])
            self.assertEqual(digi["bandas"], ["1800 MHz", "2100 MHz"])
            self.assertEqual(digi["frecuencias"], ["1845.10 - 1855.10", "2110.00 - 2120.00"])

            # Vodafone fusionado une frecuencias de 144693 y 0144693
            voda = by_id["VODAFONE ESPAÑA, S.A.U. - 144693"]
            self.assertEqual(voda["mergedGids"], ["144693", "0144693"])
            self.assertEqual(voda["bandas"], ["800 MHz", "900 MHz", "1800 MHz"])
            self.assertEqual(
                voda["frecuencias"],
                ["842.00 - 852.00", "949.90 - 959.90", "1825.10 - 1845.10"],
            )

            # Respaldo en GID único con razón social atípica
            ora = by_id["ORANGE ESPAGNE, S.A.U. - 3309999"]
            self.assertEqual(ora["bandas"], ["700 MHz"])
            self.assertEqual(ora["frecuencias"], ["758.00 - 768.00"])

            # Emplazamiento sin filas guarda [] (clave presente)
            masm = by_id["XFERA MOVILES, S.A.U. - 4108888"]
            self.assertEqual(masm["bandas"], [])
            self.assertEqual(masm["frecuencias"], [])

            self.assertEqual(dataset["crawlStats"]["bandsPopulatedCount"], 5)
            self.assertEqual(dataset["crawlStats"]["bandRequestsCount"], 6)

            # Segunda pasada incremental sobre out_path: 0 peticiones HTTP (incluyendo la de bandas=[])
            saved_dataset = json.loads(out_path.read_text(encoding="utf-8"))
            fa.enrich_dataset_bands(
                saved_dataset,
                fetch_fn=lambda *_: (_ for _ in ()).throw(
                    AssertionError("No debe repetir peticiones HTTP para antenas ya enriquecidas")
                ),
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            self.assertEqual(saved_dataset["crawlStats"]["bandRequestsCount"], 0)
            self.assertEqual(saved_dataset["crawlStats"]["bandsPopulatedCount"], 5)

            # Nuevo crawl diario (raw_records sin bandas) preservando desde out_path:
            # conserva el 100% de bandas existentes y solo consulta una antena nueva añadida hoy.
            new_day_records = list(raw_records) + [
                {
                    "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 0800555",
                    "gid": "0800555",
                    "op": "movistar",
                    "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                    "lat": 41.3874,
                    "lon": 2.1686,
                    "dir": "PL CATALUNYA, 1",
                    "mun": "BARCELONA",
                    "prov": "BARCELONA",
                }
            ]
            html_by_gid["0800555"] = """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>B1</td><td>2620.00 - 2640.00</td></tr>
                </table>
            """
            rebuilt_day2 = fa.build_dataset(
                new_day_records,
                crawl_stats=base_stats,
                preserve_from=out_path,
            )
            self.assertEqual(rebuilt_day2["total"], 6)
            self.assertEqual(rebuilt_day2["crawlStats"]["bandsPopulatedCount"], 5)

            fetched_day2: list[str] = []

            def fake_day2_fetch(gid: str) -> str:
                fetched_day2.append(gid)
                return html_by_gid[gid]

            fa.enrich_dataset_bands(
                rebuilt_day2,
                fetch_fn=fake_day2_fetch,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            self.assertEqual(fetched_day2, ["0800555"])
            self.assertEqual(rebuilt_day2["crawlStats"]["bandsPopulatedCount"], 6)
            self.assertEqual(rebuilt_day2["crawlStats"]["bandRequestsCount"], 1)

    def test_max_band_requests_and_max_band_seconds_budget_limits(self) -> None:
        clock = FakeClock()
        records = [
            {
                "id": f"TELEFONICA MOVILES ESPAÑA, S.A.U. - 280100{i}",
                "gid": f"280100{i}",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.40 + i * 0.01,
                "lon": -3.70,
                "dir": f"CL TEST, {i}",
                "mun": "MADRID",
                "prov": "MADRID",
            }
            for i in range(5)
        ]
        dataset = fa.build_dataset(
            records,
            crawl_stats={
                "requestsCount": 1,
                "durationSeconds": 1.0,
                "gridBoxesVisited": 1,
                "subdividedBoxes": 0,
                "zoomParam": 7,
                "delaySeconds": 1.0,
            },
        )

        def fake_html(gid: str) -> str:
            return """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>T1</td><td>1805.10 - 1825.10</td></tr>
                </table>
            """

        with tempfile.TemporaryDirectory() as tmpdir:
            ckpt = Path(tmpdir) / "antenas.json"
            # Lote 1 limitado por max_band_requests=2
            fa.enrich_dataset_bands(
                dataset,
                max_band_requests=2,
                checkpoint_path=ckpt,
                fetch_fn=fake_html,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            self.assertEqual(dataset["crawlStats"]["bandsPopulatedCount"], 2)
            self.assertEqual(dataset["crawlStats"]["bandRequestsCount"], 2)

            # Lote 2 limitado por max_band_seconds=1.5 (permite 2 peticiones con 1.0s entre ellas y para antes de la 3ª)
            fa.enrich_dataset_bands(
                dataset,
                max_band_seconds=1.5,
                checkpoint_path=ckpt,
                fetch_fn=fake_html,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            self.assertEqual(dataset["crawlStats"]["bandsPopulatedCount"], 4)
            self.assertEqual(dataset["crawlStats"]["bandRequestsCount"], 2)

            # Lote 3 completa la última pendiente
            fa.enrich_dataset_bands(
                dataset,
                checkpoint_path=ckpt,
                fetch_fn=fake_html,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            self.assertEqual(dataset["crawlStats"]["bandsPopulatedCount"], 5)
            self.assertEqual(dataset["crawlStats"]["bandRequestsCount"], 1)

    def test_format_spain_datetime_cet_and_cest(self) -> None:
        # Invierno CET (UTC+1): 17:14:09Z -> 18:14:09
        self.assertEqual(
            fa.format_spain_datetime("2026-11-16T17:14:09Z"),
            "16/11/2026 18:14:09",
        )
        # Verano CEST (UTC+2): 16:14:09Z -> 18:14:09
        self.assertEqual(
            fa.format_spain_datetime("2026-07-16T16:14:09Z"),
            "16/07/2026 18:14:09",
        )
        # Cambio de día en medianoche española (CEST UTC+2)
        self.assertEqual(
            fa.format_spain_datetime("2026-08-01T22:05:59Z"),
            "02/08/2026 00:05:59",
        )
        # Acepta también objetos datetime UTC directamente
        dt_utc = datetime(2026, 12, 31, 23, 30, 45, tzinfo=timezone.utc)
        self.assertEqual(
            fa.format_spain_datetime(dt_utc),
            "01/01/2027 00:30:45",
        )

    def test_format_exact_ministry_frequency_and_concesiones_preservation(self) -> None:
        # Sin abreviación ni pérdida de decimales declarados en MINETUR
        self.assertEqual(
            fa.format_exact_ministry_frequency("3460.00 - 3600.00"),
            "3460.00 - 3600.00 MHz",
        )
        self.assertEqual(
            fa.format_exact_ministry_frequency("935.10 - 949.90"),
            "935.10 - 949.90 MHz",
        )
        self.assertEqual(
            fa.format_exact_ministry_frequency("  1805.125   -   1825.125  "),
            "1805.125 - 1825.125 MHz",
        )
        self.assertEqual(
            fa.format_exact_ministry_frequency("3460.00 - 3600.00 MHz"),
            "3460.00 - 3600.00 MHz",
        )
        self.assertEqual(
            fa.format_exact_ministry_frequency("26.50 - 27.50 GHz"),
            "26.50 - 27.50 GHz",
        )
        self.assertEqual(fa.format_exact_ministry_frequency("   "), "")

        sample_html = """
            <h2>CARACTERISTICAS TÉCNICAS</h2>
            <table class="tablaDetalleEstacionNivelesMedidos">
                <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2205199</td><td>3460.00 - 3600.00</td></tr>
                <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2200490</td><td>935.10 - 949.90</td></tr>
            </table>
        """
        rows = fa.parse_detalle_estacion_html(sample_html)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["frecuenciaDeclarada"], "3460.00 - 3600.00")
        self.assertEqual(rows[0]["referencia"], "M M -2205199")

        clock = FakeClock()
        fixed_utc = datetime(2026, 11, 15, 17, 10, 0, tzinfo=timezone.utc)
        rec = {
            "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
            "gid": "2800006",
            "op": "movistar",
            "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
            "lat": 40.434322,
            "lon": -3.642914,
            "dir": "CL EMILIO FERRARI, 11",
            "mun": "MADRID",
            "prov": "MADRID",
        }
        ds = fa.build_dataset(
            [rec],
            crawl_stats={
                "requestsCount": 1,
                "durationSeconds": 1.0,
                "gridBoxesVisited": 1,
                "subdividedBoxes": 0,
                "zoomParam": 7,
                "delaySeconds": 1.0,
            },
        )
        fa.enrich_dataset_bands(
            ds,
            fetch_fn=lambda _gid: sample_html,
            sleep_fn=clock.sleep,
            clock_fn=clock.time,
            now_utc_fn=lambda: fixed_utc,
        )
        enriched = ds["antenas"][0]
        self.assertEqual(
            enriched["concesiones"],
            [
                {"ref": "M M -2200490", "freq": "935.10 - 949.90"},
                {"ref": "M M -2205199", "freq": "3460.00 - 3600.00"},
            ],
        )
        self.assertEqual(enriched["bandsScannedAt"], "2026-11-15T17:10:00Z")

        # Verificar que preserve_bands_in_records conserva también concesiones y bandsScannedAt
        fresh_copy = [dict(rec)]
        restored = fa.preserve_bands_in_records(fresh_copy, ds)
        self.assertEqual(restored, 1)
        self.assertEqual(fresh_copy[0]["concesiones"], enriched["concesiones"])
        self.assertEqual(fresh_copy[0]["bandsScannedAt"], "2026-11-15T17:10:00Z")

    def test_novedades_diff_new_antenna_new_frequency_cold_scan_and_vodafone_dedup(
        self,
    ) -> None:
        base_stats = {
            "requestsCount": 2,
            "durationSeconds": 2.0,
            "gridBoxesVisited": 2,
            "subdividedBoxes": 0,
            "zoomParam": 7,
            "delaySeconds": 1.0,
        }
        # Escaneo previo (día 1):
        # 1) Movistar 2800006 YA escaneada con 900 MHz (M M -2200490)
        # 2) Orange 4600111 existente pero FRÍA (nunca escaneada aún: sin bandas/concesiones)
        # 3) Vodafone 0144693 YA escaneada con 800 MHz (V-800)
        prior_records = [
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                "gid": "2800006",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.434322,
                "lon": -3.642914,
                "dir": "CL EMILIO FERRARI, 11",
                "mun": "MADRID",
                "prov": "MADRID",
                "bandas": ["900 MHz"],
                "frecuencias": ["935.10 - 949.90"],
                "concesiones": [{"ref": "M M -2200490", "freq": "935.10 - 949.90"}],
                "bandsScannedAt": "2026-11-15T17:05:00Z",
            },
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 4600111",
                "gid": "4600111",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 39.4699,
                "lon": -0.3763,
                "dir": "PL AYUNTAMIENTO, 1",
                "mun": "VALENCIA",
                "prov": "VALENCIA",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A. - 0144693",
                "gid": "0144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.",
                "lat": 42.897900,
                "lon": -8.704622,
                "dir": "LG PG 78 PARC 9000 - ARUFE, S/N",
                "mun": "AMES",
                "prov": "A CORUÑA",
                "bandas": ["800 MHz"],
                "frecuencias": ["842.00 - 852.00"],
                "concesiones": [{"ref": "V-800", "freq": "842.00 - 852.00"}],
                "bandsScannedAt": "2026-11-15T17:06:00Z",
            },
        ]
        prior_dataset = fa.build_dataset(
            prior_records,
            crawl_stats=base_stats,
            updated_at="2026-11-15T17:30:00Z",
        )

        # Escaneo día 2 a las 18:00 España (17:00 UTC invierno):
        # - Movistar 2800006 añade banda 3500 MHz (M M -2205199, 3460.00 - 3600.00)
        # - Movistar 2800007 NUEVA a 10 m de 2800006 (Telefónica NUNCA se fusiona consigo misma)
        # - DIGI 0800999 NUEVA en Barcelona
        # - Orange 4600111 existente fría -> se escanea por 1ª vez -> 0 falsos positivos
        # - Vodafone añade duplicado administrativo 144693 a < 35 m (~24 m) con la misma banda V-800 ->
        #   se fusiona con 0144693 y NO genera antena nueva falsa ni frecuencia nueva falsa!
        day2_raw_records = [
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                "gid": "2800006",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.434322,
                "lon": -3.642914,
                "dir": "CL EMILIO FERRARI, 11",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800007",
                "gid": "2800007",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.434400,  # ~8.7 m de 2800006 -> jamás se fusiona en Telefónica
                "lon": -3.642914,
                "dir": "CL EMILIO FERRARI, 13",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "DS MOBILE NETWORKS, S.L. - 0800999",
                "gid": "0800999",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "lat": 41.3874,
                "lon": 2.1686,
                "dir": "PL CATALUNYA, 5",
                "mun": "BARCELONA",
                "prov": "BARCELONA",
            },
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 4600111",
                "gid": "4600111",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 39.4699,
                "lon": -0.3763,
                "dir": "PL AYUNTAMIENTO, 1",
                "mun": "VALENCIA",
                "prov": "VALENCIA",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A. - 0144693",
                "gid": "0144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.",
                "lat": 42.897900,
                "lon": -8.704622,
                "dir": "LG PG 78 PARC 9000 - ARUFE, S/N",
                "mun": "AMES",
                "prov": "A CORUÑA",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A.U. - 144693",
                "gid": "144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": 42.897686,
                "lon": -8.704622,
                "dir": "LG PG 78 PARC 9000 - ARUFE, S/N",
                "mun": "AMES",
                "prov": "A CORUÑA",
            },
        ]

        crawl_iso = "2026-11-16T17:02:00Z"
        day2_dataset = fa.build_dataset(
            day2_raw_records,
            crawl_stats=base_stats,
            updated_at=crawl_iso,
        )
        # 6 registros brutos -> 5 antenas únicas (las 2 de Vodafone fusionadas; las 2 de Movistar intactas)
        self.assertEqual(day2_dataset["total"], 5)

        prior_index = fa.build_prior_antenna_index(prior_dataset)
        ant_novedades, new_ant_ids = fa.diff_new_antennas(
            day2_dataset["antenas"],
            prior_index,
            scanned_at_iso=crawl_iso,
        )
        # Exactamente 2 antenas nuevas: Movistar 2800007 y DIGI 0800999 (Vodafone 144693 NO cuenta como nueva)
        self.assertEqual(
            new_ant_ids,
            {
                "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800007",
                "DS MOBILE NETWORKS, S.L. - 0800999",
            },
        )
        self.assertEqual(len(ant_novedades), 2)
        digi_nov = next(n for n in ant_novedades if n["op"] == "digi")
        self.assertEqual(
            digi_nov,
            {
                "id": "ant:DS MOBILE NETWORKS, S.L. - 0800999",
                "tipo": "antena",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "codigo": "0800999",
                "antennaId": "DS MOBILE NETWORKS, S.L. - 0800999",
                "codigoBanda": "",
                "frecuencia": "",
                "ubicacion": "BARCELONA",
                "prov": "BARCELONA",
                "scannedAt": "2026-11-16T17:02:00Z",
                "fecha": "16/11/2026 18:02:00",
            },
        )

        fa.preserve_bands_in_records(day2_dataset["antenas"], prior_dataset)

        html_day2: dict[str, str] = {
            "2800006": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2200490</td><td>935.10 - 949.90</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2205199</td><td>3460.00 - 3600.00</td></tr>
                </table>
            """,
            "2800007": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2209999</td><td>758.00 - 768.00</td></tr>
                </table>
            """,
            "0800999": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>DS MOBILE NETWORKS, S.L.</td><td>M M -2602235</td><td>1845.10 - 1855.10</td></tr>
                </table>
            """,
            "4600111": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>OR-1800</td><td>1805.10 - 1825.10</td></tr>
                </table>
            """,
            "144693": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>VODAFONE ESPAÑA, S.A.U.</td><td>V-800</td><td>842.00 - 852.00</td></tr>
                </table>
            """,
            "0144693": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>VODAFONE ESPAÑA, S.A.</td><td>V-800</td><td>842.00 - 852.00</td></tr>
                </table>
            """,
        }

        clock = FakeClock()
        step_counter = 0

        def next_utc() -> datetime:
            nonlocal step_counter
            step_counter += 1
            return datetime(2026, 11, 16, 17, 14, step_counter, tzinfo=timezone.utc)

        enricher = fa.BandEnricher(
            delay_seconds=1.0,
            rescan_since="2026-11-16T17:00:00Z",
            new_antenna_ids=new_ant_ids,
            prior_index=prior_index,
            record_novedades=True,
            fetch_fn=lambda gid: html_day2[gid],
            sleep_fn=clock.sleep,
            clock_fn=clock.time,
            now_utc_fn=next_utc,
        )
        enricher.enrich_dataset(day2_dataset)

        # Solo 1 novedad de frecuencia: 3460.00 - 3600.00 MHz en Movistar 2800006.
        # - Orange 4600111 (fría sin escaneo previo) NO genera falsos positivos.
        # - Antenas nuevas (2800007, 0800999) NO duplican filas de frecuencia.
        # - Vodafone fusionada (V-800 ya conocida en 0144693) NO genera novedad falsa.
        self.assertEqual(len(enricher.discovered_novedades), 1)
        freq_nov = enricher.discovered_novedades[0]
        self.assertEqual(freq_nov["tipo"], "frecuencia")
        self.assertEqual(freq_nov["op"], "movistar")
        self.assertEqual(freq_nov["opRaw"], "TELEFONICA MOVILES ESPAÑA, S.A.U.")
        self.assertEqual(freq_nov["codigo"], "2800006")
        self.assertEqual(
            freq_nov["antennaId"], "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006"
        )
        self.assertEqual(freq_nov["codigoBanda"], "M M -2205199")
        self.assertEqual(freq_nov["frecuencia"], "3460.00 - 3600.00 MHz")
        self.assertEqual(freq_nov["ubicacion"], "MADRID")
        self.assertEqual(freq_nov["prov"], "MADRID")
        self.assertRegex(freq_nov["fecha"], r"^16/11/2026 18:14:\d{2}$")

        nov_dataset = fa.build_novedades_dataset(
            [*ant_novedades, *enricher.discovered_novedades],
            scan_id="daily-20261116",
            previous_scan_at=prior_dataset["updatedAt"],
            updated_at="2026-11-16T17:20:00Z",
            is_baseline_scan=False,
        )
        self.assertFalse(nov_dataset["isBaselineScan"])
        self.assertEqual(nov_dataset["total"], 3)
        self.assertEqual(nov_dataset["antenasNuevas"], 2)
        self.assertEqual(nov_dataset["frecuenciasNuevas"], 1)
        self.assertEqual(nov_dataset["previousScanAt"], "2026-11-15T17:30:00Z")
        # La frecuencia escaneada a las 17:14Z es más reciente que el crawl de las 17:02Z -> va primera
        self.assertEqual(nov_dataset["novedades"][0]["tipo"], "frecuencia")

    def test_skip_novedades_produces_empty_baseline_in_reset_and_append(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ant_path = tmp / "antenas.json"
            nov_path = tmp / "novedades.json"

            # Crear dataset previo con una antena ya escaneada y novedades antiguas
            ds = fa.build_dataset(
                [
                    {
                        "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                        "gid": "2800006",
                        "op": "movistar",
                        "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                        "lat": 40.434322,
                        "lon": -3.642914,
                        "dir": "CL EMILIO FERRARI, 11",
                        "mun": "MADRID",
                        "prov": "MADRID",
                        "bandas": ["900 MHz"],
                        "frecuencias": ["935.10 - 949.90"],
                        "concesiones": [
                            {"ref": "M M -2200490", "freq": "935.10 - 949.90"}
                        ],
                        "bandsScannedAt": "2026-11-14T17:00:00Z",
                    },
                    {
                        "id": "ORANGE ESPAGNE, S.A.U. - 2800999",
                        "gid": "2800999",
                        "op": "orange",
                        "opRaw": "ORANGE ESPAGNE, S.A.U.",
                        "lat": 40.420000,
                        "lon": -3.700000,
                        "dir": "GRAN VÍA, 1",
                        "mun": "MADRID",
                        "prov": "MADRID",
                        "bandas": ["800 MHz"],
                        "frecuencias": ["832.00 - 842.00"],
                        "concesiones": [{"ref": "OR-1", "freq": "832.00 - 842.00"}],
                        "bandsScannedAt": "2026-11-14T17:01:00Z",
                    },
                ],
                crawl_stats={
                    "requestsCount": 1,
                    "durationSeconds": 1.0,
                    "gridBoxesVisited": 1,
                    "subdividedBoxes": 0,
                    "zoomParam": 7,
                    "delaySeconds": 1.0,
                },
                updated_at="2026-11-14T17:05:00Z",
            )
            fa.write_compact_dataset(ds, ant_path)

            # Poblar novedades previas para verificar que --novedades-mode reset --skip-novedades limpia a 0
            old_nov = fa.build_novedades_dataset(
                [
                    {
                        "id": "ant:OLD",
                        "tipo": "antena",
                        "op": "movistar",
                        "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                        "codigo": "9999999",
                        "antennaId": "OLD",
                        "codigoBanda": "",
                        "frecuencia": "",
                        "ubicacion": "MADRID",
                        "prov": "MADRID",
                        "scannedAt": "2026-11-14T17:05:00Z",
                        "fecha": "14/11/2026 18:05:00",
                    }
                ],
                scan_id="old-scan",
                is_baseline_scan=False,
            )
            fa.write_novedades_dataset(old_nov, nov_path)

            # Aunque ambas antenas traen frecuencias nuevas en MINETUR, --skip-novedades NO registra ninguna
            new_html = """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2205199</td><td>3460.00 - 3600.00</td></tr>
                    <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>OR-3500</td><td>3600.00 - 3710.00</td></tr>
                </table>
            """

            class _FakeHTTPResp:
                def __init__(self, body: bytes) -> None:
                    self._body = body

                def read(self) -> bytes:
                    return self._body

                def __enter__(self) -> _FakeHTTPResp:
                    return self

                def __exit__(self, *_: object) -> None:
                    return None

            with (
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=lambda *_a, **_kw: _FakeHTTPResp(
                        new_html.encode("iso-8859-1")
                    ),
                ),
                mock.patch("time.sleep", return_value=None),
            ):
                rc1 = fa.main(
                    [
                        "--enrich-bands-only",
                        "--input",
                        str(ant_path),
                        "--output",
                        str(ant_path),
                        "--max-band-requests",
                        "1",
                        "--rescan-since",
                        "2099-01-01T00:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--novedades-mode",
                        "reset",
                        "--skip-novedades",
                        "--scan-id",
                        "forced-now",
                    ]
                )
                self.assertEqual(rc1, 0)
                nov_after_part1 = json.loads(nov_path.read_text(encoding="utf-8"))
                self.assertTrue(nov_after_part1["isBaselineScan"])
                self.assertEqual(nov_after_part1["total"], 0)
                self.assertEqual(nov_after_part1["antenasNuevas"], 0)
                self.assertEqual(nov_after_part1["frecuenciasNuevas"], 0)
                self.assertEqual(nov_after_part1["novedades"], [])

                rc2 = fa.main(
                    [
                        "--enrich-bands-only",
                        "--input",
                        str(ant_path),
                        "--output",
                        str(ant_path),
                        "--max-band-requests",
                        "1",
                        "--rescan-since",
                        "2099-01-01T00:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--novedades-mode",
                        "append",
                        "--skip-novedades",
                        "--scan-id",
                        "forced-now",
                    ]
                )
                self.assertEqual(rc2, 0)
                nov_after_part2 = json.loads(nov_path.read_text(encoding="utf-8"))
                self.assertTrue(nov_after_part2["isBaselineScan"])
                self.assertEqual(nov_after_part2["total"], 0)
                self.assertEqual(nov_after_part2["novedades"], [])

    def test_multipart_scan_append_rescan_since_and_priority_order(self) -> None:
        clock = FakeClock()
        # Verificar orden estricto de prioridad en BandEnricher:
        # 1) Antena nueva (gid="9000001")
        # 2) Antena sin concesiones escaneadas aún (gid="9000002")
        # 3) Antena existente más antigua (gid="9000003", bandsScannedAt="2026-11-10T17:00:00Z")
        # 4) Antena existente menos antigua (gid="9000004", bandsScannedAt="2026-11-14T17:00:00Z")
        # Mientras que gid="9000005" (bandsScannedAt="2026-11-16T17:05:00Z" >= rescan_since) se omite.
        records = [
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 9000004",
                "gid": "9000004",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 40.41,
                "lon": -3.70,
                "dir": "C 4",
                "mun": "MADRID",
                "prov": "MADRID",
                "bandas": ["800 MHz"],
                "frecuencias": ["832.00 - 842.00"],
                "concesiones": [{"ref": "R-800", "freq": "832.00 - 842.00"}],
                "bandsScannedAt": "2026-11-14T17:00:00Z",
            },
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 9000005",
                "gid": "9000005",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 40.45,
                "lon": -3.70,
                "dir": "C 5",
                "mun": "MADRID",
                "prov": "MADRID",
                "bandas": ["800 MHz"],
                "frecuencias": ["832.00 - 842.00"],
                "concesiones": [{"ref": "R-800", "freq": "832.00 - 842.00"}],
                "bandsScannedAt": "2026-11-16T17:05:00Z",
            },
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 9000003",
                "gid": "9000003",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 40.43,
                "lon": -3.70,
                "dir": "C 3",
                "mun": "SEBÚLCOR",
                "prov": "SEGOVIA",
                "bandas": ["800 MHz"],
                "frecuencias": ["832.00 - 842.00"],
                "concesiones": [{"ref": "R-800", "freq": "832.00 - 842.00"}],
                "bandsScannedAt": "2026-11-10T17:00:00Z",
            },
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 9000002",
                "gid": "9000002",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 40.42,
                "lon": -3.70,
                "dir": "C 2",
                "mun": "ZAMORA",
                "prov": "ZAMORA",
            },
            {
                "id": "DS MOBILE NETWORKS, S.L. - 9000001",
                "gid": "9000001",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "lat": 40.40,
                "lon": -3.70,
                "dir": "C 1",
                "mun": "SORIA",
                "prov": "SORIA",
            },
        ]
        dataset = fa.build_dataset(
            records,
            crawl_stats={
                "requestsCount": 1,
                "durationSeconds": 1.0,
                "gridBoxesVisited": 1,
                "subdividedBoxes": 0,
                "zoomParam": 7,
                "delaySeconds": 1.0,
            },
            updated_at="2026-11-16T17:00:00Z",
        )

        html_by_gid = {
            "9000001": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table><tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                <tr><td>DS MOBILE NETWORKS, S.L.</td><td>DG-1</td><td>2110.00 - 2120.00</td></tr></table>
            """,
            "9000002": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table><tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>OR-COLD</td><td>1805.10 - 1825.10</td></tr></table>
            """,
            "9000003": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table><tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>R-800</td><td>832.00 - 842.00</td></tr>
                <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>OR-NEW-3</td><td>758.00 - 768.00</td></tr></table>
            """,
            "9000004": """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table><tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>R-800</td><td>832.00 - 842.00</td></tr>
                <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>OR-NEW-4</td><td>3600.00 - 3710.00</td></tr></table>
            """,
        }

        fetched_order: list[str] = []
        tick = 0

        def next_utc() -> datetime:
            nonlocal tick
            tick += 1
            return datetime(2026, 11, 16, 17, 10, 0, tzinfo=timezone.utc) + timedelta(
                seconds=tick
            )

        def fake_fetch(gid: str) -> str:
            fetched_order.append(gid)
            return html_by_gid[gid]

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ant_path = tmp / "antenas.json"
            nov_path = tmp / "novedades.json"
            fa.write_compact_dataset(dataset, ant_path)

            initial_ant_nov = [
                {
                    "id": "ant:DS MOBILE NETWORKS, S.L. - 9000001",
                    "tipo": "antena",
                    "op": "digi",
                    "opRaw": "DS MOBILE NETWORKS, S.L.",
                    "codigo": "9000001",
                    "antennaId": "DS MOBILE NETWORKS, S.L. - 9000001",
                    "codigoBanda": "",
                    "frecuencia": "",
                    "ubicacion": "SORIA",
                    "prov": "SORIA",
                    "scannedAt": "2026-11-16T17:01:00Z",
                    "fecha": "16/11/2026 18:01:00",
                }
            ]

            # Parte 1 (reset, max_band_requests=3): procesa 9000001 (nueva), 9000002 (fría) y 9000003 (más antigua)
            nov_writer_1, seeded_1 = fa._prepare_novedades_writer(
                novedades_output=nov_path,
                novedades_mode="reset",
                skip_novedades=False,
                scan_id="run-1800",
                previous_scan_at="2026-11-15T17:00:00Z",
                initial_novedades=initial_ant_nov,
            )
            ds_part1 = json.loads(ant_path.read_text(encoding="utf-8"))
            enr1 = fa.BandEnricher(
                delay_seconds=1.0,
                max_band_requests=3,
                checkpoint_path=ant_path,
                rescan_since="2026-11-16T17:00:00Z",
                new_antenna_ids=seeded_1,
                record_novedades=True,
                novedades_checkpoint_fn=nov_writer_1,
                fetch_fn=fake_fetch,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
                now_utc_fn=next_utc,
            )
            enr1.enrich_dataset(ds_part1)
            assert nov_writer_1 is not None
            nov_writer_1(enr1.discovered_novedades)

            self.assertEqual(fetched_order, ["9000001", "9000002", "9000003"])
            nov_doc_1 = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertEqual(nov_doc_1["antenasNuevas"], 1)
            self.assertEqual(nov_doc_1["frecuenciasNuevas"], 1)  # OR-NEW-3
            self.assertEqual(nov_doc_1["total"], 2)

            # Parte 2 (append, max_band_requests=3): solo queda pendiente 9000004 (9000005 ya >= rescan_since)
            nov_writer_2, seeded_2 = fa._prepare_novedades_writer(
                novedades_output=nov_path,
                novedades_mode="append",
                skip_novedades=False,
                scan_id="run-1800",
                previous_scan_at=None,
            )
            ds_part2 = json.loads(ant_path.read_text(encoding="utf-8"))
            enr2 = fa.BandEnricher(
                delay_seconds=1.0,
                max_band_requests=3,
                checkpoint_path=ant_path,
                rescan_since="2026-11-16T17:00:00Z",
                new_antenna_ids=seeded_2,
                record_novedades=True,
                novedades_checkpoint_fn=nov_writer_2,
                fetch_fn=fake_fetch,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
                now_utc_fn=next_utc,
            )
            enr2.enrich_dataset(ds_part2)
            assert nov_writer_2 is not None
            nov_writer_2(enr2.discovered_novedades)

            self.assertEqual(
                fetched_order, ["9000001", "9000002", "9000003", "9000004"]
            )
            nov_doc_2 = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertEqual(nov_doc_2["scanId"], "run-1800")
            self.assertEqual(nov_doc_2["previousScanAt"], "2026-11-15T17:00:00Z")
            self.assertFalse(nov_doc_2["isBaselineScan"])
            self.assertEqual(nov_doc_2["antenasNuevas"], 1)
            self.assertEqual(nov_doc_2["frecuenciasNuevas"], 2)  # OR-NEW-3 + OR-NEW-4
            self.assertEqual(nov_doc_2["total"], 3)
            self.assertEqual(
                [n["codigo"] for n in nov_doc_2["novedades"]],
                ["9000004", "9000003", "9000001"],
            )

    def test_main_full_crawl_cli_end_to_end_novedades_and_skip_novedades(self) -> None:
        class _FakeResp:
            def __init__(self, body: bytes) -> None:
                self._body = body

            def read(self) -> bytes:
                return self._body

            def __enter__(self) -> _FakeResp:
                return self

            def __exit__(self, *_: object) -> None:
                return None

        madrid_feat = {
            "type": "Feature",
            "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
            "geometry": {"type": "Point", "coordinates": [-3.700000, 40.415000]},
            "properties": {
                "Gis_ID": "2800006",
                "Gis_Latitud": "40.415000",
                "Gis_Longitud": "-3.700000",
                "Gis_Codigo": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                "Dirección": "CL MAYOR, 1. MADRID, MADRID",
            },
        }
        bcn_feat = {
            "type": "Feature",
            "id": "DS MOBILE NETWORKS, S.L. - 0800777",
            "geometry": {"type": "Point", "coordinates": [2.170000, 41.385000]},
            "properties": {
                "Gis_ID": "0800777",
                "Gis_Latitud": "41.385000",
                "Gis_Longitud": "2.170000",
                "Gis_Codigo": "DS MOBILE NETWORKS, S.L. - 0800777",
                "Dirección": "PS DE GRÀCIA, 10. BARCELONA, BARCELONA",
            },
        }

        def make_urlopen(include_bcn: bool, mov_extra_3500: bool):
            def _urlopen(req: object, timeout: float = 30.0) -> _FakeResp:
                url = getattr(req, "full_url", str(req))
                if "infoantenasGeoJSON.do" in url:
                    if "-3.715000" in url:
                        payload = {"type": "FeatureCollection", "features": [madrid_feat]}
                    else:
                        feats = [bcn_feat] if include_bcn else []
                        payload = {"type": "FeatureCollection", "features": feats}
                    return _FakeResp(
                        json.dumps(payload, ensure_ascii=False).encode("iso-8859-1")
                    )
                if "emplazamiento=2800006" in url:
                    extra_row = (
                        "<tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2205199</td><td>3460.00 - 3600.00</td></tr>"
                        if mov_extra_3500
                        else ""
                    )
                    html = f"""
                        <h2>CARACTERISTICAS TÉCNICAS</h2>
                        <table>
                            <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                            <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2200490</td><td>935.10 - 949.90</td></tr>
                            {extra_row}
                        </table>
                    """
                    return _FakeResp(html.encode("iso-8859-1"))
                html_digi = """
                    <h2>CARACTERISTICAS TÉCNICAS</h2>
                    <table>
                        <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                        <tr><td>DS MOBILE NETWORKS, S.L.</td><td>M M -2602235</td><td>1845.10 - 1855.10</td></tr>
                    </table>
                """
                return _FakeResp(html_digi.encode("iso-8859-1"))

            return _urlopen

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ant_path = tmp / "antenas.json"
            nov_path = tmp / "novedades.json"

            # 1) Escaneo forzado inicial (--skip-novedades): crea base limpia con 0 novedades
            with (
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=make_urlopen(include_bcn=False, mov_extra_3500=False),
                ),
                mock.patch("time.sleep", return_value=None),
            ):
                rc_base = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--delay",
                        "1.0",
                        "--fetch-bands",
                        "--rescan-since",
                        "2099-01-01T00:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--novedades-mode",
                        "reset",
                        "--skip-novedades",
                        "--scan-id",
                        "forced-baseline",
                    ]
                )
            self.assertEqual(rc_base, 0)
            nov_base = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertTrue(nov_base["isBaselineScan"])
            self.assertEqual(nov_base["total"], 0)
            self.assertEqual(nov_base["novedades"], [])

            # 2) Siguiente escaneo diario 18:00 (sin --skip-novedades):
            # detecta antena nueva DIGI 0800777 + frecuencia nueva 3460.00 - 3600.00 MHz en Movistar 2800006
            with (
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=make_urlopen(include_bcn=True, mov_extra_3500=True),
                ),
                mock.patch("time.sleep", return_value=None),
            ):
                rc_daily = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--preserve-from",
                        str(ant_path),
                        "--delay",
                        "1.0",
                        "--fetch-bands",
                        "--rescan-since",
                        "2099-01-01T00:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--novedades-mode",
                        "reset",
                        "--scan-id",
                        "daily-1800",
                    ]
                )
            self.assertEqual(rc_daily, 0)
            nov_daily = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertFalse(nov_daily["isBaselineScan"])
            self.assertEqual(nov_daily["scanId"], "daily-1800")
            self.assertEqual(nov_daily["total"], 2)
            self.assertEqual(nov_daily["antenasNuevas"], 1)
            self.assertEqual(nov_daily["frecuenciasNuevas"], 1)

            by_tipo = {n["tipo"]: n for n in nov_daily["novedades"]}
            self.assertEqual(by_tipo["antena"]["codigo"], "0800777")
            self.assertEqual(by_tipo["antena"]["ubicacion"], "BARCELONA")
            self.assertEqual(by_tipo["antena"]["codigoBanda"], "")
            self.assertEqual(by_tipo["antena"]["frecuencia"], "")
            self.assertEqual(by_tipo["frecuencia"]["codigo"], "2800006")
            self.assertEqual(by_tipo["frecuencia"]["codigoBanda"], "M M -2205199")
            self.assertEqual(
                by_tipo["frecuencia"]["frecuencia"], "3460.00 - 3600.00 MHz"
            )
            self.assertEqual(by_tipo["frecuencia"]["ubicacion"], "MADRID")
            self.assertRegex(
                by_tipo["frecuencia"]["fecha"],
                r"^\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2}$",
            )


if __name__ == "__main__":
    unittest.main()

