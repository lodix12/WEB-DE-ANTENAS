import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import build_unico_5g as bu
from scripts import fetch_antenas as fa
from scripts.build_unico_5g import (
    BIT_B7_PLUS,
    BIT_B20,
    BIT_N28,
    BIT_N28_PLUS,
    BIT_N78,
    BIT_N258,
    OPERATOR_ORDER,
    UNICO_DECLARED_ANY_MASK,
    apply_unico_declarations,
    build_unico_5g_dataset,
    compute_antenna_rf_band_mask,
    compute_antenna_unico_5g_mask,
    compute_declared_summary,
    haversine_distance_km,
    match_unico_declared_antennas_masks,
    normalize_province_and_ccaa,
    normalize_unico_operator,
    resolve_real_station_unico_op,
    sync_unico_5g_declarations_file,
)


def _sample_unico_dataset() -> dict:
    return {
        "schemaVersion": 1,
        "program": "UNICO 5G Redes Activas",
        "updatedAt": "2026-11-24T18:07:06Z",
        "total": 3,
        "fase1Total": 2,
        "fase2Total": 1,
        "fase2ProjectsTotal": 1,
        "operators": {
            "movistar": {
                "key": "movistar",
                "label": "Telefonica",
                "total": 1,
                "fase1": 1,
                "fase2": 0,
                "proyectosFase2": 0,
                "entities": [],
            },
            "orange": {
                "key": "orange",
                "label": "Orange",
                "total": 1,
                "fase1": 1,
                "fase2": 0,
                "proyectosFase2": 0,
                "entities": [],
            },
            "vodafone": {
                "key": "vodafone",
                "label": "Vodafone",
                "total": 1,
                "fase1": 0,
                "fase2": 1,
                "proyectosFase2": 1,
                "entities": [],
            },
        },
        "antenas": [
            {
                "id": "u5g-1",
                "fase": 1,
                "op": "movistar",
                "empresa": "TELEFÓNICA MÓVILES ESPAÑA, S.A.",
                "ccaa": "Comunidad de Madrid",
                "prov": "MADRID",
                "mun": "Madrid",
                "lat": 40.4168,
                "lon": -3.7038,
            },
            {
                "id": "u5g-2",
                "fase": 1,
                "op": "orange",
                "empresa": "AVATEL TELECOM S.A.",
                "ccaa": "Comunidad de Madrid",
                "prov": "MADRID",
                "mun": "Alcalá de Henares",
                "lat": 40.4819,
                "lon": -3.3635,
            },
            {
                "id": "u5g-3",
                "fase": 2,
                "op": "vodafone",
                "empresa": "VODAFONE ESPAÑA S.A.",
                "ccaa": "Cataluña",
                "prov": "BARCELONA",
                "mun": "Barcelona",
                "lat": 41.3851,
                "lon": 2.1734,
            },
        ],
    }


