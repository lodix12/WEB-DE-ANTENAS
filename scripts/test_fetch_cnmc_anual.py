#!/usr/bin/env python3
"""Pruebas unitarias para el generador de respaldo CNMC (scripts/fetch_cnmc_anual.py)."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_cnmc_anual as cnmc


class TestFetchCnmcAnual(unittest.TestCase):
    def test_two_step_discovery_selects_published_package_and_active_datastore(self) -> None:
        calls: list[str] = []

        def fake_fetch(url: str) -> dict:
            calls.append(url)
            if "package_search" in url:
                return {
                    "success": True,
                    "result": {
                        "count": 2,
                        "results": [
                            {
                                "name": "ds_old_1",
                                "title": "Telecomunicaciones Anual Datos Generales",
                                "version": "15.0",
                                "metadata_modified": "2025-06-20T00:00:00",
                                "extras": [
                                    {"key": "estado", "value": "borrador"},
                                    {"key": "idTipoDataSetBD", "value": "203"},
                                ],
                                "resources": [
                                    {"id": "old-res", "format": "CSV", "datastore_active": True}
                                ],
                            },
                            {
                                "name": "ds_24233_1",
                                "title": "Telecomunicaciones Anual Datos Generales",
                                "version": "16.0",
                                "metadata_modified": "2026-06-22T07:11:00",
                                "license_title": "CC-BY-SA-4.0",
                                "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
                                "extras": [
                                    {"key": "estado", "value": "publicado"},
                                    {"key": "idTipoDataSetBD", "value": "203"},
                                    {"key": "periodo", "value": "1997 - 2025"},
                                    {"key": "modified", "value": "2026-06-22"},
                                    {"key": "issued", "value": "2026-06-22"},
                                    {"key": "novedad", "value": "Se incorporan los datos de 2025."},
                                    {"key": "frecuenciaActualizacion", "value": "Anual"},
                                ],
                                "resources": [
                                    {"id": "xml-res", "format": "XML", "datastore_active": False},
                                    {
                                        "id": "active-ds-uuid",
                                        "format": "CSV",
                                        "datastore_active": True,
                                        "url": "https://catalogodatos.cnmc.es/datastore/dump/active-ds-uuid",
                                    },
                                ],
                            },
                        ],
                    },
                }
            raise AssertionError(f"URL inesperada: {url}")

        meta = cnmc.resolve_cnmc_annual_resource(fetch_json=fake_fetch)
        self.assertEqual(len(calls), 1)
        self.assertIn("idTipoDataSetBD%3A203", calls[0])
        self.assertEqual(meta["resourceId"], "active-ds-uuid")
        self.assertEqual(meta["version"], "16.0")
        self.assertEqual(meta["periodo"], "1997 - 2025")
        self.assertEqual(meta["modified"], "2026-06-22")

    def test_datastore_pagination_and_compaction(self) -> None:
        calls: list[str] = []

        def fake_fetch(url: str) -> dict:
            calls.append(url)
            if "offset=0" in url:
                return {
                    "success": True,
                    "result": {
                        "total": 3,
                        "records": [
                            {
                                "_id": 1,
                                "anno": "2024",
                                "pais": "España",
                                "tipo_de_mercado": "Servicio minorista",
                                "servicio": "Datos generales",
                                "concepto": "Ingresos",
                                "operador": "Movistar",
                                "tipo_de_ingreso": "N/A",
                                "tipo_de_paquete": "N/A",
                                "unidades": "Millones de euros",
                                "ingresos": None,
                                "ingresos_por_operador": 8500.5,
                                "empleados_por_operador": None,
                                "paquetes": None,
                                "inversiones_por_operador": None,
                                "gastos_por_operador": None,
                            },
                            {
                                "_id": 2,
                                "anno": "2025",
                                "pais": "España",
                                "tipo_de_mercado": "N/A",
                                "servicio": "Datos generales",
                                "concepto": "Paquetes",
                                "operador": "N/A",
                                "tipo_de_ingreso": "N/A",
                                "tipo_de_paquete": "Tel. fija y banda ancha fija",
                                "unidades": "Unidades",
                                "ingresos": None,
                                "ingresos_por_operador": None,
                                "empleados_por_operador": None,
                                "paquetes": 2432488.0,
                                "inversiones_por_operador": None,
                                "gastos_por_operador": None,
                            },
                        ],
                    },
                }
            if "offset=2" in url:
                return {
                    "success": True,
                    "result": {
                        "total": 3,
                        "records": [
                            {
                                "_id": 3,
                                "anno": "2000",
                                "pais": "España",
                                "tipo_de_mercado": "Servicio minorista",
                                "servicio": "Datos generales",
                                "concepto": "Ingresos",
                                "operador": "N/A",
                                "tipo_de_ingreso": "N/A",
                                "tipo_de_paquete": "N/A",
                                "unidades": "Millones de euros",
                                "ingresos": 20147.0,
                                "ingresos_por_operador": 20147.0,
                                "empleados_por_operador": None,
                                "paquetes": None,
                                "inversiones_por_operador": None,
                                "gastos_por_operador": None,
                            }
                        ],
                    },
                }
            raise AssertionError(f"URL inesperada: {url}")

        rows, total = cnmc.fetch_cnmc_datastore_records(
            "res-123",
            fetch_json=fake_fetch,
            page_limit=2,
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(total, 3)
        self.assertEqual(len(rows), 3)
        self.assertEqual(
            rows[0],
            {
                "a": 2024,
                "m": "Servicio minorista",
                "c": "Ingresos",
                "o": "Movistar",
                "u": "Millones de euros",
                "ingresos_por_operador": 8500.5,
            },
        )
        self.assertEqual(rows[1]["paquetes"], 2432488)
        self.assertNotIn("o", rows[1])
        self.assertEqual(rows[2]["ingresos"], 20147)
        self.assertEqual(rows[2]["ingresos_por_operador"], 20147)


if __name__ == "__main__":
    unittest.main()
