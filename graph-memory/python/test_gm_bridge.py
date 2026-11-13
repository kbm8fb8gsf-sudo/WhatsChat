"""Tests for gm_bridge.py. Skipped unless graphify is importable by this Python.

    python -m unittest discover -s python -p 'test_*.py'
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BRIDGE = Path(__file__).with_name("gm_bridge.py")

try:
    import graphify  # noqa: F401

    HAVE_GRAPHIFY = True
except Exception:
    HAVE_GRAPHIFY = False


def run(*args: str) -> tuple[int, dict]:
    proc = subprocess.run([sys.executable, str(BRIDGE), *args], capture_output=True, text=True, timeout=120)
    return proc.returncode, json.loads(proc.stdout.strip().splitlines()[-1])


def node(nid: str, label: str, **attrs) -> dict:
    return {
        "id": nid, "label": label, "file_type": "concept", "source_file": "corpus/a.md",
        "source_location": "#0–#7", "rationale": attrs.get("description"), "attributes": attrs, "_origin": "semantic",
    }


def edge(src: str, tgt: str, relation: str) -> dict:
    return {
        "source": src, "target": tgt, "relation": relation, "confidence": "EXTRACTED", "confidence_score": 1,
        "weight": 1, "source_file": "corpus/a.md", "source_location": "#0–#7",
        "relations": [{"relation": relation, "detail": "", "at": "#0–#7"}], "_origin": "semantic",
    }


class BridgeTests(unittest.TestCase):
    def test_usage_error(self):
        code, out = run("nonsense")
        self.assertEqual(code, 1)
        self.assertFalse(out["ok"])

    @unittest.skipUnless(HAVE_GRAPHIFY, "graphify is not installed for this Python")
    def test_probe(self):
        code, out = run("probe")
        self.assertEqual(code, 0)
        self.assertTrue(out["ok"])
        self.assertTrue(out["graphifyVersion"])

    @unittest.skipUnless(HAVE_GRAPHIFY, "graphify is not installed for this Python")
    def test_build_and_clear(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            extraction = {
                "nodes": [
                    node("seraphina", "Seraphina", kind="character", description="Guardian"),
                    node("kai", "Kai", kind="person"),
                    node("amulet", "Amulet", kind="item"),
                ],
                "edges": [edge("seraphina", "kai", "healed"), edge("kai", "seraphina", "thanked"), edge("kai", "amulet", "owns")],
                "hyperedges": [],
            }
            (root / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
            code, out = run("build", tmp)
            self.assertEqual(code, 0, out)
            self.assertEqual((out["nodes"], out["edges"]), (3, 3))
            graph = json.loads((root / "graphify-out" / "graph.json").read_text(encoding="utf-8"))
            by_id = {n["id"]: n for n in graph["nodes"]}
            self.assertEqual(by_id["seraphina"]["attributes"]["description"], "Guardian")
            self.assertIn("community_name", by_id["kai"])
            pairs = {(link["source"], link["target"]) for link in graph["links"]}
            self.assertEqual(pairs, {("seraphina", "kai"), ("kai", "seraphina"), ("kai", "amulet")})
            self.assertTrue((root / "graphify-out" / "graph.html").exists())
            self.assertEqual([p.name for p in (root / "graphify-out").iterdir() if p.name.startswith(".graph-")], [])

            (root / "extraction.json").write_text('{"nodes": [], "edges": []}', encoding="utf-8")
            code, out = run("build", tmp)
            self.assertEqual((code, out["nodes"]), (0, 0))
            self.assertFalse((root / "graphify-out" / "graph.json").exists())

    @unittest.skipUnless(HAVE_GRAPHIFY, "graphify is not installed for this Python")
    def test_build_reports_bad_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "extraction.json").write_text("not json", encoding="utf-8")
            code, out = run("build", tmp)
            self.assertEqual(code, 1)
            self.assertIn("JSONDecodeError", out["error"])


if __name__ == "__main__":
    unittest.main()
