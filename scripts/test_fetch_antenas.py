#!/usr/bin/env python3
"""Suite de pruebas unitarias para `scripts/fetch_antenas.py`."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
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

    def test_vodafone_duplicates_under_10m_fused_and_counted_as_one(self) -> None:
        # 3 declaraciones de Vodafone en A Coruña a < 10 m (~0 m y ~5.5 m):
        # "00144693" (con 2 ceros), "0144693" (con 1 cero y dirección completa),
        # "144693" (canónico sin ceros, sin dir para comprobar relleno de campos).
        records = [
            {
                "id": "VODAFONE ESPAÑA, S.A. - 00144693",
                "gid": "00144693",
                "op": "vodafone",
                "opRaw": "VODAFONE ESPAÑA, S.A.",
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
                "lat": 42.897720,  # ~3.8 m al norte
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
        self.assertEqual(fused_ant["lat"], 42.897686)
        self.assertEqual(fused_ant["lon"], -8.704622)
        self.assertEqual(fused_ant["dir"], "LG PG 78 PARC 9000 - ARUFE, S/N")
        self.assertEqual(fused_ant["mergedGids"], ["144693", "0144693", "00144693"])

        # Idempotencia al volver a pasar el dataset ya fusionado por build_dataset
        rebuilt = fa.build_dataset(
            dataset["antenas"],
            crawl_stats=dataset["crawlStats"],
            updated_at=dataset["updatedAt"],
        )
        self.assertEqual(rebuilt["total"], 1)
        self.assertEqual(rebuilt["crawlStats"]["vodafoneFusedDuplicates"], 2)
        self.assertEqual(rebuilt["antenas"][0]["mergedGids"], ["144693", "0144693", "00144693"])

    def test_vodafone_stations_at_10m_or_more_are_not_fused(self) -> None:
        # 0.000135 grados de latitud son ~15.01 metros (>= 10 m)
        lat1, lon1 = 40.416800, -3.703800
        lat2, lon2 = 40.416935, -3.703800
        self.assertGreaterEqual(fa.haversine_m(lat1, lon1, lat2, lon2), 10.0)

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

    def test_other_operators_under_10m_remain_separate_in_dataset(self) -> None:
        # Movistar + Orange + segunda Movistar a ~2 metros NO deben eliminarse
        records = [
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001",
                "gid": "2800001",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.416800,
                "lon": -3.703800,
                "dir": "GRAN VIA 28",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800002",
                "gid": "2800002",
                "op": "movistar",
                "opRaw": "TELEFONICA MOVILES ESPAÑA, S.A.U.",
                "lat": 40.416810,  # ~1.1 m
                "lon": -3.703800,
                "dir": "GRAN VIA 28",
                "mun": "MADRID",
                "prov": "MADRID",
            },
            {
                "id": "ORANGE ESPAGNE, S.A.U. - 2800003",
                "gid": "2800003",
                "op": "orange",
                "opRaw": "ORANGE ESPAGNE, S.A.U.",
                "lat": 40.416805,  # ~0.5 m
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
        self.assertEqual(dataset["total"], 4)
        self.assertEqual(dataset["operators"]["movistar"]["count"], 2)
        self.assertEqual(dataset["operators"]["orange"]["count"], 1)
        self.assertEqual(dataset["operators"]["vodafone"]["count"], 1)


if __name__ == "__main__":
    unittest.main()