class TestBuildUnico5g(unittest.TestCase):
    def test_orange_and_avatel_grouping(self) -> None:
        self.assertEqual(normalize_unico_operator("ORANGE ESPAGNE S.A."), "orange")
        self.assertEqual(
            normalize_unico_operator("UTE ORANGE ESPAGNE Y ORANGE COMUNICACIONES FIJAS"),
            "orange",
        )
        self.assertEqual(normalize_unico_operator("AVATEL TELECOM S.A."), "orange")
        self.assertEqual(normalize_unico_operator("TELEFÓNICA MÓVILES ESPAÑA, S.A."), "movistar")
        self.assertEqual(normalize_unico_operator("VODAFONE ESPAÑA S.A."), "vodafone")

    def test_province_and_ccaa_normalization(self) -> None:
        self.assertEqual(normalize_province_and_ccaa("Balears, Illes"), ("ILLES BALEARS", "Illes Balears"))
        self.assertEqual(normalize_province_and_ccaa("Coruña, A"), ("A CORUÑA", "Galicia"))
        self.assertEqual(normalize_province_and_ccaa("Palmas, Las"), ("LAS PALMAS", "Canarias"))
        self.assertEqual(normalize_province_and_ccaa("Rioja, La"), ("LA RIOJA", "La Rioja"))
        self.assertEqual(normalize_province_and_ccaa("Araba/Álava"), ("ÁLAVA", "País Vasco"))

    def test_rf_band_mask_classification_parity(self) -> None:
        # Direct codes (case-insensitive, spacing around '+')
        self.assertEqual(compute_antenna_unico_5g_mask({"bandas": ["N78"]}), BIT_N78)
        self.assertEqual(compute_antenna_unico_5g_mask({"bandas": [" n28 + "]}), BIT_N28_PLUS)
        self.assertEqual(compute_antenna_unico_5g_mask({"bandas": ["n28"]}), BIT_N28)
        self.assertEqual(compute_antenna_rf_band_mask({"bandas": ["b7 +"]}), BIT_B7_PLUS)
        self.assertEqual(compute_antenna_unico_5g_mask({"bandas": ["b7+"]}), 0)

        # Frequency ranges & GHz conversion & concesiones
        self.assertEqual(
            compute_antenna_unico_5g_mask({"frecuencias": ["3600.00 - 3700.00"]}),
            BIT_N78,
        )
        self.assertEqual(
            compute_antenna_unico_5g_mask({"bandas": ["3,5 GHz"]}),
            BIT_N78,
        )
        self.assertEqual(
            compute_antenna_unico_5g_mask(
                {"concesiones": [{"ref": "C-1", "freq": "3.50 - 3.60 GHz"}]}
            ),
            BIT_N78,
        )
        self.assertEqual(
            compute_antenna_unico_5g_mask({"frecuencias": ["758.00 - 768.00"]}),
            BIT_N28,
        )
        # N28+ suppresses implicit N28 from 700 MHz label and 700 MHz range
        self.assertEqual(
            compute_antenna_unico_5g_mask(
                {
                    "frecuencias": ["758.00 - 788.00", "758.00 - 768.00"],
                    "bandas": ["700 MHz"],
                }
            ),
            BIT_N28_PLUS,
        )
        # Explicit 'N28' code coexists with N28+
        self.assertEqual(
            compute_antenna_unico_5g_mask(
                {
                    "frecuencias": ["758.00 - 788.00"],
                    "bandas": ["N28"],
                }
            ),
            BIT_N28 | BIT_N28_PLUS,
        )
        # Commercial label alone activates N28 when no 700 MHz range was seen
        self.assertEqual(
            compute_antenna_unico_5g_mask({"bandas": ["700 MHz", "3500 MHz"]}),
            BIT_N28 | BIT_N78,
        )
        # Non-UNICO bands (e.g. B20, N258) do not trigger UNICO 5G bits
        ant_non_unico = {
            "frecuencias": ["801.00 - 811.00", "26.5 - 27.5 GHz"],
            "bandas": ["800 MHz", "26 GHz"],
        }
        self.assertEqual(compute_antenna_rf_band_mask(ant_non_unico), BIT_B20 | BIT_N258)
        self.assertEqual(compute_antenna_unico_5g_mask(ant_non_unico), 0)

    def test_resolve_real_station_unico_op(self) -> None:
        self.assertEqual(resolve_real_station_unico_op({"op": "movistar"}), "movistar")
        self.assertEqual(resolve_real_station_unico_op({"op": "vodafone"}), "vodafone")
        self.assertEqual(resolve_real_station_unico_op({"op": "orange"}), "orange")
        self.assertEqual(resolve_real_station_unico_op({"op": "masmovil"}), "orange")
        self.assertEqual(
            resolve_real_station_unico_op({"op": "otros", "opRaw": "AVATEL TELECOM S.A."}),
            "orange",
        )
        for legal_name in (
            "XFERA MÓVILES, S.A.U.",
            "MÁSMÓVIL IBERCOM, S.A.",
            "YOIGO TELECOM",
            "EUSKALTEL, S.A.",
            "R CABLE Y TELECABLE",
            "TELECABLE DE ASTURIAS",
        ):
            self.assertEqual(
                resolve_real_station_unico_op({"op": "otros", "opRaw": legal_name}),
                "orange",
            )
        self.assertIsNone(resolve_real_station_unico_op({"op": "digi", "opRaw": "DIGI SPAIN"}))
        self.assertIsNone(resolve_real_station_unico_op({"op": "otros", "opRaw": "OTRA"}))

    def test_nearest_valid_station_matching_within_1200m(self) -> None:
        # 1 degree of latitude is ~111.195 km:
        # - 0.0103 deg ~= 1.145 km (> 1.0 km, <= 1.2 km)
        # - 0.0115 deg ~= 1.279 km (> 1.2 km)
        self.assertEqual(bu.UNICO_MAX_MATCH_DISTANCE_KM, 1.2)
        self.assertGreater(haversine_distance_km(40.0, -3.0, 40.0103, -3.0), 1.0)
        self.assertLessEqual(haversine_distance_km(40.0, -3.0, 40.0103, -3.0), 1.2)
        self.assertGreater(haversine_distance_km(40.0, -3.0, 40.0115, -3.0), 1.2)

        unico_antenas = [
            # 0: matches Movistar at ~1.145 km (<= 1.2 km) with N78
            {"id": "u-0", "op": "movistar", "lat": 40.0, "lon": -3.0},
            # 1: Movistar station is > 1.2 km away (~1.279 km) -> 0
            {"id": "u-1", "op": "movistar", "lat": 40.2, "lon": -3.0},
            # 2: nearest same-op stations (~111 m 4G-only, ~334 m B7+N258, ~445 m sin bandas) are invalid;
            #    ~556 m has solo N28, ~1.000 m has N78, ~1.145 m has N28+:
            #    MUST prefer N78 (~1.000 m) over closer solo N28 (~556 m) and over farther N28+ (~1.145 m)
            {"id": "u-2", "op": "vodafone", "lat": 40.4, "lon": -3.0},
            # 3: crosses GRID_CELL_DEG=0.02 cell boundary (40.0199 vs 40.0201) + legacy masmovil -> orange
            {"id": "u-3", "op": "orange", "lat": 40.0199, "lon": -3.5},
            # 4: AVATEL station (op='otros', opRaw='AVATEL') matches orange UNICO record
            {"id": "u-4", "op": "orange", "lat": 41.0, "lon": -2.0},
        ]

        real_antenas = [
            # Wrong operator at exact same spot as u-0 must be ignored
            {
                "op": "vodafone",
                "lat": 40.0,
                "lon": -3.0,
                "frecuencias": ["758.00 - 788.00"],
            },
            # Movistar within 1.2 km (~1.145 km) of u-0 with N78
            {
                "op": "movistar",
                "lat": 40.0103,
                "lon": -3.0,
                "frecuencias": ["3600.00 - 3700.00"],
            },
            # Movistar > 1.2 km (~1.279 km) from u-1
            {
                "op": "movistar",
                "lat": 40.2115,
                "lon": -3.0,
                "frecuencias": ["3600.00 - 3700.00"],
            },
            # Vodafone invalid #1: 4G-only closer (~111 m) to u-2
            {
                "op": "vodafone",
                "lat": 40.401,
                "lon": -3.0,
                "frecuencias": ["801.00 - 811.00"],
            },
            # Vodafone invalid #2: non-UNICO bands (~334 m) to u-2
            {
                "op": "vodafone",
                "lat": 40.403,
                "lon": -3.0,
                "frecuencias": ["2620.00 - 2640.00", "26.5 - 27.5 GHz"],
            },
            # Vodafone invalid #3: sin frecuencias (~445 m) to u-2
            {
                "op": "vodafone",
                "lat": 40.404,
                "lon": -3.0,
                "frecuencias": [],
            },
            # Vodafone solo N28 closer (~556 m) -> secondary tier when N78/N28+ exists <= 1.2 km
            {
                "op": "vodafone",
                "lat": 40.405,
                "lon": -3.0,
                "frecuencias": ["758.00 - 768.00"],
            },
            # Vodafone preferred #1: N78 (~1.000 m) -> MUST win over closer solo N28 (~556 m)
            {
                "op": "vodafone",
                "lat": 40.409,
                "lon": -3.0,
                "frecuencias": ["3600.00 - 3700.00"],
            },
            # Vodafone preferred #2: N28+ farther (~1.145 m) -> loses by distance against N78 (~1.000 m)
            {
                "op": "vodafone",
                "lat": 40.4103,
                "lon": -3.0,
                "frecuencias": ["758.00 - 788.00"],
            },
            # Legacy masmovil across 0.02 grid boundary from u-3 with N28+
            {
                "op": "masmovil",
                "lat": 40.0201,
                "lon": -3.5,
                "frecuencias": ["758.00 - 788.00"],
            },
            # AVATEL station at u-4 with N28 + N78
            {
                "op": "otros",
                "opRaw": "AVATEL TELECOM S.A.",
                "lat": 41.0005,
                "lon": -2.0,
                "frecuencias": ["758.00 - 768.00", "3500.00 - 3600.00"],
            },
        ]

        masks = match_unico_declared_antennas_masks(unico_antenas, real_antenas)
        self.assertEqual(masks, [BIT_N78, 0, BIT_N78, BIT_N28_PLUS, BIT_N28 | BIT_N78])

    def test_one_to_one_per_operator_and_shared_multiop_tower(self) -> None:
        # 1) Dos proyectos Movistar apuntan a MV-1 (40.0, -3.5):
        #    - u-mv-far (~445 m) aparece antes en la lista que u-mv-close (~111 m),
        #      pero u-mv-close está más cerca y se queda MV-1 (N78).
        #    - u-mv-far busca la siguiente antena Movistar válida más cercana libre: MV-2 (N28) a ~333 m al norte.
        # 2) Un tercer proyecto Movistar u-mv-exhausted (~222 m al sur de MV-1) tiene MV-1 ocupada
        #    y MV-2 ya ocupada (a ~1.0 km) / sin otra libre -> queda 0.
        # 3) Un proyecto Vodafone en el mismo emplazamiento compartido (< 15 m de MV-1)
        #    coincide con VF-SHARED (N28+) sin verse bloqueado por Movistar.
        unico_antenas = [
            {"id": "u-mv-far", "op": "movistar", "lat": 40.004, "lon": -3.5},
            {"id": "u-mv-close", "op": "movistar", "lat": 40.001, "lon": -3.5},
            {"id": "u-mv-exhausted", "op": "movistar", "lat": 39.998, "lon": -3.5},
            {"id": "u-vf-shared", "op": "vodafone", "lat": 40.00005, "lon": -3.5},
        ]
        real_antenas = [
            {
                "id": "MV-1",
                "op": "movistar",
                "lat": 40.0,
                "lon": -3.5,
                "frecuencias": ["3600.00 - 3700.00"],
            },
            {
                "id": "MV-2",
                "op": "movistar",
                "lat": 40.007,
                "lon": -3.5,
                "frecuencias": ["758.00 - 768.00"],
            },
            {
                "id": "VF-SHARED",
                "op": "vodafone",
                "lat": 40.00003,
                "lon": -3.5,
                "frecuencias": ["758.00 - 788.00"],
            },
        ]

        masks = match_unico_declared_antennas_masks(unico_antenas, real_antenas)
        self.assertEqual(masks, [BIT_N28, BIT_N78, 0, BIT_N28_PLUS])

        # Caso cascada con preferencia N78/N28+ sobre solo N28 (A [N78], B [solo N28], C [N28+]):
        # Distancias:
        # - Nivel 0 (N78 / N28+):
        #   * u-c1 -> OR-1 (~11 m, N78) gana OR-1 (N78)
        #   * u-c3 -> OR-3 (~389 m, N28+) está más cerca de OR-3 que u-c2 (~556 m) -> u-c3 gana OR-3 (N28+)
        #     pese a tener OR-2 (solo N28) a ~55 m
        # - Nivel 1 (solo N28):
        #   * u-c2 sin N78/N28+ libres cae en respaldo a OR-2 (~222 m, solo N28)
        cascade_unico = [
            {"id": "u-c1", "op": "orange", "lat": 41.0001, "lon": -2.0},
            {"id": "u-c2", "op": "orange", "lat": 41.0010, "lon": -2.0},
            {"id": "u-c3", "op": "orange", "lat": 41.0025, "lon": -2.0},
        ]
        cascade_real = [
            {"id": "OR-1", "op": "orange", "lat": 41.0000, "lon": -2.0, "frecuencias": ["3600.00 - 3700.00"]},
            {"id": "OR-2", "op": "orange", "lat": 41.0030, "lon": -2.0, "frecuencias": ["758.00 - 768.00"]},
            {"id": "OR-3", "op": "orange", "lat": 41.0060, "lon": -2.0, "frecuencias": ["758.00 - 788.00"]},
        ]
        cascade_masks = match_unico_declared_antennas_masks(cascade_unico, cascade_real)
        self.assertEqual(cascade_masks, [BIT_N78, BIT_N28, BIT_N28_PLUS])

        # Preferencia N28+ sobre solo N28 más cercana, y orden por cercanía cuando N78 y N28+ compiten:
        # - u-pref-1 (42.0): solo N28 a ~50 m, N28+ a ~1.145 m -> elige N28+
        # - u-pref-2 (42.2): solo N28 a ~50 m, N28+ a ~400 m, N78 a ~900 m -> elige N28+ (más cercana del nivel 0)
        # - u-pref-3 (42.4): solo N28 a ~50 m, N78 a ~1.279 m (> 1.2 km) -> cae en respaldo a solo N28
        pref_unico = [
            {"id": "u-pref-1", "op": "movistar", "lat": 42.0, "lon": -2.5},
            {"id": "u-pref-2", "op": "orange", "lat": 42.2, "lon": -2.5},
            {"id": "u-pref-3", "op": "vodafone", "lat": 42.4, "lon": -2.5},
        ]
        pref_real = [
            {"id": "MV-P1-N28", "op": "movistar", "lat": 42.00045, "lon": -2.5, "frecuencias": ["758.00 - 768.00"]},
            {"id": "MV-P1-N28P", "op": "movistar", "lat": 42.0103, "lon": -2.5, "frecuencias": ["758.00 - 788.00"]},
            {"id": "OR-P2-N28", "op": "orange", "lat": 42.20045, "lon": -2.5, "frecuencias": ["758.00 - 768.00"]},
            {"id": "OR-P2-N28P", "op": "orange", "lat": 42.2036, "lon": -2.5, "frecuencias": ["758.00 - 788.00"]},
            {"id": "OR-P2-N78", "op": "orange", "lat": 42.2081, "lon": -2.5, "frecuencias": ["3600.00 - 3700.00"]},
            {"id": "VF-P3-N28", "op": "vodafone", "lat": 42.40045, "lon": -2.5, "frecuencias": ["758.00 - 768.00"]},
            {"id": "VF-P3-N78-OUT", "op": "vodafone", "lat": 42.4115, "lon": -2.5, "frecuencias": ["3600.00 - 3700.00"]},
        ]
        self.assertEqual(
            match_unico_declared_antennas_masks(pref_unico, pref_real),
            [BIT_N28_PLUS, BIT_N28_PLUS, BIT_N28],
        )

        # Empate exacto de distancia: menor unicoIdx gana; entre estaciones equidistantes, menor stationIdx gana
        tie_unico = [
            {"id": "u-t0", "op": "movistar", "lat": 39.5, "lon": -3.0},
            {"id": "u-t1", "op": "movistar", "lat": 39.5, "lon": -3.0},
        ]
        tie_real = [
            {"id": "T-A", "op": "movistar", "lat": 39.501, "lon": -3.0, "frecuencias": ["3600.00 - 3700.00"]},
            {"id": "T-B", "op": "movistar", "lat": 39.499, "lon": -3.0, "frecuencias": ["758.00 - 768.00"]},
        ]
        self.assertEqual(match_unico_declared_antennas_masks(tie_unico, tie_real), [BIT_N78, BIT_N28])

        # Saltos sobre antenas no válidas (4G-only) y ocupadas de más cercano a lejano hasta 1.200 m:
        # (a) Dos proyectos Vodafone con la misma 4G-only más cercana: ambos la saltan; u-4g-2 está más
        #     cerca de VF-5G (39.105) que u-4g-1 -> u-4g-2 gana VF-5G (N78) y u-4g-1 salta a VF-5G-2 (N28+, ~1.112 m).
        # (b) Fallback tras 5G reclamada (OR-5G-1) que atraviesa dos 4G-only intermedias (OR-4G-2, OR-4G-3)
        #     y alcanza OR-5G-4 (N28 a ~1.112 m <= 1.200 m).
        fourg_unico = [
            {"id": "u-4g-1", "op": "vodafone", "lat": 39.1, "lon": -2.0},
            {"id": "u-4g-2", "op": "vodafone", "lat": 39.1002, "lon": -2.0},
            {"id": "u-fb-1", "op": "orange", "lat": 39.2, "lon": -2.0},
            {"id": "u-fb-2", "op": "orange", "lat": 39.201, "lon": -2.0},
        ]
        fourg_real = [
            {"id": "VF-4G", "op": "vodafone", "lat": 39.1001, "lon": -2.0, "frecuencias": ["791.00 - 801.00"]},
            {"id": "VF-5G", "op": "vodafone", "lat": 39.105, "lon": -2.0, "frecuencias": ["3600.00 - 3700.00"]},
            {"id": "VF-5G-2", "op": "vodafone", "lat": 39.110, "lon": -2.0, "frecuencias": ["758.00 - 788.00"]},
            {"id": "OR-5G-1", "op": "orange", "lat": 39.2, "lon": -2.0, "frecuencias": ["3600.00 - 3700.00"]},
            {"id": "OR-4G-2", "op": "orange", "lat": 39.203, "lon": -2.0, "frecuencias": ["791.00 - 801.00"]},
            {"id": "OR-4G-3", "op": "orange", "lat": 39.206, "lon": -2.0, "frecuencias": ["1805.00 - 1825.00"]},
            {"id": "OR-5G-4", "op": "orange", "lat": 39.211, "lon": -2.0, "frecuencias": ["758.00 - 768.00"]},
        ]
        self.assertEqual(
            match_unico_declared_antennas_masks(fourg_unico, fourg_real),
            [BIT_N28_PLUS, BIT_N78, BIT_N78, BIT_N28],
        )

        # Protección ante ID duplicado en dataset sintético y coordenadas no finitas/booleanas/inválidas
        dup_unico = [
            {"id": "u-d1", "op": "movistar", "lat": 39.3, "lon": -2.5},
            {"id": "u-d2", "op": "movistar", "lat": 39.303, "lon": -2.5},
            {"id": "u-bad-nan", "op": "movistar", "lat": float("nan"), "lon": -2.5},
            {"id": "u-bad-bool", "op": "movistar", "lat": True, "lon": False},
            "not-a-dict",
        ]
        dup_real = [
            {"id": "MV-DUP", "op": "movistar", "lat": 39.3001, "lon": -2.5, "frecuencias": ["3600.00 - 3700.00"]},
            {"id": "MV-DUP", "op": "movistar", "lat": 39.3035, "lon": -2.5, "frecuencias": ["758.00 - 768.00"]},
            {"id": "MV-INF", "op": "movistar", "lat": float("inf"), "lon": -2.5, "frecuencias": ["3600.00 - 3700.00"]},
            {"id": "MV-BOOL", "op": "movistar", "lat": True, "lon": False, "frecuencias": ["3600.00 - 3700.00"]},
        ]
        self.assertEqual(
            match_unico_declared_antennas_masks(dup_unico, dup_real),  # type: ignore[arg-type]
            [BIT_N78, 0, 0, 0, 0],
        )

    def test_sync_unico_5g_declarations_file_and_cli(self) -> None:
        unico_doc = _sample_unico_dataset()
        antenas_doc = {
            "updatedAt": "2026-11-24T12:34:56Z",
            "total": 2,
            "antenas": [
                {
                    "id": "T-1",
                    "gid": "1",
                    "op": "movistar",
                    "opRaw": "TELEFONICA",
                    "lat": 40.4170,
                    "lon": -3.7038,
                    "frecuencias": ["758.00 - 768.00", "3600.00 - 3700.00"],
                },
                {
                    "id": "A-1",
                    "gid": "2",
                    "op": "otros",
                    "opRaw": "AVATEL TELECOM",
                    "lat": 40.4820,
                    "lon": -3.3635,
                    "frecuencias": ["758.00 - 788.00"],
                },
            ],
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            unico_file = tmp_path / "unico-5g.json"
            antenas_file = tmp_path / "antenas.json"
            unico_file.write_text(json.dumps(unico_doc), encoding="utf-8")
            antenas_file.write_text(json.dumps(antenas_doc), encoding="utf-8")

            # Sync using in-memory dict
            updated = sync_unico_5g_declarations_file(unico_file, antenas_doc)
            self.assertEqual(updated["declaredUpdatedAt"], "2026-11-24T12:34:56Z")
            self.assertEqual(updated["updatedAt"], unico_doc["updatedAt"])
            self.assertEqual(updated["declaredMasks"], [BIT_N28 | BIT_N78, BIT_N28_PLUS, 0])
            self.assertEqual(
                updated["declaredSummary"],
                {
                    "total": 3,
                    "declared": 2,
                    "byBand": {"all": 2, "N78": 1, "N28": 1, "N28+": 1},
                    "byOperator": {
                        "movistar": {"total": 1, "declared": 1, "N78": 1, "N28": 1, "N28+": 0},
                        "orange": {"total": 1, "declared": 1, "N78": 0, "N28": 0, "N28+": 1},
                        "vodafone": {"total": 1, "declared": 0, "N78": 0, "N28": 0, "N28+": 0},
                    },
                },
            )
            first_bytes = unico_file.read_bytes()

            # CLI --sync-antenas is idempotent and does not require Excel files
            bu.main(
                [
                    "--sync-antenas",
                    str(antenas_file),
                    "--unico-file",
                    str(unico_file),
                ]
            )
            self.assertEqual(unico_file.read_bytes(), first_bytes)

            # Verify no forbidden keys were introduced
            reloaded = json.loads(unico_file.read_text(encoding="utf-8"))
            forbidden_keys = {"emplazamiento", "codigoEmplazamiento", "idPropietario", "propietario"}
            for rec in reloaded["antenas"]:
                self.assertTrue(forbidden_keys.isdisjoint(rec.keys()))

    def test_fetch_antenas_sync_unico_helper_and_main_integration(self) -> None:
        default_args = fa.parse_args([])
        self.assertIsNone(default_args.unico_output)
        self.assertFalse(default_args.skip_unico_sync)

        unico_doc = _sample_unico_dataset()
        antenas_doc = {
            "updatedAt": "2026-11-24T15:00:00Z",
            "sourceUrl": fa.PORTAL_SOURCE_URL,
            "total": 1,
            "crawlStats": {
                "requestsCount": 1,
                "durationSeconds": 0.1,
                "gridBoxesVisited": 1,
                "subdividedBoxes": 0,
                "zoomParam": 7,
                "delaySeconds": 0.0,
                "isPartialSeed": True,
                "bandsPopulatedCount": 1,
            },
            "operators": {},
            "provinces": [],
            "antenas": [
                {
                    "id": "TELEFONICA - 280001",
                    "gid": "280001",
                    "op": "movistar",
                    "opRaw": "TELEFONICA MOVILES ESPANA",
                    "lat": 40.4168,
                    "lon": -3.7038,
                    "dir": "SOL",
                    "mun": "MADRID",
                    "prov": "MADRID",
                    "bandas": ["3500 MHz"],
                    "frecuencias": ["3600.00 - 3700.00"],
                    "concesiones": [{"ref": "C-1", "freq": "3600.00 - 3700.00"}],
                    "bandsScannedAt": "2026-11-24T15:00:00Z",
                }
            ],
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            antenas_file = tmp_path / "antenas.json"
            sibling_unico = tmp_path / "unico-5g.json"
            explicit_unico = tmp_path / "custom-unico.json"

            # Missing target -> returns False
            self.assertFalse(
                fa._sync_unico_5g_declarations(antenas_doc, antenas_file, None, False)
            )

            sibling_unico.write_text(json.dumps(unico_doc), encoding="utf-8")
            # skip_unico_sync=True -> returns False and leaves file untouched
            raw_before = sibling_unico.read_text(encoding="utf-8")
            self.assertFalse(
                fa._sync_unico_5g_declarations(antenas_doc, antenas_file, None, True)
            )
            self.assertEqual(sibling_unico.read_text(encoding="utf-8"), raw_before)

            # Default sibling path sync
            self.assertTrue(
                fa._sync_unico_5g_declarations(antenas_doc, antenas_file, None, False)
            )
            synced_sibling = json.loads(sibling_unico.read_text(encoding="utf-8"))
            self.assertEqual(synced_sibling["declaredMasks"], [BIT_N78, 0, 0])
            self.assertEqual(synced_sibling["declaredUpdatedAt"], "2026-11-24T15:00:00Z")

            # Explicit unico_output path sync via --enrich-bands-only in main()
            antenas_file.write_text(json.dumps(antenas_doc), encoding="utf-8")
            explicit_unico.write_text(json.dumps(unico_doc), encoding="utf-8")
            rc_enrich = fa.main(
                [
                    "--enrich-bands-only",
                    "--input",
                    str(antenas_file),
                    "--output",
                    str(antenas_file),
                    "--unico-output",
                    str(explicit_unico),
                    "--delay",
                    "0",
                ]
            )
            self.assertEqual(rc_enrich, 0)
            synced_explicit = json.loads(explicit_unico.read_text(encoding="utf-8"))
            self.assertEqual(synced_explicit["declaredMasks"], [BIT_N78, 0, 0])

            # Full scan mode (non-fetch-bands path) updates sibling unico-5g.json
            sibling_unico.write_text(json.dumps(unico_doc), encoding="utf-8")
            with mock.patch.object(fa.InfoantenasCrawler, "crawl", return_value=antenas_doc):
                rc_full = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(antenas_file),
                        "--delay",
                        "0",
                    ]
                )
            self.assertEqual(rc_full, 0)
            synced_after_full = json.loads(sibling_unico.read_text(encoding="utf-8"))
            self.assertEqual(synced_after_full["declaredMasks"], [BIT_N78, 0, 0])

            # Full scan mode with --fetch-bands updates explicit unico-5g.json
            explicit_unico.write_text(json.dumps(unico_doc), encoding="utf-8")
            with mock.patch.object(fa.InfoantenasCrawler, "crawl", return_value=antenas_doc):
                rc_fetch_bands = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(antenas_file),
                        "--fetch-bands",
                        "--unico-output",
                        str(explicit_unico),
                        "--delay",
                        "0",
                    ]
                )
            self.assertEqual(rc_fetch_bands, 0)
            synced_after_fb = json.loads(explicit_unico.read_text(encoding="utf-8"))
            self.assertEqual(synced_after_fb["declaredMasks"], [BIT_N78, 0, 0])

            # --skip-unico-sync prevents updating unico-5g.json
            sibling_unico.write_text(json.dumps(unico_doc), encoding="utf-8")
            raw_skip_before = sibling_unico.read_text(encoding="utf-8")
            with mock.patch.object(fa.InfoantenasCrawler, "crawl", return_value=antenas_doc):
                rc_skip = fa.main(
                    [
                        "--region",
                        "sample",
                        "--output",
                        str(antenas_file),
                        "--skip-unico-sync",
                        "--delay",
                        "0",
                    ]
                )
            self.assertEqual(rc_skip, 0)
            self.assertEqual(sibling_unico.read_text(encoding="utf-8"), raw_skip_before)

    def test_generated_dataset_integrity(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent
        json_path = repo_root / "public" / "data" / "unico-5g.json"
        if not json_path.exists():
            fase1 = Path("/home/antigravity/UNICO_5G_REDES_ACTIVAS_FASE_1.xlsx")
            fase2 = Path("/home/antigravity/Unico_5G_Redes_Activas_Fase_2.xlsx")
            ine = repo_root / "scripts" / "ine_municipios.json"
            data = build_unico_5g_dataset(fase1, fase2, ine)
        else:
            data = json.loads(json_path.read_text(encoding="utf-8"))

        self.assertEqual(data["fase1Total"], 7330)
        self.assertEqual(data["fase2Total"], 1961)
        self.assertEqual(data["total"], 9291)
        self.assertEqual(len(data["antenas"]), 9291)

        # Agrupación completa de proyectos de Orange + Avatel dentro de 'orange'
        orange_summary = data["operators"]["orange"]
        self.assertEqual(orange_summary["fase1"], 1987)  # 1505 Orange + 482 Avatel
        self.assertEqual(orange_summary["fase2"], 845)   # 445 UTE + 400 Orange Espagne
        self.assertEqual(orange_summary["total"], 2832)
        self.assertNotIn("avatel", data["operators"])

        forbidden_keys = {"emplazamiento", "codigoEmplazamiento", "idPropietario", "propietario"}
        for rec in data["antenas"]:
            self.assertTrue(forbidden_keys.isdisjoint(rec.keys()))
            self.assertIn(rec["op"], OPERATOR_ORDER)
            self.assertIn(rec["fase"], (1, 2))

    def test_public_unico_5g_declarations_consistent_with_antenas(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent
        unico_path = repo_root / "public" / "data" / "unico-5g.json"
        antenas_path = repo_root / "public" / "data" / "antenas.json"
        if not unico_path.exists() or not antenas_path.exists():
            self.skipTest("Datasets públicos no disponibles en disco")

        unico_data = json.loads(unico_path.read_text(encoding="utf-8"))
        antenas_data = json.loads(antenas_path.read_text(encoding="utf-8"))

        self.assertEqual(unico_data.get("declaredUpdatedAt"), antenas_data.get("updatedAt"))

        declared_masks = unico_data.get("declaredMasks")
        self.assertIsInstance(declared_masks, list)
        self.assertEqual(len(declared_masks), len(unico_data["antenas"]))
        self.assertTrue(
            all(isinstance(m, int) and (m & ~UNICO_DECLARED_ANY_MASK) == 0 for m in declared_masks)
        )

        expected = apply_unico_declarations(unico_data, antenas_data)
        self.assertEqual(declared_masks, expected["declaredMasks"])
        self.assertEqual(unico_data.get("declaredSummary"), expected["declaredSummary"])

        summary = unico_data["declaredSummary"]
        self.assertEqual(summary["total"], unico_data["total"])
        self.assertEqual(summary["byBand"]["all"], summary["declared"])
        self.assertGreater(summary["declared"], 0)
        self.assertLessEqual(summary["declared"], summary["total"])
        self.assertEqual(
            sum(summary["byOperator"][op]["total"] for op in OPERATOR_ORDER),
            summary["total"],
        )
        self.assertEqual(
            sum(summary["byOperator"][op]["declared"] for op in OPERATOR_ORDER),
            summary["declared"],
        )
        self.assertEqual(
            summary,
            compute_declared_summary(unico_data["antenas"], declared_masks),
        )


if __name__ == "__main__":
    unittest.main()
