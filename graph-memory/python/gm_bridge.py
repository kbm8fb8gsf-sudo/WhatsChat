"""Graph Memory <-> graphify bridge.

Run by the Graph Memory server plugin with the Python interpreter that has
graphify installed. It never talks to an LLM: the server has already merged the
extracted story facts into graphify's extraction format, and this script only
hands them to graphify to build, cluster and export the graph.

Commands (each prints one JSON object on stdout):

    probe                 report graphify's version and whether its MCP server can run
    build <scope_dir>     <scope_dir>/extraction.json -> <scope_dir>/graphify-out/graph.json + graph.html

Exit status is 0 on success and 1 on failure; on failure the JSON has "error".
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def _emit(obj: dict, code: int = 0) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    raise SystemExit(code)


def _graphify_version() -> str:
    try:
        from importlib.metadata import version

        return version("graphifyy")
    except Exception:  # pragma: no cover - depends on how graphify was installed
        import graphify

        return str(getattr(graphify, "__version__", "unknown"))


def probe() -> None:
    try:
        import graphify  # noqa: F401
    except Exception as exc:  # pragma: no cover - exercised by the server tests via a fake python
        _emit({"ok": False, "error": f"graphify is not installed for {sys.executable}: {exc}"}, 1)
    try:
        import mcp  # noqa: F401

        has_mcp = True
    except Exception:
        has_mcp = False
    _emit({
        "ok": True,
        "python": sys.executable,
        "pythonVersion": ".".join(str(p) for p in sys.version_info[:3]),
        "graphifyVersion": _graphify_version(),
        "mcp": has_mcp,
    })


def _community_labels(G, communities: dict[int, list[str]]) -> dict[int, str]:
    """Name each community after its two best-connected members, e.g. "Seraphina & Kai"."""
    labels: dict[int, str] = {}
    for cid, members in communities.items():
        ranked = sorted(members, key=lambda n: (-G.degree(n), str(G.nodes[n].get("label", n))))
        names = [str(G.nodes[n].get("label", n)) for n in ranked[:2]]
        labels[cid] = " & ".join(names) if names else f"Group {cid}"
    return labels


def _atomic_replace(tmp_path: Path, final_path: Path) -> None:
    os.replace(tmp_path, final_path)


def build(scope_dir: str) -> None:
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json

    try:
        from graphify.exporters.html import to_html
    except Exception:  # pragma: no cover - older graphify layout
        from graphify.export import to_html  # type: ignore[no-redef]

    root = Path(scope_dir).resolve()
    extraction_path = root / "extraction.json"
    out_dir = root / "graphify-out"
    out_dir.mkdir(parents=True, exist_ok=True)
    graph_path = out_dir / "graph.json"
    html_path = out_dir / "graph.html"

    extraction = json.loads(extraction_path.read_text(encoding="utf-8"))
    if not extraction.get("nodes"):
        # Nothing remembered (e.g. after "forget"): remove the old graph so queries come back empty.
        for p in (graph_path, html_path):
            p.unlink(missing_ok=True)
        _emit({"ok": True, "nodes": 0, "edges": 0, "communities": 0, "html": False})

    # directed=True keeps "A -> B" and "B -> A" as separate relationships.
    # dedup=False: entity ids are already canonical (the server merged them by name).
    G = build_from_json(extraction, root=str(root), directed=True, dedup=False)
    communities = cluster(G) if G.number_of_nodes() > 1 else {0: list(G.nodes)}
    labels = _community_labels(G, communities)

    # Write to temp files and rename into place, so graphify's MCP server (which
    # hot-reloads graph.json when its mtime changes) never reads a half-written file.
    fd, tmp_json = tempfile.mkstemp(prefix=".graph-", suffix=".json", dir=out_dir)
    os.close(fd)
    try:
        wrote = to_json(G, communities, tmp_json, force=True, community_labels=labels)
        if wrote is False:
            raise RuntimeError("graphify refused to write graph.json")
        _atomic_replace(Path(tmp_json), graph_path)
    finally:
        Path(tmp_json).unlink(missing_ok=True)

    html_ok = False
    html_error = None
    fd, tmp_html = tempfile.mkstemp(prefix=".graph-", suffix=".html", dir=out_dir)
    os.close(fd)
    try:
        html_ok = bool(to_html(G, communities, tmp_html, community_labels=labels))
        if html_ok:
            _atomic_replace(Path(tmp_html), html_path)
    except Exception as exc:  # the picture is optional; memory still works without it
        html_error = str(exc)
    finally:
        Path(tmp_html).unlink(missing_ok=True)

    result = {
        "ok": True,
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": len(communities),
        "html": html_ok,
    }
    if html_error:
        result["htmlError"] = html_error
    _emit(result)


def main(argv: list[str]) -> None:
    if not argv:
        _emit({"ok": False, "error": "usage: gm_bridge.py probe | build <scope_dir>"}, 1)
    cmd = argv[0]
    try:
        if cmd == "probe":
            probe()
        elif cmd == "build" and len(argv) == 2:
            build(argv[1])
        else:
            _emit({"ok": False, "error": f"unknown command: {' '.join(argv)}"}, 1)
    except SystemExit:
        raise
    except Exception as exc:
        _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 1)


if __name__ == "__main__":
    main(sys.argv[1:])
