import json
from pathlib import Path
import unittest

from scripts.build_unico_5g import (
    OPERATOR_ORDER,
    build_unico_5g_dataset,
    normalize_province_and_ccaa,
    normalize_unico_operator,
)


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


if __name__ == "__main__":
    unittest.main()
