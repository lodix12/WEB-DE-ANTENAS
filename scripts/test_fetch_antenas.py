#!/usr/bin/env python3
"""Suite de pruebas unitarias para `scripts/fetch_antenas.py`."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import fetch_antenas as fa  # noqa: E402
import publish_scan_status as pss  # noqa: E402


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
        self.assertEqual(
            fa.OPERATOR_ORDER,
            ("movistar", "orange", "vodafone", "digi", "otros"),
        )
        self.assertNotIn("masmovil", fa.OPERATOR_NAMES)
        cases = [
            ("TELEFONICA MOVILES ESPAÑA, S.A.U.", "movistar", False),
            ("MOVISTAR INFRAESTRUCTURAS", "movistar", False),
            ("ORANGE ESPAGNE, S.A.U.", "orange", False),
            ("MASORANGE, S.L.", "orange", False),
            ("VODAFONE ESPAÑA, S.A.U.", "vodafone", False),
            ("XFERA MOVILES, S.A.U.", "orange", True),
            ("XFERA MÓVILES, S.A.U.", "orange", True),
            ("GRUPO MÁSMÓVIL TELECOM", "orange", True),
            ("YOIGO RED", "orange", True),
            ("EUSKALTEL, S.A.", "orange", True),
            ("R CABLE Y TELECOMUNICACIONES GALICIA, S.A.", "orange", True),
            ("TELECABLE DE ASTURIAS, S.A.", "orange", True),
            ("DS MOBILE NETWORKS, S.L.", "digi", False),
            ("DIGI SPAIN TELECOM, S.L.U.", "digi", False),
            ("TELEAST DIGITAL, SL", "otros", False),
            ("TRADIA TELECOM, S.A.", "otros", False),
        ]
        for raw, expected, expected_xfera in cases:
            with self.subTest(raw=raw):
                self.assertEqual(fa.classify_operator(raw), expected)
                self.assertEqual(fa.is_xfera_entity(raw), expected_xfera)

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
            (25.70, 26.70, "26 GHz"),
            (26.70, 27.10, "26 GHz"),
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

    def test_mmwave_26ghz_unification_and_legacy_label_normalization(self) -> None:
        # Las concesiones mmWave declaradas en MINETUR sin unidad GHz (25.70..27.10)
        # clasifican y se unifican en una sola entrada "26 GHz" situada tras "3500 MHz".
        self.assertEqual(fa.classify_frequency_band(25.70, 26.70), "26 GHz")
        self.assertEqual(fa.classify_frequency_band(26.70, 27.10), "26 GHz")
        self.assertEqual(fa._band_sort_key("26 GHz"), (26000.0, "26 GHz"))

        mmwave_bandas, mmwave_freqs = fa.summarize_frequency_ranges(
            [
                "25.70 - 26.70",
                "26.70 - 27.10",
                "3460.00 - 3600.00",
                "758.00 - 768.00",
            ]
        )
        self.assertEqual(mmwave_bandas, ["700 MHz", "3500 MHz", "26 GHz"])
        self.assertEqual(
            mmwave_freqs,
            [
                "25.70 - 26.70",
                "26.70 - 27.10",
                "758.00 - 768.00",
                "3460.00 - 3600.00",
            ],
        )

        # Todas las variantes históricas ("26 MHz", "27 MHz", "26MHz", "27MHz", etc.) -> "26 GHz"
        for variant in (
            "26 MHz",
            "27 MHz",
            "26MHz",
            "27MHz",
            "26 GHz",
            "27 GHz",
            "26GHz",
            "27GHz",
            " 26 mhz ",
            "27ghz",
        ):
            with self.subTest(variant=variant):
                self.assertEqual(fa.normalize_band_label(variant), "26 GHz")

        self.assertEqual(
            fa.normalize_band_labels(
                ["26 MHz", "27 MHz", "3500 MHz", "2600 MHz", "700 MHz", "27GHz"]
            ),
            ["700 MHz", "2600 MHz", "3500 MHz", "26 GHz"],
        )

        # Restauración y fusión desde JSON previos normalizan bandas heredadas a "26 GHz"
        prior_ds = {
            "antenas": [
                {
                    "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2811597",
                    "gid": "2811597",
                    "op": "movistar",
                    "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                    "lat": 40.42,
                    "lon": -3.70,
                    "dir": "CL TEST, 1",
                    "mun": "MADRID",
                    "prov": "MADRID",
                    "bandas": ["26 MHz", "1800 MHz", "3500 MHz"],
                    "frecuencias": ["25.70 - 26.70", "1805.10 - 1825.10", "3460.00 - 3600.00"],
                }
            ]
        }
        target_records = [
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2811597",
                "gid": "2811597",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.42,
                "lon": -3.70,
                "dir": "CL TEST, 1",
                "mun": "MADRID",
                "prov": "MADRID",
            }
        ]
        fa.preserve_bands_in_records(target_records, prior_ds)
        self.assertEqual(
            target_records[0]["bandas"],
            ["1800 MHz", "3500 MHz", "26 GHz"],
        )

        # Fusión Vodafone sin frecuencias declaradas explícitas también normaliza extra_bands
        voda_fused, _ = fa.fuse_vodafone_duplicates(
            [
                {
                    "id": "VODAFONE ESPAÑA, S.A.U. - 1001",
                    "gid": "1001",
                    "op": "vodafone",
                    "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                    "lat": 40.420000,
                    "lon": -3.700000,
                    "dir": "CL VODA, 1",
                    "mun": "MADRID",
                    "prov": "MADRID",
                    "bandas": ["26 MHz", "3500 MHz"],
                    "frecuencias": [],
                },
                {
                    "id": "VODAFONE ESPAÑA, S.A. - 01001",
                    "gid": "01001",
                    "op": "vodafone",
                    "opRaw": "VODAFONE ESPAÑA, S.A.",
                    "lat": 40.420050,
                    "lon": -3.700000,
                    "dir": "CL VODA, 1",
                    "mun": "MADRID",
                    "prov": "MADRID",
                    "bandas": ["27 MHz", "700 MHz"],
                    "frecuencias": [],
                },
            ]
        )
        self.assertEqual(
            voda_fused[0]["bandas"],
            ["700 MHz", "3500 MHz", "26 GHz"],
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
            # BandEnricher respeta delay_seconds sub-segundo (ej. 0.2s) sin suelo forzado de 1.0s
            enricher = fa.BandEnricher(
                delay_seconds=0.2,
                checkpoint_path=out_path,
                checkpoint_every=2,
                fail_fast=True,
                fetch_fn=fake_detalle_fetch,
                sleep_fn=clock.sleep,
                clock_fn=clock.time,
            )
            self.assertAlmostEqual(enricher.delay_seconds, 0.2)
            enricher.enrich_dataset(dataset)

            # 2800006 consultado 1 sola vez (el primero por ser compartido en MADRID)
            self.assertEqual(fetched_gids[0], "2800006")
            self.assertEqual(fetched_gids.count("2800006"), 1)
            # 5 GIDs únicos + 1 reintento transitorio en 0144693 = 6 peticiones
            self.assertEqual(enricher.requests_count, 6)
            self.assertTrue(all(s >= 0.2 for s in clock.sleeps))
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

            # Emplazamiento independiente de Xfera sin filas guarda [] y se contabiliza en Orange
            self.assertNotIn("masmovil", dataset["operators"])
            self.assertEqual(dataset["operators"]["orange"]["count"], 2)
            masm = by_id["XFERA MOVILES, S.A.U. - 4108888"]
            self.assertEqual(masm["op"], "orange")
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
                delay_seconds=1.0,
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
                delay_seconds=1.0,
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
                delay_seconds=1.0,
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
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2208888</td><td>2620.00 - 2640.00</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2209999</td><td>758.00 - 768.00</td></tr>
                    <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>OR-SHARED</td><td>832.00 - 842.00</td></tr>
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

        # Novedades de frecuencia emitidas:
        # - Antenas nuevas (2800007 con 2 frecuencias de Movistar ignorando OR-SHARED, y 0800999 con 1 de DIGI)
        #   SÍ emiten sus frecuencias escaneadas del operador.
        # - Movistar 2800006 existente emite solo su nueva frecuencia 3460.00 - 3600.00 MHz.
        # - Orange 4600111 (fría sin escaneo previo) NO genera falsos positivos.
        # - Vodafone fusionada (V-800 ya conocida en 0144693) NO genera novedad falsa.
        self.assertEqual(len(enricher.discovered_novedades), 4)
        discovered_codes = {n["codigo"] for n in enricher.discovered_novedades}
        self.assertEqual(discovered_codes, {"2800007", "0800999", "2800006"})
        self.assertNotIn("4600111", discovered_codes)
        self.assertNotIn("0144693", discovered_codes)
        self.assertNotIn("144693", discovered_codes)

        freq_nov = next(
            n for n in enricher.discovered_novedades if n["codigo"] == "2800006"
        )
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
        self.assertEqual(nov_dataset["total"], 6)
        self.assertEqual(nov_dataset["antenasNuevas"], 2)
        self.assertEqual(nov_dataset["frecuenciasNuevas"], 4)
        self.assertEqual(nov_dataset["previousScanAt"], "2026-11-15T17:30:00Z")
        # Orden agrupado: cada antena nueva seguida inmediatamente de sus frecuencias asociadas (ordenadas por MHz),
        # y al final las frecuencias nuevas de antenas ya existentes (Movistar 2800006).
        self.assertEqual(
            [
                (n["tipo"], n["codigo"], n["frecuencia"])
                for n in nov_dataset["novedades"]
            ],
            [
                ("antena", "0800999", ""),
                ("frecuencia", "0800999", "1845.10 - 1855.10 MHz"),
                ("antena", "2800007", ""),
                ("frecuencia", "2800007", "758.00 - 768.00 MHz"),
                ("frecuencia", "2800007", "2620.00 - 2640.00 MHz"),
                ("frecuencia", "2800006", "3460.00 - 3600.00 MHz"),
            ],
        )

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
            self.assertEqual(nov_doc_1["frecuenciasNuevas"], 2)  # DG-1 (de nueva 9000001) + OR-NEW-3
            self.assertEqual(nov_doc_1["total"], 3)
            self.assertEqual(
                [(n["tipo"], n["codigo"]) for n in nov_doc_1["novedades"]],
                [
                    ("antena", "9000001"),
                    ("frecuencia", "9000001"),
                    ("frecuencia", "9000003"),
                ],
            )

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
            self.assertEqual(
                nov_doc_2["frecuenciasNuevas"], 3
            )  # DG-1 (de nueva 9000001) + OR-NEW-3 + OR-NEW-4
            self.assertEqual(nov_doc_2["total"], 4)
            self.assertEqual(
                [(n["tipo"], n["codigo"]) for n in nov_doc_2["novedades"]],
                [
                    ("antena", "9000001"),
                    ("frecuencia", "9000001"),
                    ("frecuencia", "9000004"),
                    ("frecuencia", "9000003"),
                ],
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
            # detecta antena nueva DIGI 0800777 seguida de su frecuencia asociada 1845.10 - 1855.10 MHz,
            # y después la frecuencia nueva 3460.00 - 3600.00 MHz en Movistar 2800006 existente.
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
            self.assertEqual(nov_daily["total"], 3)
            self.assertEqual(nov_daily["antenasNuevas"], 1)
            self.assertEqual(nov_daily["frecuenciasNuevas"], 2)

            items = nov_daily["novedades"]
            self.assertEqual(len(items), 3)
            self.assertEqual(items[0]["tipo"], "antena")
            self.assertEqual(items[0]["codigo"], "0800777")
            self.assertEqual(items[0]["ubicacion"], "BARCELONA")
            self.assertEqual(items[0]["codigoBanda"], "")
            self.assertEqual(items[0]["frecuencia"], "")

            self.assertEqual(items[1]["tipo"], "frecuencia")
            self.assertEqual(items[1]["codigo"], "0800777")
            self.assertEqual(items[1]["codigoBanda"], "M M -2602235")
            self.assertEqual(items[1]["frecuencia"], "1845.10 - 1855.10 MHz")
            self.assertEqual(items[1]["ubicacion"], "BARCELONA")

            self.assertEqual(items[2]["tipo"], "frecuencia")
            self.assertEqual(items[2]["codigo"], "2800006")
            self.assertEqual(items[2]["codigoBanda"], "M M -2205199")
            self.assertEqual(items[2]["frecuencia"], "3460.00 - 3600.00 MHz")
            self.assertEqual(items[2]["ubicacion"], "MADRID")
            self.assertRegex(
                items[2]["fecha"],
                r"^\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2}$",
            )

    def test_build_scan_status_payload_and_cli_status_output(self) -> None:
        # 1) Fase de censo (0% -> 0.39%)
        censo_zero = fa.build_scan_status_payload(
            state="running",
            scan_id="run-100",
            trigger="schedule",
            record_novedades=True,
            part="1/4",
            phase="censo",
            started_at="2026-04-06T16:00:00Z",
            total_antennas=62230,
            scanned_antennas=0,
            census_boxes_visited=0,
            discovered_antennas=0,
            updated_at="2026-04-06T16:00:02Z",
        )
        self.assertEqual(censo_zero["percent"], 0.0)
        self.assertEqual(censo_zero["trigger"], "schedule")
        self.assertTrue(censo_zero["recordNovedades"])

        censo_mid = fa.build_scan_status_payload(
            state="running",
            scan_id="run-100",
            trigger="schedule",
            record_novedades=True,
            part="1/4",
            phase="censo",
            started_at="2026-04-06T16:00:00Z",
            total_antennas=62230,
            scanned_antennas=0,
            census_boxes_visited=120,
            discovered_antennas=31000,
            updated_at="2026-04-06T16:02:00Z",
        )
        self.assertGreater(censo_mid["percent"], 0.15)
        self.assertLessEqual(censo_mid["percent"], 0.39)

        # 2) Fase de frecuencias (monótona desde >= 0.40% en parte 1/4 hasta 100%)
        freq_start = fa.build_scan_status_payload(
            state="running",
            scan_id="run-100",
            trigger="workflow_dispatch",
            record_novedades=False,
            part="1/4",
            phase="frecuencias",
            started_at="2026-04-06T16:00:00Z",
            total_antennas=62230,
            scanned_antennas=10,
            updated_at="2026-04-06T16:04:15Z",
        )
        self.assertEqual(freq_start["percent"], 0.40)
        self.assertFalse(freq_start["recordNovedades"])

        freq_half = fa.build_scan_status_payload(
            state="running",
            scan_id="run-100",
            trigger="workflow_dispatch",
            record_novedades=False,
            part="2/4",
            phase="frecuencias",
            started_at="2026-04-06T16:00:00Z",
            total_antennas=62230,
            scanned_antennas=31115,
            updated_at="2026-04-06T21:30:00Z",
        )
        self.assertEqual(freq_half["percent"], 50.0)

        freq_done = fa.build_scan_status_payload(
            state="completed",
            scan_id="run-100",
            trigger="schedule",
            record_novedades=True,
            part="4/4",
            phase="frecuencias",
            started_at="2026-04-06T16:00:00Z",
            total_antennas=62230,
            scanned_antennas=62230,
            updated_at="2026-04-07T08:00:00Z",
        )
        self.assertEqual(freq_done["percent"], 100.0)
        self.assertEqual(freq_done["scannedAntennas"], 62230)

        # 3) Emisión real desde CLI con --status-output
        class _FakeResp:
            def __init__(self, payload: bytes) -> None:
                self._payload = payload

            def read(self) -> bytes:
                return self._payload

            def __enter__(self) -> "_FakeResp":
                return self

            def __exit__(self, *args: object) -> None:
                return None

        def _fake_urlopen(req: object, timeout: float = 30.0) -> _FakeResp:
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if "infoantenasGeoJSON" in url:
                fc = {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "geometry": {
                                "type": "Point",
                                "coordinates": [-3.642914, 40.434322],
                            },
                            "properties": {
                                "Gis_ID": "2800006",
                                "Operador": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                                "Direccion": "CL EMILIO FERRARI, 11. MADRID, MADRID",
                            },
                        }
                    ],
                }
                return _FakeResp(json.dumps(fc).encode("utf-8"))
            html = """
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table>
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2200490</td><td>935.10 - 949.90</td></tr>
                </table>
            """
            return _FakeResp(html.encode("iso-8859-1"))

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ant_path = tmp / "antenas.json"
            status_path = tmp / "scan-status.json"
            with (
                mock.patch("urllib.request.urlopen", side_effect=_fake_urlopen),
                mock.patch("time.sleep", return_value=None),
            ):
                rc = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--delay",
                        "1.0",
                        "--fetch-bands",
                        "--scan-id",
                        "live-test-1",
                        "--scan-trigger",
                        "workflow_dispatch",
                        "--scan-part",
                        "1/4",
                        "--skip-novedades",
                        "--status-output",
                        str(status_path),
                    ]
                )
            self.assertEqual(rc, 0)
            self.assertTrue(status_path.exists())
            status_doc = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(status_doc["state"], "completed")
            self.assertEqual(status_doc["scanId"], "live-test-1")
            self.assertEqual(status_doc["trigger"], "workflow_dispatch")
            self.assertFalse(status_doc["recordNovedades"])
            self.assertEqual(status_doc["scannedAntennas"], 1)
            self.assertEqual(status_doc["totalAntennas"], 1)
            self.assertEqual(status_doc["percent"], 100.0)
            self.assertEqual(status_doc["schemaVersion"], 2)
            self.assertIn("completedDatasetUpdatedAt", status_doc)

    def test_keepalive_http_client_socket_reuse_gzip_reconnect_and_429_cooldown(self) -> None:
        seen_client_ports: list[int] = []
        drop_state = {"dropped_once": False}
        lock = threading.Lock()

        html_sample = """
            <h2>CARACTERISTICAS TÉCNICAS</h2>
            <table>
                <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2200490</td><td>935.10 - 949.90</td></tr>
            </table>
        """.encode("iso-8859-1")
        gz_html = gzip.compress(html_sample)

        class _KeepAliveHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return None

            def do_GET(self) -> None:  # noqa: N802
                with lock:
                    seen_client_ports.append(int(self.client_address[1]))

                if self.path == "/ok-gzip":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=ISO-8859-1")
                    self.send_header("Content-Encoding", "gzip")
                    self.send_header("Content-Length", str(len(gz_html)))
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    self.wfile.write(gz_html)
                    return

                if self.path == "/ok-plain":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=ISO-8859-1")
                    self.send_header("Content-Length", str(len(html_sample)))
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    self.wfile.write(html_sample)
                    return

                if self.path == "/drop-once":
                    with lock:
                        should_drop = not drop_state["dropped_once"]
                        drop_state["dropped_once"] = True
                    if should_drop:
                        # Simula cierre abrupto de socket Keep-Alive reutilizado en el servidor
                        self.close_connection = True
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=ISO-8859-1")
                    self.send_header("Content-Length", str(len(html_sample)))
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    self.wfile.write(html_sample)
                    return

                if self.path == "/rate-limit":
                    body = b"Too Many Requests"
                    self.send_response(429)
                    self.send_header("Retry-After", "1.5")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    self.wfile.write(body)
                    return

                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), _KeepAliveHandler)
        port = server.server_address[1]
        srv_thread = threading.Thread(target=server.serve_forever, daemon=True)
        srv_thread.start()
        client = fa._ThreadLocalKeepAliveClient()

        try:
            b1 = client.fetch_bytes(
                f"http://127.0.0.1:{port}/ok-gzip",
                headers={"User-Agent": "TestKeepAlive/1.0"},
                timeout=5.0,
            )
            parsed1 = fa.parse_detalle_estacion_html(fa.decode_detalle_estacion_payload(b1))
            self.assertEqual(len(parsed1), 1)
            self.assertEqual(parsed1[0]["referencia"], "M M -2200490")

            b2 = client.fetch_bytes(
                f"http://127.0.0.1:{port}/ok-plain",
                headers={"User-Agent": "TestKeepAlive/1.0"},
                timeout=5.0,
            )
            self.assertIn("CARACTERISTICAS TÉCNICAS", fa.decode_detalle_estacion_payload(b2))
            # Ambas peticiones reutilizan exactamente el mismo socket TCP efímero
            self.assertEqual(seen_client_ports[0], seen_client_ports[1])

            # Si el servidor corta el socket Keep-Alive reutilizado, se reconecta de forma transparente
            b3 = client.fetch_bytes(
                f"http://127.0.0.1:{port}/drop-once",
                headers={"User-Agent": "TestKeepAlive/1.0"},
                timeout=5.0,
            )
            self.assertIn("935.10 - 949.90", fa.decode_detalle_estacion_payload(b3))
            self.assertEqual(len(seen_client_ports), 4)
            self.assertEqual(seen_client_ports[2], seen_client_ports[0])
            self.assertNotEqual(seen_client_ports[3], seen_client_ports[0])

            # HTTP 429 registra enfriamiento adaptativo compartido y propaga HTTPError
            fake_clock = FakeClock()
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                client.fetch_bytes(
                    f"http://127.0.0.1:{port}/rate-limit",
                    headers={"User-Agent": "TestKeepAlive/1.0"},
                    timeout=5.0,
                    clock_fn=fake_clock.time,
                )
            ctx.exception.close()
            self.assertEqual(ctx.exception.code, 429)
            client.wait_if_cooled_down(clock_fn=fake_clock.time, sleep_fn=fake_clock.sleep)
            self.assertEqual(fake_clock.sleeps, [1.5])
        finally:
            client.close_all()
            server.shutdown()
            server.server_close()
            srv_thread.join(timeout=3.0)

    def test_parallel_multi_worker_census_and_band_enrichment_speedup_and_fusion_invariants(self) -> None:
        # 1) Censo paralelo (workers=8) con subdivisión quadtree (>= 450) + invariantes de fusión:
        #    - 2 declaraciones Vodafone a ~14 m se fusionan en 1 antena con mergedGids
        #    - 2 declaraciones Telefónica a ~10 m NUNCA se fusionan
        def _feat(gid: str, op_label: str, lat: float, lon: float, mun: str = "MADRID") -> dict[str, object]:
            return {
                "type": "Feature",
                "id": f"{op_label} - {gid}",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "Gis_ID": gid,
                    "Gis_Codigo": f"{op_label} - {gid}",
                    "Dirección": f"CL PRUEBA, 1. {mun}, MADRID",
                },
            }

        capped_parent_features = [
            _feat(f"287{i:04d}", "ORANGE ESPAGNE, S.A.U.", 40.40 + (i % 20) * 0.002, -3.70 + (i // 20) * 0.002)
            for i in range(fa.SERVER_FEATURE_CAP)
        ]

        def parallel_bbox_fetch(bbox: fa.BBox, _zoom: int) -> list[dict[str, object]]:
            min_lon, min_lat, max_lon, max_lat = bbox
            span_lon = max_lon - min_lon
            # Solo la celda raíz (span_lon ~1.39°) que contiene Madrid centro (-3.70, 40.42) dispara subdivisión
            if min_lon <= -3.70 < max_lon and min_lat <= 40.42 < max_lat:
                if span_lon > 1.0:
                    return capped_parent_features
                # Hijos subdivididos devuelven los registros finales incluyendo Vodafone <35m y Telefónica <35m
                return [
                    _feat("144693", "VODAFONE ESPAÑA, S.A.U.", 40.420000, -3.700000),
                    _feat("0144693", "VODAFONE ESPAÑA, S.A.U.", 40.420100, -3.700000),  # ~11.1 m (< 35m -> fusiona)
                    _feat("2890001", "TELEFONICA MOVILES ESPAÑA, S.A.U.", 40.421000, -3.700000),
                    _feat("2890002", "TELEFONICA MOVILES ESPAÑA, S.A.U.", 40.421080, -3.700000),  # ~8.9 m (Telefónica -> NO fusiona)
                ]
            return []

        crawler = fa.InfoantenasCrawler(
            delay_seconds=0.0,
            workers=8,
            fetch_fn=parallel_bbox_fetch,
        )
        census_ds = crawler.crawl(region="all")
        self.assertGreaterEqual(census_ds["crawlStats"]["subdividedBoxes"], 1)
        self.assertEqual(census_ds["crawlStats"]["vodafoneFusedDuplicates"], 1)
        census_by_id = {a["id"]: a for a in census_ds["antenas"]}
        self.assertIn("VODAFONE ESPAÑA, S.A.U. - 144693", census_by_id)
        self.assertNotIn("VODAFONE ESPAÑA, S.A.U. - 0144693", census_by_id)
        self.assertEqual(
            census_by_id["VODAFONE ESPAÑA, S.A.U. - 144693"]["mergedGids"],
            ["144693", "0144693"],
        )
        # Telefónica a < 35 m se conserva íntegra como 2 antenas independientes
        self.assertIn("TELEFONICA MOVILES ESPAÑA, S.A.U. - 2890001", census_by_id)
        self.assertIn("TELEFONICA MOVILES ESPAÑA, S.A.U. - 2890002", census_by_id)

        # 2) Aceleración real > 5x en enriquecimiento paralelo de bandas (workers=16 sobre 32 GIDs con latencia 0.04s)
        #    Tiempo secuencial equivalente = 32 * 0.04s = 1.28s; en paralelo con 16 hilos debe tardar < 0.25s (> 5.1x más rápido).
        bench_records: list[dict[str, object]] = [
            {
                "id": "VODAFONE ESPAÑA, S.A.U. - 144693",
                "gid": "144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": 40.420000,
                "lon": -3.700000,
                "dir": "CL ALCALA, 1",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "VODAFONE ESPAÑA, S.A.U. - 0144693",
                "gid": "0144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": 40.420100,
                "lon": -3.700000,
                "dir": "CL ALCALA, 1",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                "gid": "2800006",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.430000,
                "lon": -3.650000,
                "dir": "CL EMILIO FERRARI, 11",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "DS MOBILE NETWORKS, S.L. - 2800006",
                "gid": "2800006",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "lat": 40.430000,
                "lon": -3.650000,
                "dir": "CL EMILIO FERRARI, 11",
                "mun": "MADRID",
                "prov": "MADRID",
            },
        ]
        for idx in range(29):
            gid = f"285{idx:04d}"
            bench_records.append(
                {
                    "id": f"TELEFONICA MOVILES ESPAÑA, S.A.U. - {gid}",
                    "gid": gid,
                    "op": "movistar",
                    "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                    "lat": 40.30 + idx * 0.005,
                    "lon": -3.70,
                    "dir": f"AV PARALELA, {idx}",
                    "mun": "MADRID",
                    "prov": "MADRID",
                }
            )

        bench_ds = fa.build_dataset(
            bench_records,
            crawl_stats={
                "requestsCount": 1,
                "durationSeconds": 0.1,
                "gridBoxesVisited": 1,
                "subdividedBoxes": 0,
                "zoomParam": 7,
                "delaySeconds": 0.0,
            },
        )
        # 1 fusionada Vodafone + 2 en 2800006 + 29 individuales = 32 antenas y 32 GIDs únicos (144693, 0144693, 2800006 + 29)
        self.assertEqual(bench_ds["total"], 32)

        def simulated_network_detalle(gid: str) -> str:
            time.sleep(0.04)
            if gid == "144693":
                return """
                    <h2>CARACTERISTICAS TÉCNICAS</h2>
                    <table>
                        <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                        <tr><td>VODAFONE ESPAÑA, S.A.U.</td><td>V1</td><td>842.00 - 852.00</td></tr>
                    </table>
                """
            if gid == "0144693":
                return """
                    <h2>CARACTERISTICAS TÉCNICAS</h2>
                    <table>
                        <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                        <tr><td>VODAFONE ESPAÑA, S.A.U.</td><td>V2</td><td>3600.00 - 3690.00</td></tr>
                    </table>
                """
            if gid == "2800006":
                return """
                    <h2>CARACTERISTICAS TÉCNICAS</h2>
                    <table>
                        <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                        <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M1</td><td>935.10 - 949.90</td></tr>
                        <tr><td>DS MOBILE NETWORKS, S.L.</td><td>D1</td><td>2110.00 - 2120.00</td></tr>
                    </table>
                """
            return f"""
                <h2>CARACTERISTICAS TÉCNICAS</h2>
                <table>
                    <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                    <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>REF-{gid}</td><td>1805.10 - 1825.10</td></tr>
                </table>
            """

        sequential_equivalent_s = 32 * 0.04  # 1.28s
        t0 = time.monotonic()
        enricher = fa.BandEnricher(
            delay_seconds=0.0,
            workers=16,
            fetch_fn=simulated_network_detalle,
        )
        enricher.enrich_dataset(bench_ds)
        elapsed_s = time.monotonic() - t0

        self.assertEqual(enricher.requests_count, 32)
        self.assertEqual(bench_ds["crawlStats"]["bandsPopulatedCount"], 32)
        speedup = sequential_equivalent_s / max(0.001, elapsed_s)
        self.assertGreater(
            speedup,
            5.0,
            f"Se esperaba aceleración paralela > 5x, obtenida {speedup:.2f}x (elapsed={elapsed_s:.3f}s)",
        )

        by_id = {a["id"]: a for a in bench_ds["antenas"]}
        self.assertEqual(
            by_id["VODAFONE ESPAÑA, S.A.U. - 144693"]["bandas"],
            ["800 MHz", "3500 MHz"],
        )
        self.assertEqual(
            by_id["TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006"]["bandas"],
            ["900 MHz"],
        )
        self.assertEqual(
            by_id["DS MOBILE NETWORKS, S.L. - 2800006"]["bandas"],
            ["2100 MHz"],
        )

    def test_live_delta_stream_writer_chunking_reconciliation_skip_novedades_and_append(self) -> None:
        # 1) Prueba unitaria directa de LiveDeltaStreamWriter con chunk_capacity=2 y reconciliación post-censo
        with tempfile.TemporaryDirectory() as tmpdir:
            live_dir = Path(tmpdir) / "live-unit"
            writer = fa.LiveDeltaStreamWriter(
                live_dir,
                scan_id="scan-live-1",
                mode="reset",
                record_novedades=True,
                previous_scan_at="2026-11-15T18:00:00Z",
                chunk_capacity=2,
                flush_interval_seconds=0.0,
            )
            # Emisión provisional durante el censo (sin mergedGids aún)
            prov_ant = {
                "id": "VODAFONE ESPAÑA, S.A.U. - 144693",
                "gid": "144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "lat": 40.42,
                "lon": -3.70,
                "dir": "CL ALCALA, 1",
                "mun": "MADRID",
                "prov": "MADRID",
            }
            writer.record_provisional_new_antennas(
                [prov_ant],
                [
                    {
                        "id": "ant:VODAFONE ESPAÑA, S.A.U. - 144693",
                        "tipo": "antena",
                        "op": "vodafone",
                        "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                        "codigo": "144693",
                        "antennaId": "VODAFONE ESPAÑA, S.A.U. - 144693",
                        "codigoBanda": "",
                        "frecuencia": "",
                        "ubicacion": "MADRID",
                        "prov": "MADRID",
                        "scannedAt": "2026-11-16T18:00:01Z",
                        "fecha": "16/11/2026 19:00:01",
                    }
                ],
            )
            # Con chunk_capacity=2 (1 antena + 1 novedad = 2 ítems), se sella live-chunk-0.json
            self.assertEqual(writer.chunk_count, 1)
            self.assertTrue((live_dir / "live-chunk-0.json").exists())

            # Reconciliación post-fusión Vodafone (< 35m) emite replacesNewAntennas=True con mergedGids
            canon_ant = {**prov_ant, "mergedGids": ["144693", "0144693"]}
            writer.reconcile_post_census_new_antennas(
                [canon_ant],
                [
                    {
                        "id": "ant:VODAFONE ESPAÑA, S.A.U. - 144693",
                        "tipo": "antena",
                        "op": "vodafone",
                        "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                        "codigo": "144693",
                        "antennaId": "VODAFONE ESPAÑA, S.A.U. - 144693",
                        "codigoBanda": "",
                        "frecuencia": "",
                        "ubicacion": "MADRID",
                        "prov": "MADRID",
                        "scannedAt": "2026-11-16T18:00:02Z",
                        "fecha": "16/11/2026 19:00:02",
                    }
                ],
            )
            self.assertEqual(writer.chunk_count, 2)
            chunk1 = json.loads((live_dir / "live-chunk-1.json").read_text(encoding="utf-8"))
            self.assertTrue(chunk1["replacesNewAntennas"])
            self.assertEqual(chunk1["newAntennas"][0]["mergedGids"], ["144693", "0144693"])
            self.assertEqual(writer.total_new_antennas, 1)

            # Parche RF posterior va a live-tail.json sin perder los chunks previos
            writer.record_band_updates(
                [
                    {
                        "id": "VODAFONE ESPAÑA, S.A.U. - 144693",
                        "gid": "144693",
                        "mergedGids": ["144693", "0144693"],
                        "bandas": ["800 MHz", "3500 MHz"],
                        "frecuencias": ["842.00 - 852.00", "3600.00 - 3690.00"],
                        "concesiones": [{"ref": "V1", "range": "842.00 - 852.00", "banda": "800 MHz"}],
                        "bandsScannedAt": "2026-11-16T18:00:05Z",
                    }
                ],
                [],
                force_flush=True,
            )
            tail_doc = json.loads((live_dir / "live-tail.json").read_text(encoding="utf-8"))
            self.assertTrue(tail_doc["isTail"])
            self.assertEqual(tail_doc["chunkIndex"], 2)
            self.assertEqual(len(tail_doc["bandPatches"]), 1)
            self.assertEqual(writer.total_updated_antennas, 1)

        # 2) Prueba CLI end-to-end: --skip-novedades vs normal + continuación --live-mode append
        class _FakeResp:
            def __init__(self, payload: bytes) -> None:
                self._payload = payload

            def read(self) -> bytes:
                return self._payload

            def __enter__(self) -> "_FakeResp":
                return self

            def __exit__(self, *args: object) -> None:
                return None

        def make_cli_urlopen(*, add_new_voda_pair: bool, upgrade_mov_3500: bool):
            def _urlopen(req: object, timeout: float = 30.0) -> _FakeResp:
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if "infoantenasGeoJSON" in url:
                    feats = [
                        {
                            "type": "Feature",
                            "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                            "geometry": {"type": "Point", "coordinates": [-3.642914, 40.434322]},
                            "properties": {
                                "Gis_ID": "2800006",
                                "Gis_Codigo": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800006",
                                "Dirección": "CL EMILIO FERRARI, 11. MADRID, MADRID",
                            },
                        }
                    ]
                    if add_new_voda_pair and "-3.7" in url:
                        feats.extend(
                            [
                                {
                                    "type": "Feature",
                                    "id": "VODAFONE ESPAÑA, S.A.U. - 144693",
                                    "geometry": {"type": "Point", "coordinates": [-3.700000, 40.420000]},
                                    "properties": {
                                        "Gis_ID": "144693",
                                        "Gis_Codigo": "VODAFONE ESPAÑA, S.A.U. - 144693",
                                        "Dirección": "CL ALCALA, 1. MADRID, MADRID",
                                    },
                                },
                                {
                                    "type": "Feature",
                                    "id": "VODAFONE ESPAÑA, S.A.U. - 0144693",
                                    "geometry": {"type": "Point", "coordinates": [-3.700000, 40.420090]},
                                    "properties": {
                                        "Gis_ID": "0144693",
                                        "Gis_Codigo": "VODAFONE ESPAÑA, S.A.U. - 0144693",
                                        "Dirección": "CL ALCALA, 1. MADRID, MADRID",
                                    },
                                },
                            ]
                        )
                    return _FakeResp(json.dumps({"type": "FeatureCollection", "features": feats}).encode("utf-8"))

                if "emplazamiento=2800006" in url:
                    extra = (
                        "<tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2205199</td><td>3460.00 - 3600.00</td></tr>"
                        if upgrade_mov_3500
                        else ""
                    )
                    html = f"""
                        <h2>CARACTERISTICAS TÉCNICAS</h2>
                        <table>
                            <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                            <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2200490</td><td>935.10 - 949.90</td></tr>
                            {extra}
                        </table>
                    """
                    return _FakeResp(html.encode("iso-8859-1"))

                if "emplazamiento=0144693" in url:
                    html_voda_3500 = """
                        <h2>CARACTERISTICAS TÉCNICAS</h2>
                        <table>
                            <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                            <tr><td>VODAFONE ESPAÑA, S.A.U.</td><td>V-3500</td><td>3600.00 - 3690.00</td></tr>
                        </table>
                    """
                    return _FakeResp(html_voda_3500.encode("iso-8859-1"))

                html_voda_800 = """
                    <h2>CARACTERISTICAS TÉCNICAS</h2>
                    <table>
                        <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                        <tr><td>VODAFONE ESPAÑA, S.A.U.</td><td>V-800</td><td>842.00 - 852.00</td></tr>
                    </table>
                """
                return _FakeResp(html_voda_800.encode("iso-8859-1"))

            return _urlopen

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ant_path = tmp / "antenas.json"
            nov_path = tmp / "novedades.json"
            live_dir = tmp / "scan-live"
            status_path = live_dir / "scan-status.json"

            # Paso A: Línea base inicial con --skip-novedades
            with mock.patch(
                "urllib.request.urlopen",
                side_effect=make_cli_urlopen(add_new_voda_pair=False, upgrade_mov_3500=False),
            ):
                rc0 = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--delay",
                        "0.0",
                        "--workers",
                        "4",
                        "--census-workers",
                        "2",
                        "--fetch-bands",
                        "--skip-novedades",
                        "--scan-id",
                        "base-0",
                        "--novedades-output",
                        str(nov_path),
                        "--live-dir",
                        str(live_dir),
                        "--status-output",
                        str(status_path),
                    ]
                )
            self.assertEqual(rc0, 0)
            st0 = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(st0["liveNovedadesCount"], 0)
            self.assertGreaterEqual(st0["liveUpdatedAntennasCount"], 1)
            tail0 = json.loads((live_dir / "live-tail.json").read_text(encoding="utf-8"))
            self.assertEqual(tail0["novedades"], [])
            self.assertEqual(len(tail0["bandPatches"]), 1)

            # Paso B: Escaneo forzado CON --skip-novedades cuando entra una antena nueva + banda nueva:
            # el mapa recibe newAntennas y bandPatches en vivo, pero novedades permanece vacío ([]).
            ant_skip_copy = tmp / "antenas_skip.json"
            ant_skip_copy.write_bytes(ant_path.read_bytes())
            live_skip_dir = tmp / "scan-live-skip"
            status_skip_path = live_skip_dir / "scan-status.json"
            with mock.patch(
                "urllib.request.urlopen",
                side_effect=make_cli_urlopen(add_new_voda_pair=True, upgrade_mov_3500=True),
            ):
                rc_skip = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_skip_copy),
                        "--preserve-from",
                        str(ant_skip_copy),
                        "--delay",
                        "0.0",
                        "--workers",
                        "4",
                        "--census-workers",
                        "2",
                        "--fetch-bands",
                        "--rescan-since",
                        "2099-01-01T00:00:00Z",
                        "--skip-novedades",
                        "--scan-id",
                        "forced-skip-1",
                        "--live-dir",
                        str(live_skip_dir),
                        "--status-output",
                        str(status_skip_path),
                    ]
                )
            self.assertEqual(rc_skip, 0)
            st_skip = json.loads(status_skip_path.read_text(encoding="utf-8"))
            self.assertFalse(st_skip["recordNovedades"])
            self.assertEqual(st_skip["liveNewAntennasCount"], 1)
            self.assertEqual(st_skip["liveUpdatedAntennasCount"], 2)
            self.assertEqual(st_skip["liveNovedadesCount"], 0)
            tail_skip = json.loads((live_skip_dir / "live-tail.json").read_text(encoding="utf-8"))
            self.assertEqual(tail_skip["novedades"], [])
            self.assertEqual(len(tail_skip["newAntennas"]), 1)
            self.assertEqual(tail_skip["newAntennas"][0]["mergedGids"], ["144693", "0144693"])
            self.assertEqual(len(tail_skip["bandPatches"]), 2)

            # Paso C: Escaneo diario (Parte 1/2 limitada a --max-band-requests 2 para Vodafone fusionada,
            # seguida de Parte 2/2 con --enrich-bands-only y --live-mode append para Movistar 2800006)
            base_ds = json.loads(ant_path.read_text(encoding="utf-8"))
            for a_rec in base_ds["antenas"]:
                a_rec["bandsScannedAt"] = "2000-01-01T00:00:00Z"
            ant_path.write_text(json.dumps(base_ds), encoding="utf-8")

            with mock.patch(
                "urllib.request.urlopen",
                side_effect=make_cli_urlopen(add_new_voda_pair=True, upgrade_mov_3500=True),
            ):
                rc_p1 = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--preserve-from",
                        str(ant_path),
                        "--delay",
                        "0.0",
                        "--workers",
                        "2",
                        "--census-workers",
                        "2",
                        "--fetch-bands",
                        "--max-band-requests",
                        "2",
                        "--rescan-since",
                        "2020-01-01T00:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--novedades-mode",
                        "reset",
                        "--scan-id",
                        "daily-2part",
                        "--scan-part",
                        "1/2",
                        "--live-dir",
                        str(live_dir),
                        "--live-mode",
                        "reset",
                        "--status-output",
                        str(status_path),
                    ]
                )
            self.assertEqual(rc_p1, 0)
            st_p1 = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(st_p1["state"], "running")
            self.assertEqual(st_p1["scannedAntennas"], 1)
            self.assertEqual(st_p1["totalAntennas"], 2)
            seq_after_p1 = st_p1["deltaSeq"]
            self.assertGreater(seq_after_p1, 0)

            with mock.patch(
                "urllib.request.urlopen",
                side_effect=make_cli_urlopen(add_new_voda_pair=True, upgrade_mov_3500=True),
            ):
                rc_p2 = fa.main(
                    [
                        "--enrich-bands-only",
                        "--input",
                        str(ant_path),
                        "--output",
                        str(ant_path),
                        "--delay",
                        "0.0",
                        "--workers",
                        "2",
                        "--rescan-since",
                        "2020-01-01T00:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--novedades-mode",
                        "append",
                        "--scan-id",
                        "daily-2part",
                        "--scan-part",
                        "2/2",
                        "--live-dir",
                        str(live_dir),
                        "--live-mode",
                        "append",
                        "--status-output",
                        str(status_path),
                    ]
                )
            self.assertEqual(rc_p2, 0)
            st_p2 = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(st_p2["state"], "completed")
            self.assertGreater(st_p2["deltaSeq"], seq_after_p1)
            self.assertEqual(st_p2["liveNewAntennasCount"], 1)
            self.assertEqual(st_p2["liveUpdatedAntennasCount"], 2)
            # 1 antena nueva Vodafone + sus 2 frecuencias asociadas + 1 frecuencia nueva en Movistar 2800006 existente = 4
            self.assertEqual(st_p2["liveNovedadesCount"], 4)
            final_ds = json.loads(ant_path.read_text(encoding="utf-8"))
            self.assertEqual(st_p2["completedDatasetUpdatedAt"], final_ds["updatedAt"])

            nov_p2 = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertEqual(nov_p2["total"], 4)
            self.assertEqual(nov_p2["antenasNuevas"], 1)
            self.assertEqual(nov_p2["frecuenciasNuevas"], 3)
            self.assertEqual(
                [
                    (n["tipo"], n["op"], n["codigo"], n["frecuencia"])
                    for n in nov_p2["novedades"]
                ],
                [
                    ("antena", "vodafone", "144693", ""),
                    ("frecuencia", "vodafone", "144693", "842.00 - 852.00 MHz"),
                    ("frecuencia", "vodafone", "144693", "3600.00 - 3690.00 MHz"),
                    ("frecuencia", "movistar", "2800006", "3460.00 - 3600.00 MHz"),
                ],
            )

    def test_sort_novedades_grouped_interleaves_each_new_antenna_with_its_frequencies_before_existing(
        self,
    ) -> None:
        scrambled: list[dict[str, object]] = [
            # Frecuencias de antenas ya existentes (incluso con marca temporal más reciente que las nuevas)
            {
                "id": "freq:EXIST-1:M2:3460.00 - 3600.00",
                "tipo": "frecuencia",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "codigo": "4100500",
                "antennaId": "EXIST-1",
                "codigoBanda": "M2",
                "frecuencia": "3460.00 - 3600.00 MHz",
                "ubicacion": "SEVILLA",
                "prov": "SEVILLA",
                "scannedAt": "2026-11-16T18:25:00Z",
                "fecha": "16/11/2026 19:25:00",
            },
            {
                "id": "freq:EXIST-2:OR1:1805.10 - 1825.10",
                "tipo": "frecuencia",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "codigo": "4600600",
                "antennaId": "",  # Prueba respaldo de clave op::codigo cuando antennaId está vacío
                "codigoBanda": "OR1",
                "frecuencia": "1805.10 - 1825.10 MHz",
                "ubicacion": "VALENCIA",
                "prov": "VALENCIA",
                "scannedAt": "2026-11-16T18:20:00Z",
                "fecha": "16/11/2026 19:20:00",
            },
            {
                "id": "freq:EXIST-1:M1:935.10 - 949.90",
                "tipo": "frecuencia",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "codigo": "4100500",
                "antennaId": "EXIST-1",
                "codigoBanda": "M1",
                "frecuencia": "935.10 - 949.90 MHz",
                "ubicacion": "SEVILLA",
                "prov": "SEVILLA",
                "scannedAt": "2026-11-16T18:25:00Z",
                "fecha": "16/11/2026 19:25:00",
            },
            # Frecuencias desordenadas de Antena Nueva A (incluye 26 GHz para verificar * 1000 MHz)
            {
                "id": "freq:NEW-A:D3:26.50 - 27.50 GHz",
                "tipo": "frecuencia",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "codigo": "0800100",
                "antennaId": "NEW-A",
                "codigoBanda": "D3",
                "frecuencia": "26.50 - 27.50 GHz",
                "ubicacion": "BARCELONA",
                "prov": "BARCELONA",
                "scannedAt": "2026-11-16T18:10:00Z",
                "fecha": "16/11/2026 19:10:00",
            },
            {
                "id": "freq:NEW-B:V2:3600.00 - 3690.00",
                "tipo": "frecuencia",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "codigo": "2800200",
                "antennaId": "NEW-B",
                "codigoBanda": "V2",
                "frecuencia": "3600.00 - 3690.00 MHz",
                "ubicacion": "MADRID",
                "prov": "MADRID",
                "scannedAt": "2026-11-16T18:08:00Z",
                "fecha": "16/11/2026 19:08:00",
            },
            # Antena Nueva B (escaneada a las 18:01Z -> va después de Antena Nueva A de las 18:05Z)
            {
                "id": "ant:NEW-B",
                "tipo": "antena",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "codigo": "2800200",
                "antennaId": "NEW-B",
                "codigoBanda": "",
                "frecuencia": "",
                "ubicacion": "MADRID",
                "prov": "MADRID",
                "scannedAt": "2026-11-16T18:01:00Z",
                "fecha": "16/11/2026 19:01:00",
            },
            {
                "id": "freq:NEW-A:D2:3420.00 - 3460.00",
                "tipo": "frecuencia",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "codigo": "0800100",
                "antennaId": "NEW-A",
                "codigoBanda": "D2",
                "frecuencia": "3420.00 - 3460.00 MHz",
                "ubicacion": "BARCELONA",
                "prov": "BARCELONA",
                "scannedAt": "2026-11-16T18:10:00Z",
                "fecha": "16/11/2026 19:10:00",
            },
            # Duplicado previo de NEW-A que debe deduplicarse conservando la última copia
            {
                "id": "ant:NEW-A",
                "tipo": "antena",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "codigo": "0800100",
                "antennaId": "NEW-A",
                "codigoBanda": "",
                "frecuencia": "",
                "ubicacion": "ANTIGUO",
                "prov": "BARCELONA",
                "scannedAt": "2026-11-16T18:00:00Z",
                "fecha": "16/11/2026 19:00:00",
            },
            {
                "id": "freq:NEW-B:V1:758.00 - 768.00",
                "tipo": "frecuencia",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.U.",
                "codigo": "2800200",
                "antennaId": "NEW-B",
                "codigoBanda": "V1",
                "frecuencia": "758.00 - 768.00 MHz",
                "ubicacion": "MADRID",
                "prov": "MADRID",
                "scannedAt": "2026-11-16T18:08:00Z",
                "fecha": "16/11/2026 19:08:00",
            },
            {
                "id": "freq:NEW-A:D1:1845.10 - 1855.10",
                "tipo": "frecuencia",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "codigo": "0800100",
                "antennaId": "NEW-A",
                "codigoBanda": "D1",
                "frecuencia": "1845.10 - 1855.10 MHz",
                "ubicacion": "BARCELONA",
                "prov": "BARCELONA",
                "scannedAt": "2026-11-16T18:10:00Z",
                "fecha": "16/11/2026 19:10:00",
            },
            # Copia final de Antena Nueva A (18:05Z -> primera antena nueva)
            {
                "id": "ant:NEW-A",
                "tipo": "antena",
                "op": "digi",
                "opRaw": "DS MOBILE NETWORKS, S.L.",
                "codigo": "0800100",
                "antennaId": "NEW-A",
                "codigoBanda": "",
                "frecuencia": "",
                "ubicacion": "BARCELONA",
                "prov": "BARCELONA",
                "scannedAt": "2026-11-16T18:05:00Z",
                "fecha": "16/11/2026 19:05:00",
            },
        ]

        ordered = fa.sort_novedades_grouped(scrambled)  # type: ignore[arg-type]
        self.assertEqual(len(ordered), 10)
        self.assertEqual(ordered[0]["ubicacion"], "BARCELONA")
        self.assertEqual(
            [(item["id"], item["tipo"], item["frecuencia"]) for item in ordered],
            [
                # 1) Antena Nueva A + sus 3 frecuencias ordenadas por MHz (1800 -> 3500 -> 26 GHz)
                ("ant:NEW-A", "antena", ""),
                ("freq:NEW-A:D1:1845.10 - 1855.10", "frecuencia", "1845.10 - 1855.10 MHz"),
                ("freq:NEW-A:D2:3420.00 - 3460.00", "frecuencia", "3420.00 - 3460.00 MHz"),
                ("freq:NEW-A:D3:26.50 - 27.50 GHz", "frecuencia", "26.50 - 27.50 GHz"),
                # 2) Antena Nueva B + sus 2 frecuencias ordenadas por MHz (700 -> 3500)
                ("ant:NEW-B", "antena", ""),
                ("freq:NEW-B:V1:758.00 - 768.00", "frecuencia", "758.00 - 768.00 MHz"),
                ("freq:NEW-B:V2:3600.00 - 3690.00", "frecuencia", "3600.00 - 3690.00 MHz"),
                # 3) Antenas ya existentes agrupadas (EXIST-1 a las 18:25Z antes que EXIST-2 a las 18:20Z)
                ("freq:EXIST-1:M1:935.10 - 949.90", "frecuencia", "935.10 - 949.90 MHz"),
                ("freq:EXIST-1:M2:3460.00 - 3600.00", "frecuencia", "3460.00 - 3600.00 MHz"),
                ("freq:EXIST-2:OR1:1805.10 - 1825.10", "frecuencia", "1805.10 - 1825.10 MHz"),
            ],
        )

    def test_publish_scan_status_git_tree_push_blob_cache_finalize_and_restore(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            bare_origin = tmp / "origin.git"
            work_repo = tmp / "work"
            work_repo.mkdir(parents=True)

            subprocess.run(
                ["git", "init", "--bare", str(bare_origin)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["git", "init", str(work_repo)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["git", "remote", "add", "origin", str(bare_origin)],
                cwd=work_repo,
                check=True,
                capture_output=True,
            )

            live_dir = tmp / "live-out"
            live_dir.mkdir(parents=True)
            status_path = live_dir / "scan-status.json"
            chunk0_path = live_dir / "live-chunk-0.json"
            tail_path = live_dir / "live-tail.json"
            ant_path = tmp / "antenas.json"

            ant_path.write_text(
                json.dumps(
                    {
                        "updatedAt": "2026-11-16T18:12:34Z",
                        "total": 62240,
                        "antenas": [],
                    }
                ),
                encoding="utf-8",
            )
            chunk0_doc = {
                "schemaVersion": 1,
                "scanId": "scan-git-1",
                "seq": 1,
                "chunkIndex": 0,
                "isTail": False,
                "updatedAt": "2026-11-16T18:01:00Z",
                "recordNovedades": True,
                "previousScanAt": "2026-11-15T18:00:00Z",
                "replacesNewAntennas": True,
                "newAntennas": [{"id": "MOV-1", "gid": "2800001"}],
                "bandPatches": [],
                "novedades": [],
            }
            tail_doc = {
                "schemaVersion": 1,
                "scanId": "scan-git-1",
                "seq": 2,
                "chunkIndex": 1,
                "isTail": True,
                "updatedAt": "2026-11-16T18:02:00Z",
                "recordNovedades": True,
                "previousScanAt": "2026-11-15T18:00:00Z",
                "replacesNewAntennas": False,
                "newAntennas": [],
                "bandPatches": [{"id": "MOV-1", "gid": "2800001", "bandas": ["3500 MHz"]}],
                "novedades": [],
            }
            status_doc = fa.build_scan_status_payload(
                state="running",
                scan_id="scan-git-1",
                trigger="schedule",
                record_novedades=True,
                part="1/2",
                phase="frecuencias",
                started_at="2026-11-16T18:00:00Z",
                total_antennas=62240,
                scanned_antennas=31120,
                delta_seq=2,
                chunk_count=1,
                live_new_antennas_count=1,
                live_updated_antennas_count=1,
                live_novedades_count=0,
                requests_per_second=48.5,
            )

            chunk0_path.write_text(json.dumps(chunk0_doc), encoding="utf-8")
            tail_path.write_text(json.dumps(tail_doc), encoding="utf-8")
            status_path.write_text(json.dumps(status_doc), encoding="utf-8")

            blob_cache: dict[str, str] = {}
            ok1 = pss.push_status_to_branch(
                status_path,
                live_dir=live_dir,
                branch="scan-status",
                blob_sha_cache=blob_cache,
                cwd=work_repo,
            )
            self.assertTrue(ok1)
            self.assertIn("live-chunk-0.json", blob_cache)
            cached_sha = blob_cache["live-chunk-0.json"]

            # Segunda publicación reutiliza el SHA en caché de live-chunk-0.json
            tail_doc["seq"] = 3
            tail_path.write_text(json.dumps(tail_doc), encoding="utf-8")
            ok2 = pss.push_status_to_branch(
                status_path,
                live_dir=live_dir,
                branch="scan-status",
                blob_sha_cache=blob_cache,
                cwd=work_repo,
            )
            self.assertTrue(ok2)
            self.assertEqual(blob_cache["live-chunk-0.json"], cached_sha)

            ls_tree = subprocess.run(
                ["git", "ls-tree", "--name-only", "refs/heads/scan-status"],
                cwd=bare_origin,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                sorted(ls_tree.stdout.strip().splitlines()),
                ["live-chunk-0.json", "live-tail.json", "scan-status.json"],
            )

            # Finalize marca completed y sella completedDatasetUpdatedAt desde antenas.json
            rc_fin = pss.main(
                [
                    "--status-file",
                    str(status_path),
                    "--live-dir",
                    str(live_dir),
                    "--mode",
                    "finalize",
                    "--scan-id",
                    "scan-git-1",
                    "--part",
                    "1/2",
                    "--antenas-file",
                    str(ant_path),
                    "--job-status",
                    "success",
                    "--has-more",
                    "false",
                    "--cwd",
                    str(work_repo),
                ]
            )
            self.assertEqual(rc_fin, 0)

            # Restore con scanId distinto no sobrescribe; con el scanId correcto restaura los 3 archivos
            restore_dir = tmp / "restored-live"
            restored_status = restore_dir / "scan-status.json"
            pss.main(
                [
                    "--status-file",
                    str(restored_status),
                    "--live-dir",
                    str(restore_dir),
                    "--mode",
                    "restore",
                    "--scan-id",
                    "other-scan-id",
                    "--cwd",
                    str(work_repo),
                ]
            )
            self.assertFalse(restored_status.exists())

            rc_res = pss.main(
                [
                    "--status-file",
                    str(restored_status),
                    "--live-dir",
                    str(restore_dir),
                    "--mode",
                    "restore",
                    "--scan-id",
                    "scan-git-1",
                    "--cwd",
                    str(work_repo),
                ]
            )
            self.assertEqual(rc_res, 0)
            self.assertTrue(restored_status.exists())
            self.assertTrue((restore_dir / "live-chunk-0.json").exists())
            self.assertTrue((restore_dir / "live-tail.json").exists())
            res_status_doc = json.loads(restored_status.read_text(encoding="utf-8"))
            self.assertEqual(res_status_doc["state"], "completed")
            self.assertEqual(
                res_status_doc["completedDatasetUpdatedAt"],
                "2026-11-16T18:12:34Z",
            )
            self.assertEqual(res_status_doc["deltaSeq"], 3)

    def test_permanent_novedades_accumulate_across_multiple_scans_without_replacing(
        self,
    ) -> None:
        # Verificar que el modo por defecto en CLI es 'append' (permanente)
        default_args = fa.parse_args([])
        self.assertEqual(default_args.novedades_mode, "append")

        class _FakeResp:
            def __init__(self, body: bytes) -> None:
                self._body = body

            def read(self) -> bytes:
                return self._body

            def __enter__(self) -> "_FakeResp":
                return self

            def __exit__(self, *_: object) -> None:
                return None

        mov_base_feat = {
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
        ant_a_feat = {
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
        ant_b_feat = {
            "type": "Feature",
            "id": "ORANGE ESPAGNE, S.A.U. - 2800888",
            "geometry": {"type": "Point", "coordinates": [-3.705000, 40.420000]},
            "properties": {
                "Gis_ID": "2800888",
                "Gis_Latitud": "40.420000",
                "Gis_Longitud": "-3.705000",
                "Gis_Codigo": "ORANGE ESPAGNE, S.A.U. - 2800888",
                "Dirección": "CL GRAN VIA, 42. MADRID, MADRID",
            },
        }

        def make_urlopen(
            *,
            include_ant_a: bool,
            include_ant_b: bool,
            mov_has_3500: bool,
            ant_a_has_700: bool,
        ):
            def _urlopen(req: object, timeout: float = 30.0) -> _FakeResp:
                url = getattr(req, "full_url", str(req))
                if "infoantenasGeoJSON.do" in url:
                    if "-3.715000" in url:
                        madrid_feats = [mov_base_feat]
                        if include_ant_b:
                            madrid_feats.append(ant_b_feat)
                        payload = {
                            "type": "FeatureCollection",
                            "features": madrid_feats,
                        }
                    else:
                        bcn_feats = [ant_a_feat] if include_ant_a else []
                        payload = {"type": "FeatureCollection", "features": bcn_feats}
                    return _FakeResp(
                        json.dumps(payload, ensure_ascii=False).encode("iso-8859-1")
                    )

                if "emplazamiento=2800006" in url:
                    extra_3500 = (
                        "<tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2205199</td><td>3460.00 - 3600.00</td></tr>"
                        if mov_has_3500
                        else ""
                    )
                    html = f"""
                        <h2>CARACTERISTICAS TÉCNICAS</h2>
                        <table>
                            <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                            <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>M M -2200490</td><td>935.10 - 949.90</td></tr>
                            {extra_3500}
                        </table>
                    """
                    return _FakeResp(html.encode("iso-8859-1"))

                if "emplazamiento=0800777" in url:
                    extra_700 = (
                        "<tr><td>DS MOBILE NETWORKS, S.L.</td><td>D-700</td><td>758.00 - 768.00</td></tr>"
                        if ant_a_has_700
                        else ""
                    )
                    html_a = f"""
                        <h2>CARACTERISTICAS TÉCNICAS</h2>
                        <table>
                            <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                            <tr><td>DS MOBILE NETWORKS, S.L.</td><td>M M -2602235</td><td>1845.10 - 1855.10</td></tr>
                            {extra_700}
                        </table>
                    """
                    return _FakeResp(html_a.encode("iso-8859-1"))

                html_b = """
                    <h2>CARACTERISTICAS TÉCNICAS</h2>
                    <table>
                        <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                        <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>OR-800</td><td>832.00 - 842.00</td></tr>
                    </table>
                """
                return _FakeResp(html_b.encode("iso-8859-1"))

            return _urlopen

        def make_clock_iso(base_dt: datetime):
            counter = 0

            def _next_iso(_now_fn: object = None) -> str:
                nonlocal counter
                counter += 1
                return (base_dt + timedelta(seconds=counter)).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                )

            return _next_iso

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ant_path = tmp / "antenas.json"
            nov_path = tmp / "novedades.json"

            # Día 0: Línea base inicial con Movistar 2800006 (900 MHz)
            with (
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=make_urlopen(
                        include_ant_a=False,
                        include_ant_b=False,
                        mov_has_3500=False,
                        ant_a_has_700=False,
                    ),
                ),
                mock.patch.object(
                    fa,
                    "_utc_now_iso",
                    side_effect=make_clock_iso(
                        datetime(2026, 11, 16, 17, 0, 0, tzinfo=timezone.utc)
                    ),
                ),
                mock.patch("time.sleep", return_value=None),
            ):
                rc0 = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--delay",
                        "0.0",
                        "--workers",
                        "1",
                        "--census-workers",
                        "1",
                        "--fetch-bands",
                        "--rescan-since",
                        "2026-11-16T17:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--novedades-mode",
                        "reset",
                        "--skip-novedades",
                        "--scan-id",
                        "baseline-day-0",
                    ]
                )
            self.assertEqual(rc0, 0)

            # Escaneo 1 (scan-day-1, modo por defecto 'append'):
            # Descubre Antena A (0800777) + su frecuencia (1845.10 - 1855.10 MHz) +
            # 1 frecuencia nueva en antena existente 2800006 (3460.00 - 3600.00 MHz) -> total == 3
            with (
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=make_urlopen(
                        include_ant_a=True,
                        include_ant_b=False,
                        mov_has_3500=True,
                        ant_a_has_700=False,
                    ),
                ),
                mock.patch.object(
                    fa,
                    "_utc_now_iso",
                    side_effect=make_clock_iso(
                        datetime(2026, 11, 17, 17, 0, 0, tzinfo=timezone.utc)
                    ),
                ),
                mock.patch("time.sleep", return_value=None),
            ):
                rc1 = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--preserve-from",
                        str(ant_path),
                        "--delay",
                        "0.0",
                        "--workers",
                        "1",
                        "--census-workers",
                        "1",
                        "--fetch-bands",
                        "--rescan-since",
                        "2026-11-17T17:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--scan-id",
                        "scan-day-1",
                    ]
                )
            self.assertEqual(rc1, 0)
            nov_day1 = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertFalse(nov_day1["isBaselineScan"])
            self.assertEqual(nov_day1["scanId"], "scan-day-1")
            self.assertEqual(nov_day1["total"], 3)
            self.assertEqual(nov_day1["antenasNuevas"], 1)
            self.assertEqual(nov_day1["frecuenciasNuevas"], 2)
            self.assertEqual(
                [
                    (n["tipo"], n["codigo"], n["frecuencia"], n.get("scanId"))
                    for n in nov_day1["novedades"]
                ],
                [
                    ("antena", "0800777", "", "scan-day-1"),
                    ("frecuencia", "0800777", "1845.10 - 1855.10 MHz", "scan-day-1"),
                    ("frecuencia", "2800006", "3460.00 - 3600.00 MHz", "scan-day-1"),
                ],
            )
            day1_snapshot = [
                (n["id"], n["scannedAt"], n["fecha"], n.get("scanId"))
                for n in nov_day1["novedades"]
            ]
            for n in nov_day1["novedades"]:
                self.assertTrue(
                    str(n["scannedAt"]).startswith("2026-11-17T17:00:"),
                    f"scannedAt inesperado en scan-day-1: {n}",
                )

            # Escaneo 2 (scan-day-2, modo por defecto 'append'):
            # Re-escanea todo pero encuentra 0 cambios nuevos -> conserva intactas las 3 novedades
            # de scan-day-1 con sus fechas/horas originales y sin re-emitir falsamente Antena A
            with (
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=make_urlopen(
                        include_ant_a=True,
                        include_ant_b=False,
                        mov_has_3500=True,
                        ant_a_has_700=False,
                    ),
                ),
                mock.patch.object(
                    fa,
                    "_utc_now_iso",
                    side_effect=make_clock_iso(
                        datetime(2026, 11, 18, 17, 0, 0, tzinfo=timezone.utc)
                    ),
                ),
                mock.patch("time.sleep", return_value=None),
            ):
                rc2 = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--preserve-from",
                        str(ant_path),
                        "--delay",
                        "0.0",
                        "--workers",
                        "1",
                        "--census-workers",
                        "1",
                        "--fetch-bands",
                        "--rescan-since",
                        "2026-11-18T17:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--scan-id",
                        "scan-day-2",
                    ]
                )
            self.assertEqual(rc2, 0)
            nov_day2 = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertFalse(nov_day2["isBaselineScan"])
            self.assertEqual(nov_day2["scanId"], "scan-day-2")
            self.assertEqual(nov_day2["total"], 3)
            self.assertEqual(nov_day2["antenasNuevas"], 1)
            self.assertEqual(nov_day2["frecuenciasNuevas"], 2)
            self.assertEqual(
                [
                    (n["id"], n["scannedAt"], n["fecha"], n.get("scanId"))
                    for n in nov_day2["novedades"]
                ],
                day1_snapshot,
            )

            # Escaneo intermedio con --skip-novedades en modo 'append' (por defecto):
            # NO debe borrar ni pisar las novedades permanentes ya guardadas en novedades.json
            with (
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=make_urlopen(
                        include_ant_a=True,
                        include_ant_b=False,
                        mov_has_3500=True,
                        ant_a_has_700=False,
                    ),
                ),
                mock.patch.object(
                    fa,
                    "_utc_now_iso",
                    side_effect=make_clock_iso(
                        datetime(2026, 11, 18, 20, 0, 0, tzinfo=timezone.utc)
                    ),
                ),
                mock.patch("time.sleep", return_value=None),
            ):
                rc_skip_append = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--preserve-from",
                        str(ant_path),
                        "--delay",
                        "0.0",
                        "--workers",
                        "1",
                        "--census-workers",
                        "1",
                        "--fetch-bands",
                        "--rescan-since",
                        "2026-11-18T20:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--skip-novedades",
                        "--scan-id",
                        "scan-skip-append",
                    ]
                )
            self.assertEqual(rc_skip_append, 0)
            nov_after_skip = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertFalse(nov_after_skip["isBaselineScan"])
            self.assertEqual(nov_after_skip["total"], 3)
            self.assertEqual(
                [
                    (n["id"], n["scannedAt"], n["fecha"], n.get("scanId"))
                    for n in nov_after_skip["novedades"]
                ],
                day1_snapshot,
            )

            # Escaneo 3 (scan-day-3, modo por defecto 'append'):
            # Descubre Antena B (2800888) + su frecuencia (832.00 - 842.00 MHz) +
            # 1 frecuencia nueva (758.00 - 768.00 MHz) en 0800777 (que ya era antena existente).
            # Resultado: total == 6, bloque agrupado de Escaneo 3 arriba seguido del bloque
            # agrupado intacto de Escaneo 1 debajo (sin mezclar la ampliación de 0800777 en el bloque antiguo).
            with (
                mock.patch(
                    "urllib.request.urlopen",
                    side_effect=make_urlopen(
                        include_ant_a=True,
                        include_ant_b=True,
                        mov_has_3500=True,
                        ant_a_has_700=True,
                    ),
                ),
                mock.patch.object(
                    fa,
                    "_utc_now_iso",
                    side_effect=make_clock_iso(
                        datetime(2026, 11, 19, 17, 0, 0, tzinfo=timezone.utc)
                    ),
                ),
                mock.patch("time.sleep", return_value=None),
            ):
                rc3 = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(ant_path),
                        "--preserve-from",
                        str(ant_path),
                        "--delay",
                        "0.0",
                        "--workers",
                        "1",
                        "--census-workers",
                        "1",
                        "--fetch-bands",
                        "--rescan-since",
                        "2026-11-19T17:00:00Z",
                        "--novedades-output",
                        str(nov_path),
                        "--scan-id",
                        "scan-day-3",
                    ]
                )
            self.assertEqual(rc3, 0)
            nov_day3 = json.loads(nov_path.read_text(encoding="utf-8"))
            self.assertFalse(nov_day3["isBaselineScan"])
            self.assertEqual(nov_day3["scanId"], "scan-day-3")
            self.assertEqual(nov_day3["total"], 6)
            self.assertEqual(nov_day3["antenasNuevas"], 2)
            self.assertEqual(nov_day3["frecuenciasNuevas"], 4)
            self.assertEqual(
                [
                    (n["tipo"], n["codigo"], n["frecuencia"], n.get("scanId"))
                    for n in nov_day3["novedades"]
                ],
                [
                    # Lote Escaneo 3 arriba (Antena B -> Freq B -> Freq en antena existente)
                    ("antena", "2800888", "", "scan-day-3"),
                    ("frecuencia", "2800888", "832.00 - 842.00 MHz", "scan-day-3"),
                    ("frecuencia", "0800777", "758.00 - 768.00 MHz", "scan-day-3"),
                    # Lote Escaneo 1 preservado íntegro debajo (Antena A -> Freq A -> Freq existente)
                    ("antena", "0800777", "", "scan-day-1"),
                    ("frecuencia", "0800777", "1845.10 - 1855.10 MHz", "scan-day-1"),
                    ("frecuencia", "2800006", "3460.00 - 3600.00 MHz", "scan-day-1"),
                ],
            )
            self.assertEqual(
                [
                    (n["id"], n["scannedAt"], n["fecha"], n.get("scanId"))
                    for n in nov_day3["novedades"][3:]
                ],
                day1_snapshot,
            )
            for n in nov_day3["novedades"][:3]:
                self.assertTrue(
                    str(n["scannedAt"]).startswith("2026-11-19T17:00:"),
                    f"scannedAt inesperado en scan-day-3: {n}",
                )

            # Fusión sin pérdidas entre archivos (merge_novedades_files / --merge-novedades-from)
            # simulando rebase concurrente en GitHub Actions
            remote_nov_path = tmp / "remote_main_novedades.json"
            backup_nov_path = tmp / "backup_scan_novedades.json"
            backup_nov_path.write_text(
                json.dumps(nov_day3, ensure_ascii=False), encoding="utf-8"
            )
            concurrent_remote_doc = fa.build_novedades_dataset(
                [
                    *nov_day1["novedades"],
                    {
                        "id": "freq:CONCURRENT-41:M9:2620.00 - 2640.00",
                        "tipo": "frecuencia",
                        "op": "movistar",
                        "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                        "codigo": "4100999",
                        "antennaId": "CONCURRENT-41",
                        "codigoBanda": "M9",
                        "frecuencia": "2620.00 - 2640.00 MHz",
                        "ubicacion": "SEVILLA",
                        "prov": "SEVILLA",
                        "scannedAt": "2026-11-18T18:30:00Z",
                        "fecha": "18/11/2026 19:30:00",
                    },
                ],
                scan_id="scan-day-2-concurrent",
                previous_scan_at="2026-11-17T17:05:00Z",
                updated_at="2026-11-18T18:35:00Z",
                is_baseline_scan=False,
            )
            fa.write_novedades_dataset(concurrent_remote_doc, remote_nov_path)

            rc_merge = fa.main(
                [
                    "--merge-novedades-from",
                    str(backup_nov_path),
                    "--novedades-output",
                    str(remote_nov_path),
                ]
            )
            self.assertEqual(rc_merge, 0)
            merged_doc = json.loads(remote_nov_path.read_text(encoding="utf-8"))
            self.assertEqual(merged_doc["scanId"], "scan-day-3")
            self.assertFalse(merged_doc["isBaselineScan"])
            self.assertEqual(merged_doc["total"], 7)
            self.assertEqual(merged_doc["antenasNuevas"], 2)
            self.assertEqual(merged_doc["frecuenciasNuevas"], 5)
            self.assertEqual(
                [
                    (n["tipo"], n["codigo"], n.get("scanId"))
                    for n in merged_doc["novedades"]
                ],
                [
                    ("antena", "2800888", "scan-day-3"),
                    ("frecuencia", "2800888", "scan-day-3"),
                    ("frecuencia", "0800777", "scan-day-3"),
                    ("frecuencia", "4100999", "scan-day-2-concurrent"),
                    ("antena", "0800777", "scan-day-1"),
                    ("frecuencia", "0800777", "scan-day-1"),
                    ("frecuencia", "2800006", "scan-day-1"),
                ],
            )
            self.assertEqual(
                [
                    (n["id"], n["scannedAt"], n["fecha"], n.get("scanId"))
                    for n in merged_doc["novedades"][4:]
                ],
                day1_snapshot,
            )

    def test_fuse_xfera_into_orange_same_gid_colocated_standalone_and_native_guard(
        self,
    ) -> None:
        # 1) Mismo GID exacto (ANDR9085A): Orange + Xfera se unifican en 1 registro Orange
        #    combinando bandas, frecuencias y las 8 concesiones sin mergedGids redundante.
        andr_orange = {
            "id": "ORANGE ESPAGNE, S.A.U. - ANDR9085A",
            "gid": "ANDR9085A",
            "op": "orange",
            "opRaw": "ORANGE ESPAGNE, S.A.U.",
            "lat": 36.972167,
            "lon": -2.955278,
            "dir": "VP POLÍGONO 2 PARCELA 240, S/N",
            "mun": "ALCOLEA",
            "prov": "ALMERÍA",
            "bandas": ["800 MHz", "900 MHz", "1800 MHz", "2100 MHz"],
            "frecuencias": [
                "832.00 - 842.00",
                "925.10 - 935.10",
                "1855.10 - 1879.90",
                "2120.00 - 2140.00",
            ],
            "concesiones": [
                {"ref": "ALAL-1603890", "freq": "832.00 - 842.00"},
                {"ref": "ALAL-2400087", "freq": "925.10 - 935.10"},
                {"ref": "ALAL-2400089", "freq": "925.10 - 935.10"},
                {"ref": "ALAL-2200033", "freq": "1855.10 - 1879.90"},
                {"ref": "ALAL-2200035", "freq": "2120.00 - 2140.00"},
            ],
            "bandsScannedAt": "2026-11-17T07:53:00Z",
        }
        andr_xfera = {
            "id": "XFERA MÓVILES, S.A.U. - ANDR9085A",
            "gid": "ANDR9085A",
            "op": "masmovil",
            "opRaw": "XFERA MÓVILES, S.A.U.",
            "lat": 36.972167,
            "lon": -2.955278,
            "dir": "VP POLÍGONO 2 PARCELA 240, S/N",
            "mun": "ALCOLEA",
            "prov": "ALMERÍA",
            "bandas": ["700 MHz", "1800 MHz", "3500 MHz"],
            "frecuencias": [
                "758.00 - 768.00",
                "1855.10 - 1879.90",
                "3600.00 - 3700.00",
            ],
            "concesiones": [
                {"ref": "ALAL-2500474", "freq": "758.00 - 768.00"},
                {"ref": "ALAL-2500468", "freq": "1855.10 - 1879.90"},
                {"ref": "ALAL-2500471", "freq": "3600.00 - 3700.00"},
            ],
            "bandsScannedAt": "2026-11-17T07:52:12Z",
        }

        # 2) Co-ubicación < 30 m con GID distinto (EXTR6353A aparece incluso antes que EXTR6353E):
        #    ORANGE ESPAGNE debe ganar como registro canónico y poblar mergedGids=["EXTR6353E", "EXTR6353A"].
        extr_xfera_0m = {
            "id": "XFERA MÓVILES, S.A.U. - EXTR6353A",
            "gid": "EXTR6353A",
            "op": "masmovil",
            "opRaw": "XFERA MÓVILES, S.A.U.",
            "lat": 39.650528,
            "lon": -7.495919,
            "dir": "CL CASARES, 7",
            "mun": "CEDILLO",
            "prov": "CÁCERES",
            "bandas": ["700 MHz", "1800 MHz", "3500 MHz"],
            "frecuencias": [
                "758.00 - 768.00",
                "1855.10 - 1879.90",
                "3600.00 - 3700.00",
            ],
            "concesiones": [
                {"ref": "CCCC-2501106", "freq": "758.00 - 768.00"},
                {"ref": "CCCC-2501102", "freq": "1855.10 - 1879.90"},
                {"ref": "CCCC-2501104", "freq": "3600.00 - 3700.00"},
            ],
            "bandsScannedAt": "2026-11-17T07:45:14Z",
        }
        extr_orange_0m = {
            "id": "ORANGE ESPAGNE, S.A.U. - EXTR6353E",
            "gid": "EXTR6353E",
            "op": "orange",
            "opRaw": "ORANGE ESPAGNE, S.A.U.",
            "lat": 39.650528,
            "lon": -7.495919,
            "dir": "",
            "mun": "CEDILLO",
            "prov": "SIN PROVINCIA",
            "bandas": ["800 MHz", "900 MHz", "2100 MHz"],
            "frecuencias": [
                "832.00 - 842.00",
                "925.10 - 935.10",
                "2120.00 - 2140.00",
            ],
            "concesiones": [
                {"ref": "CCCC-2501118", "freq": "832.00 - 842.00"},
                {"ref": "CCCC-2501116", "freq": "925.10 - 935.10"},
                {"ref": "CCCC-2501117", "freq": "925.10 - 935.10"},
                {"ref": "CCCC-2501120", "freq": "2120.00 - 2140.00"},
            ],
            "bandsScannedAt": "2026-11-17T07:46:00Z",
        }

        # 3) Guardia crítica: dos estaciones nativas ORANGE ESPAGNE con GID distinto a ~10 m
        #    JAMÁS deben fusionarse entre sí, ni siquiera con una estación Xfera en medio (~4 m y ~6 m).
        base_lat, base_lon = 40.420000, -3.700000
        lat_4m = 40.420036   # ~4.0 m respecto a base_lat
        lat_10m = 40.420090  # ~10.0 m respecto a base_lat (~6.0 m respecto a lat_4m)
        self.assertLess(fa.haversine_m(base_lat, base_lon, lat_10m, base_lon), 11.0)
        ora_native_a = {
            "id": "ORANGE ESPAGNE, S.A.U. - MADR1001A",
            "gid": "MADR1001A",
            "op": "orange",
            "opRaw": "ORANGE ESPAGNE, S.A.U.",
            "lat": base_lat,
            "lon": base_lon,
            "dir": "CL ALCALÁ, 10",
            "mun": "MADRID",
            "prov": "MADRID",
            "bandas": ["800 MHz"],
            "frecuencias": ["832.00 - 842.00"],
            "concesiones": [{"ref": "M-1001", "freq": "832.00 - 842.00"}],
            "bandsScannedAt": "2026-11-17T07:00:00Z",
        }
        ora_native_b = {
            "id": "ORANGE ESPAGNE, S.A.U. - MADR1002B",
            "gid": "MADR1002B",
            "op": "orange",
            "opRaw": "ORANGE ESPAGNE, S.A.U.",
            "lat": lat_10m,
            "lon": base_lon,
            "dir": "CL ALCALÁ, 12",
            "mun": "MADRID",
            "prov": "MADRID",
            "bandas": ["2600 MHz"],
            "frecuencias": ["2620.00 - 2640.00"],
            "concesiones": [{"ref": "M-1002", "freq": "2620.00 - 2640.00"}],
            "bandsScannedAt": "2026-11-17T07:00:00Z",
        }
        xfera_between = {
            "id": "XFERA MÓVILES, S.A.U. - TRMADR99",
            "gid": "TRMADR99",
            "op": "orange",
            "opRaw": "XFERA MÓVILES, S.A.U.",
            "lat": lat_4m,
            "lon": base_lon,
            "dir": "CL ALCALÁ, 10",
            "mun": "MADRID",
            "prov": "MADRID",
            "bandas": ["3500 MHz"],
            "frecuencias": ["3600.00 - 3700.00"],
            "concesiones": [{"ref": "M-9999", "freq": "3600.00 - 3700.00"}],
            "bandsScannedAt": "2026-11-17T07:00:00Z",
        }

        # 4) Estación independiente de Xfera a >= 30 m (~150 m) conservada con op == "orange".
        lat_150m = 40.421350  # ~150.1 m respecto a base_lat
        self.assertGreater(fa.haversine_m(lat_10m, base_lon, lat_150m, base_lon), 130.0)
        xfera_standalone = {
            "id": "XFERA MÓVILES, S.A.U. - EXTR6566A",
            "gid": "EXTR6566A",
            "op": "masmovil",
            "opRaw": "XFERA MÓVILES, S.A.U.",
            "lat": lat_150m,
            "lon": base_lon,
            "dir": "CL LAS HABAZAS, 2(A)",
            "mun": "MALPARTIDA DE PLASENCIA",
            "prov": "CÁCERES",
            "bandas": ["700 MHz", "1800 MHz", "3500 MHz"],
            "frecuencias": [
                "758.00 - 768.00",
                "1855.10 - 1879.90",
                "3600.00 - 3700.00",
            ],
            "concesiones": [
                {"ref": "CCCC-2501268", "freq": "758.00 - 768.00"},
                {"ref": "CCCC-2501266", "freq": "1855.10 - 1879.90"},
                {"ref": "CCCC-2501267", "freq": "3600.00 - 3700.00"},
            ],
            "bandsScannedAt": "2026-11-17T07:45:15Z",
        }

        dataset = fa.build_dataset(
            [
                andr_xfera,
                andr_orange,
                extr_xfera_0m,
                extr_orange_0m,
                ora_native_a,
                ora_native_b,
                xfera_between,
                xfera_standalone,
            ],
            crawl_stats={"requestsCount": 1, "durationSeconds": 0.1},
        )
        self.assertNotIn("masmovil", dataset["operators"])
        self.assertEqual(
            list(dataset["operators"].keys()),
            ["movistar", "orange", "vodafone", "digi", "otros"],
        )
        # De 8 registros de entrada -> 5 estaciones únicas de Orange:
        # ANDR9085A (1), EXTR6353E+EXTR6353A (1), MADR1001A+TRMADR99 (1), MADR1002B (1), EXTR6566A (1)
        self.assertEqual(dataset["total"], 5)
        self.assertEqual(dataset["operators"]["orange"]["count"], 5)
        self.assertTrue(all(a["op"] == "orange" for a in dataset["antenas"]))

        by_id = {a["id"]: a for a in dataset["antenas"]}
        self.assertIn("ORANGE ESPAGNE, S.A.U. - ANDR9085A", by_id)
        self.assertNotIn("XFERA MÓVILES, S.A.U. - ANDR9085A", by_id)
        andr_merged = by_id["ORANGE ESPAGNE, S.A.U. - ANDR9085A"]
        self.assertNotIn("mergedGids", andr_merged)
        self.assertEqual(
            andr_merged["bandas"],
            ["700 MHz", "800 MHz", "900 MHz", "1800 MHz", "2100 MHz", "3500 MHz"],
        )
        self.assertEqual(len(andr_merged["concesiones"]), 8)
        self.assertEqual(andr_merged["bandsScannedAt"], "2026-11-17T07:52:12Z")

        extr_merged = by_id["ORANGE ESPAGNE, S.A.U. - EXTR6353E"]
        self.assertEqual(extr_merged["mergedGids"], ["EXTR6353E", "EXTR6353A"])
        self.assertEqual(extr_merged["dir"], "CL CASARES, 7")
        self.assertEqual(extr_merged["prov"], "CÁCERES")
        self.assertEqual(
            extr_merged["bandas"],
            ["700 MHz", "800 MHz", "900 MHz", "1800 MHz", "2100 MHz", "3500 MHz"],
        )
        self.assertEqual(len(extr_merged["concesiones"]), 7)

        # Ambas nativas de Madrid siguen separadas; Xfera intermedia (~4 m vs ~6 m) se une a MADR1001A
        madr_a = by_id["ORANGE ESPAGNE, S.A.U. - MADR1001A"]
        madr_b = by_id["ORANGE ESPAGNE, S.A.U. - MADR1002B"]
        self.assertEqual(madr_a["mergedGids"], ["MADR1001A", "TRMADR99"])
        self.assertEqual(madr_a["bandas"], ["800 MHz", "3500 MHz"])
        self.assertNotIn("mergedGids", madr_b)
        self.assertEqual(madr_b["bandas"], ["2600 MHz"])

        # Estación independiente Xfera a >= 30 m conservada en Orange con su espectro íntegro
        standalone_out = by_id["XFERA MÓVILES, S.A.U. - EXTR6566A"]
        self.assertEqual(standalone_out["op"], "orange")
        self.assertEqual(standalone_out["bandas"], ["700 MHz", "1800 MHz", "3500 MHz"])
        self.assertEqual(len(standalone_out["concesiones"]), 3)

        # Verificar además que parse_detalle_estacion_html + _extract_record_concessions_for_gid
        # unifican concesiones de ORANGE ESPAGNE y XFERA MÓVILES bajo la misma estación Orange.
        sample_html = """
        <h2>CARACTERISTICAS TÉCNICAS</h2>
        <table>
          <tr><th>Operador</th><th>Referencia</th><th>Banda asignada (MHz)</th></tr>
          <tr><td>ORANGE ESPAGNE, S.A.U.</td><td>ALAL-1603890</td><td>832.00 - 842.00</td></tr>
          <tr><td>XFERA MÓVILES, S.A.U.</td><td>ALAL-2500471</td><td>3600.00 - 3700.00</td></tr>
          <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>ALAL-0000001</td><td>768.00 - 778.00</td></tr>
        </table>
        """
        entries = fa.parse_detalle_estacion_html(sample_html)
        ora_concs = fa._extract_record_concessions_for_gid(
            andr_merged, entries, [andr_merged]
        )
        self.assertEqual(
            [c["referencia"] for c in ora_concs],
            ["ALAL-1603890", "ALAL-2500471"],
        )

        # Verificar normalización de legado "masmovil" en load_novedades_dataset
        with tempfile.TemporaryDirectory() as tmpdir:
            nov_file = Path(tmpdir) / "novedades.json"
            nov_file.write_text(
                json.dumps(
                    {
                        "updatedAt": "2026-11-17T08:00:00Z",
                        "novedades": [
                            {
                                "id": "ant:XFERA MÓVILES, S.A.U. - EXTR6566A",
                                "tipo": "antena",
                                "op": "masmovil",
                                "opRaw": "XFERA MÓVILES, S.A.U.",
                                "codigo": "EXTR6566A",
                                "antennaId": "XFERA MÓVILES, S.A.U. - EXTR6566A",
                                "codigoBanda": "",
                                "frecuencia": "",
                                "ubicacion": "MALPARTIDA DE PLASENCIA",
                                "prov": "CÁCERES",
                                "scannedAt": "2026-11-17T08:00:00Z",
                                "fecha": "17/11/2026 09:00",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            loaded_nov = fa.load_novedades_dataset(nov_file)
            assert loaded_nov is not None
            self.assertEqual(loaded_nov["novedades"][0]["op"], "orange")

    def test_keepalive_jsessionid_reuse_and_adaptive_backpressure(self) -> None:
        received_cookies: list[str | None] = []
        lock = threading.Lock()

        class _SessionHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return None

            def do_GET(self) -> None:  # noqa: N802
                cookie_hdr = self.headers.get("Cookie")
                with lock:
                    received_cookies.append(cookie_hdr)
                if self.path == "/server-busy":
                    body = b"Service Unavailable"
                    self.send_response(503)
                    self.send_header("Retry-After", "1.0")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    self.wfile.write(body)
                    return

                body = b"<html>ok</html>"
                self.send_response(200)
                if not cookie_hdr:
                    self.send_header(
                        "Set-Cookie",
                        "JSESSIONID=TESTSESSION12345; Path=/VCTEL; HttpOnly",
                    )
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), _SessionHandler)
        port = server.server_address[1]
        srv_thread = threading.Thread(target=server.serve_forever, daemon=True)
        srv_thread.start()
        client = fa._ThreadLocalKeepAliveClient()

        try:
            url = f"http://127.0.0.1:{port}/detalle"
            client.fetch_bytes(url, headers={"User-Agent": "Test/1.0"}, timeout=5.0)
            client.fetch_bytes(url, headers={"User-Agent": "Test/1.0"}, timeout=5.0)
            self.assertEqual(received_cookies[0], None)
            self.assertEqual(received_cookies[1], "JSESSIONID=TESTSESSION12345")
            self.assertEqual(client.get_adaptive_delay(), 0.0)

            # Congestión 503 activa enfriamiento compartido y retardo adaptativo > 0
            fake_clock = FakeClock()
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                client.fetch_bytes(
                    f"http://127.0.0.1:{port}/server-busy",
                    headers={"User-Agent": "Test/1.0"},
                    timeout=5.0,
                    clock_fn=fake_clock.time,
                )
            ctx.exception.close()
            self.assertGreater(client.get_adaptive_delay(), 0.0)

            # Simulación de latencia elevada (> ADAPTIVE_LATENCY_HIGH_S) y recuperación progresiva
            client._ewma_latency_s = 0.0
            client._adaptive_delay_s = 0.0
            client._record_success_latency(2.0)
            elevated_delay = client.get_adaptive_delay()
            self.assertGreater(elevated_delay, 0.0)
            for _ in range(120):
                client._record_success_latency(0.15)
            self.assertLess(client.get_adaptive_delay(), elevated_delay)
        finally:
            client.close_all()
            server.shutdown()
            server.server_close()
            srv_thread.join(timeout=3.0)

    def test_fast_html_parser_matches_fallback_and_handles_edge_cases(self) -> None:
        realistic_html = """
        <html><head><title>Niveles de Exposici&oacute;n</title></head><body>
        <table class="outer">
            <tr><td><h2>LOCALIZACI&Oacute;N</h2></td></tr>
            <tr><td><table><tr><td><h3>C&oacute;digo</h3></td><td><h3>Direcci&oacute;n</h3></td></tr>
            <tr><td>TELEFONICA - 2800006</td><td>CL TEST, 1</td></tr></table></td></tr>
            <tr><td><h2>CARACTERISTICAS T&Eacute;CNICAS</h2></td></tr>
            <tr><td>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td><h3>Operador</h3></td><td><h3>Referencia</h3></td><td><h3>Banda Asignada (MHz)</h3></td></tr>
                    <tr><td><p>TELEFONICA MOVILES ESPA&Ntilde;A, S.A.U.</p></td><td><p>M M -2200417</p></td><td><p>778.00 - 788.00</p></td></tr>
                    <tr><td><p>DS MOBILE NETWORKS, S.L.</p></td><td><p>M M -2602236</p></td><td><p>2110.00 - 2120.00</p></td></tr>
                    <tr><td><p>ORANGE ESPAGNE, S.A.U.</p></td><td><p>M M -2609999</p></td><td><p>25.70 - 26.70</p></td></tr>
                </table>
            </td></tr>
            <tr><td><h2>NIVELES MEDIDOS EN EL ENTORNO</h2></td></tr>
            <tr><td>
                <table class="tablaDetalleEstacionNivelesMedidos">
                    <tr><td>Distancia</td><td>Acimut</td><td>Valor Medido</td></tr>
                    <tr><td>100.0</td><td>200.0</td><td>700.00 - 800.00</td></tr>
                </table>
            </td></tr>
        </table></body></html>
        """
        fast_rows = fa._fast_parse_detalle_estacion_html(realistic_html)
        self.assertIsNotNone(fast_rows)
        assert fast_rows is not None
        self.assertEqual(len(fast_rows), 3)
        self.assertEqual(fast_rows[0]["operador"], "TELEFONICA MOVILES ESPAÑA, S.A.U.")
        self.assertEqual(fast_rows[0]["op"], "movistar")
        self.assertEqual(fast_rows[1]["op"], "digi")
        self.assertEqual(fast_rows[2]["banda"], "26 GHz")

        # Verificar paridad exacta con el parser HTMLParser completo
        with mock.patch.object(fa, "_fast_parse_detalle_estacion_html", return_value=None):
            fallback_rows = fa.parse_detalle_estacion_html(realistic_html)
        self.assertEqual(fast_rows, fallback_rows)

        # Tabla sin cabecera h2 -> ruta rápida devuelve None y delega en HTMLParser sin perder filas
        headerless_html = """
        <table>
            <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
            <tr><td>VODAFONE ESPAÑA, S.A.U.</td><td>V-1</td><td>842.00 - 852.00</td></tr>
        </table>
        """
        self.assertIsNone(fa._fast_parse_detalle_estacion_html(headerless_html))
        parsed_fallback = fa.parse_detalle_estacion_html(headerless_html)
        self.assertEqual(len(parsed_fallback), 1)
        self.assertEqual(parsed_fallback[0]["op"], "vodafone")

    def test_band_enricher_recovers_transient_failed_gids_and_reuses_prior_index(self) -> None:
        records = [
            {
                "id": f"TELEFONICA MOVILES ESPAÑA, S.A.U. - 28000{i}",
                "gid": f"28000{i}",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.40 + i * 0.01,
                "lon": -3.70,
                "dir": f"CL RECUPERACION, {i}",
                "mun": "MADRID",
                "prov": "MADRID",
            }
            for i in range(4)
        ]
        ds = fa.build_dataset(
            records,
            crawl_stats={
                "requestsCount": 1,
                "durationSeconds": 0.1,
                "gridBoxesVisited": 1,
                "subdividedBoxes": 0,
                "zoomParam": 7,
                "delaySeconds": 0.0,
            },
        )

        # El emplazamiento 280002 falla sus 3 intentos durante el barrido paralelo,
        # pero responde correctamente en la ola final de recuperación suave.
        attempts_by_gid: dict[str, int] = {}
        attempts_lock = threading.Lock()

        def flaky_fetch(gid: str) -> str:
            with attempts_lock:
                attempts_by_gid[gid] = attempts_by_gid.get(gid, 0) + 1
                n = attempts_by_gid[gid]
            if gid == "280002" and n <= 3:
                raise urllib.error.URLError("transient network blip")
            return """
            <h2>CARACTERISTICAS TÉCNICAS</h2>
            <table>
                <tr><td>Operador</td><td>Referencia</td><td>Banda Asignada (MHz)</td></tr>
                <tr><td>TELEFONICA MOVILES ESPAÑA, S.A.U.</td><td>REF-OK</td><td>3460.00 - 3600.00</td></tr>
            </table>
            """

        clock = FakeClock()
        enricher = fa.BandEnricher(
            delay_seconds=0.0,
            workers=4,
            fetch_fn=flaky_fetch,
            sleep_fn=clock.sleep,
            clock_fn=clock.time,
        )
        enricher.enrich_dataset(ds)

        self.assertEqual(enricher.failed_gids_count, 0)
        self.assertEqual(ds["crawlStats"]["bandsPopulatedCount"], 4)
        for ant in ds["antenas"]:
            self.assertEqual(ant["bandas"], ["3500 MHz"])
        self.assertEqual(attempts_by_gid["280002"], 4)

        # Verificar que preserve_bands_in_records acepta prior_index precalculado con idéntico resultado
        prior_index = fa.build_prior_antenna_index(ds)
        fresh = [
            {k: v for k, v in a.items() if k not in ("bandas", "frecuencias", "concesiones", "bandsScannedAt")}
            for a in ds["antenas"]
        ]
        restored = fa.preserve_bands_in_records(fresh, prior_index)
        self.assertEqual(restored, 4)
        for ant in fresh:
            self.assertEqual(ant["bandas"], ["3500 MHz"])

    def test_publish_scan_status_batched_chunks_tail_cache_and_archive_restore(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            bare_origin = tmp / "origin.git"
            work_repo = tmp / "work"
            work_repo.mkdir(parents=True)

            subprocess.run(["git", "init", "--bare", str(bare_origin)], check=True, capture_output=True)
            subprocess.run(["git", "init", str(work_repo)], check=True, capture_output=True)
            subprocess.run(["git", "remote", "add", "origin", str(bare_origin)], cwd=work_repo, check=True, capture_output=True)

            live_dir = tmp / "live-batch"
            live_dir.mkdir(parents=True)
            status_path = live_dir / "scan-status.json"
            tail_path = live_dir / "live-tail.json"

            for idx in range(3):
                (live_dir / f"live-chunk-{idx}.json").write_text(
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "scanId": "scan-batch-1",
                            "seq": idx + 1,
                            "chunkIndex": idx,
                            "isTail": False,
                            "updatedAt": "2026-11-21T10:00:00Z",
                            "recordNovedades": True,
                            "previousScanAt": None,
                            "replacesNewAntennas": False,
                            "newAntennas": [],
                            "bandPatches": [{"id": f"M-{idx}", "gid": f"28000{idx}", "bandas": ["700 MHz"]}],
                            "novedades": [],
                        }
                    ),
                    encoding="utf-8",
                )

            tail_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "scanId": "scan-batch-1",
                        "seq": 4,
                        "chunkIndex": 3,
                        "isTail": True,
                        "updatedAt": "2026-11-21T10:01:00Z",
                        "recordNovedades": True,
                        "previousScanAt": None,
                        "replacesNewAntennas": False,
                        "newAntennas": [],
                        "bandPatches": [],
                        "novedades": [],
                    }
                ),
                encoding="utf-8",
            )
            status_path.write_text(
                json.dumps(
                    fa.build_scan_status_payload(
                        state="running",
                        scan_id="scan-batch-1",
                        trigger="workflow_dispatch",
                        record_novedades=True,
                        part="1/2",
                        phase="frecuencias",
                        started_at="2026-11-21T10:00:00Z",
                        total_antennas=100,
                        scanned_antennas=50,
                        delta_seq=4,
                        chunk_count=3,
                    )
                ),
                encoding="utf-8",
            )

            blob_cache: dict[str, str] = {}
            tail_cache: dict[str, tuple[int, int, str]] = {}
            ok1 = pss.push_status_to_branch(
                status_path,
                live_dir=live_dir,
                branch="scan-status",
                blob_sha_cache=blob_cache,
                cwd=work_repo,
                tail_sha_cache=tail_cache,
            )
            self.assertTrue(ok1)
            self.assertEqual(len(blob_cache), 3)
            self.assertIn("live-tail.json", tail_cache)
            first_tail_sha = tail_cache["live-tail.json"][2]

            # Segundo push con live-tail sin cambios reutiliza exactamente el SHA en caché
            ok2 = pss.push_status_to_branch(
                status_path,
                live_dir=live_dir,
                branch="scan-status",
                blob_sha_cache=blob_cache,
                cwd=work_repo,
                tail_sha_cache=tail_cache,
            )
            self.assertTrue(ok2)
            self.assertEqual(tail_cache["live-tail.json"][2], first_tail_sha)

            # Restaurar por lote mediante git archive y comprobar los 5 archivos
            restore_dir = tmp / "restored-batch"
            restored_ok = pss.restore_from_branch(
                restore_dir / "scan-status.json",
                live_dir=restore_dir,
                branch="scan-status",
                expected_scan_id="scan-batch-1",
                cwd=work_repo,
            )
            self.assertTrue(restored_ok)
            restored_files = sorted(p.name for p in restore_dir.iterdir())
            self.assertEqual(
                restored_files,
                [
                    "live-chunk-0.json",
                    "live-chunk-1.json",
                    "live-chunk-2.json",
                    "live-tail.json",
                    "scan-status.json",
                ],
            )


if __name__ == "__main__":
    unittest.main()




