from __future__ import annotations

import numpy as np
import pandas as pd
import geopandas as gpd
from typing import Iterable, List, Tuple, Dict, Set
from shapely.geometry import Point, LineString
from shapely.strtree import STRtree


# ---------------------------
# Utilities
# ---------------------------

def _extract_points(geom):
    """Return a list of Point objects from any geometry (incl. collections/overlaps)."""
    if geom.is_empty:
        return []
    gt = geom.geom_type
    if gt == "Point":
        return [geom]
    if gt == "MultiPoint":
        return list(geom.geoms)
    if gt in ("LineString", "LinearRing"):
        coords = list(geom.coords)
        if not coords:
            return []
        if coords[0] == coords[-1]:
            return [Point(coords[0])]
        return [Point(coords[0]), Point(coords[-1])]
    if gt == "MultiLineString":
        pts = []
        for ls in geom.geoms:
            pts.extend(_extract_points(ls))
        return pts
    if gt == "GeometryCollection":
        pts = []
        for g in geom.geoms:
            pts.extend(_extract_points(g))
        return pts
    return []


def _make_tree_and_index(geoms: Iterable):
    """
    Build an STRtree in a way that works with both Shapely 1.x and 2.x.
    Returns:
      tree: STRtree
      geoms_list: list of geometries (same order as in the tree)
      geom_to_idx: dict mapping id(geom) -> index (needed for Shapely 1.x)
    """
    geoms_list = list(geoms)
    # Ensure object dtype for some builds
    tree = STRtree(np.asarray(geoms_list, dtype=object))
    geom_to_idx = {id(g): i for i, g in enumerate(geoms_list)}
    return tree, geoms_list, geom_to_idx


def _query_indices(tree: STRtree, geom_to_idx: Dict[int, int], gi):
    """
    Version-robust query:
      - In Shapely 2.x, tree.query(gi) returns integer indices (ndarray).
      - In Shapely 1.x, tree.query(gi) returns geometries; map them back to indices.
    """
    try:
        cand = tree.query(gi)  # prefer bbox filtering; exact test happens later
        # If cand are geometries (Shapely 1.x), convert to indices via id()
        arr = np.asarray(cand)
        if arr.size > 0 and not np.issubdtype(arr.dtype, np.integer):
            return [geom_to_idx[id(g)] for g in cand]
        return list(map(int, cand))
    except TypeError:
        # Defensive: some older mixes raise TypeError but still return geometries
        cand_geoms = tree.query(gi)
        return [geom_to_idx[id(g)] for g in cand_geoms]


# ---------------------------
# Core builder
# ---------------------------

def build_nodes_intersections(
    edges: gpd.GeoDataFrame,
    edge_id_col: str = "edge_id",
    tol_m: float = 5.0,
    ignore_grade_cols: Tuple[str, ...] = ("bridge", "tunnel", "layer"),
    include_geometry: bool = False,
) -> pd.DataFrame | gpd.GeoDataFrame:
    """
    Compute intersection nodes (including endpoints and interior intersections) from a GeoDataFrame of edges.

    Parameters
    ----------
    edges : GeoDataFrame
        Must have a valid CRS. If geographic (lat/lon), will be reprojected to EPSG:3857 internally.
    edge_id_col : str
        Name of the column with unique edge IDs.
    tol_m : float
        Snap/merge tolerance in meters via grid quantization.
    ignore_grade_cols : tuple[str, ...]
        Column names used to avoid creating nodes at over/underpasses when they differ (grade-separated).
    include_geometry : bool
        If True, returns a GeoDataFrame with point geometry; else a plain DataFrame.

    Returns
    -------
    DataFrame or GeoDataFrame with columns:
        node_id (int), x (float), y (float), edges (List[edge_id]), [geometry (Point) if include_geometry]
    """
    assert edges.crs is not None, "Set a CRS on `edges` (e.g., 'EPSG:4326')."

    # Project to a metric CRS for proper tolerance/length handling
    metric_edges = edges if not edges.crs.is_geographic else edges.to_crs(3857)

    # Arrays
    geoms_col = metric_edges.geometry
    if geoms_col is None:
        raise ValueError("`edges` must have a geometry column.")
    eids = metric_edges[edge_id_col].to_numpy()

    # Grade-separation key: different keys => skip intersections (likely over/underpasses)
    def grade_key(row):
        return "|".join(str(row.get(c, "")) for c in ignore_grade_cols)
    grade = metric_edges.apply(grade_key, axis=1).to_numpy()

    # STRtree + index mapping
    tree, geoms_list, geom_to_idx = _make_tree_and_index(geoms_col)

    raw_points: List[Point] = []
    raw_incident: List[Set] = []

    # 1) Collect endpoints (keeps dead-ends)
    for eid, g in zip(eids, geoms_list):
        if g.is_empty:
            continue
        if g.geom_type == "LineString":
            coords = list(g.coords)
            if not coords:
                continue
            endpoints = [Point(coords[0]), Point(coords[-1])]
        elif g.geom_type == "MultiLineString":
            # Use first/last of outer parts for endpoints
            first = list(g.geoms[0].coords)[0]
            last = list(g.geoms[-1].coords)[-1]
            endpoints = [Point(first), Point(last)]
        else:
            continue
        for p in endpoints:
            raw_points.append(p)
            raw_incident.append({eid})

    # 2) Interior intersections (pairwise)
    n = len(geoms_list)
    for i in range(n):
        gi = geoms_list[i]
        if gi.is_empty:
            continue

        cand_idx = _query_indices(tree, geom_to_idx, gi)
        for j in cand_idx:
            if j <= i:
                continue
            gj = geoms_list[j]

            # Skip likely grade-separated crossings
            if grade[i] != grade[j]:
                continue

            # Exact test (avoid bbox-only matches)
            if not gi.intersects(gj):
                continue

            inter = gi.intersection(gj)
            if inter.is_empty:
                continue

            pts = _extract_points(inter)
            if not pts:
                continue

            ei, ej = eids[i], eids[j]
            for p in pts:
                raw_points.append(p)
                raw_incident.append({ei, ej})

    # 3) Snap/cluster points to tol_m via grid quantization
    if len(raw_points) == 0:
        # No intersections; return empty structure
        cols = ["node_id", "x", "y", "edges"]
        return gpd.GeoDataFrame(columns=(cols + ["geometry"]), crs=metric_edges.crs) if include_geometry else pd.DataFrame(columns=cols)

    gsize = float(tol_m)
    xs = np.fromiter((p.x for p in raw_points), dtype=float)
    ys = np.fromiter((p.y for p in raw_points), dtype=float)
    qx = np.round(xs / gsize).astype(np.int64)
    qy = np.round(ys / gsize).astype(np.int64)

    bins: Dict[Tuple[int, int], Dict[str, list | set]] = {}
    for ix, iy, x, y, inc in zip(qx, qy, xs, ys, raw_incident):
        key = (ix, iy)
        if key not in bins:
            bins[key] = {"xs": [x], "ys": [y], "edges": set(inc)}
        else:
            bins[key]["xs"].append(x)
            bins[key]["ys"].append(y)
            bins[key]["edges"].update(inc)

    node_records = []
    for payload in bins.values():
        xs_bin, ys_bin, inc = payload["xs"], payload["ys"], payload["edges"]
        cx, cy = float(np.mean(xs_bin)), float(np.mean(ys_bin))
        node_records.append({"geometry": Point(cx, cy), "edges": sorted(inc)})

    nodes_gdf = gpd.GeoDataFrame(node_records, crs=metric_edges.crs)
    nodes_gdf.insert(0, "node_id", np.arange(1, len(nodes_gdf) + 1, dtype=np.int64))
    nodes_gdf["x"] = nodes_gdf.geometry.x
    nodes_gdf["y"] = nodes_gdf.geometry.y

    # Return in the original CRS coordinates
    if edges.crs.is_geographic:
        nodes_ll = nodes_gdf.to_crs(edges.crs)
        nodes_ll["x"] = nodes_ll.geometry.x
        nodes_ll["y"] = nodes_ll.geometry.y
        out = nodes_ll
    else:
        out = nodes_gdf

    cols = ["node_id", "x", "y", "edges"]
    if include_geometry:
        return out[cols + ["geometry"]]
    return pd.DataFrame(out[cols])


# ---------------------------
# DataFrame wrapper
# ---------------------------

def build_nodes_intersections_from_df(
    edges_df: pd.DataFrame,
    edge_id_col: str = "edge_id",
    start_lon_col: str = "start_lon",
    start_lat_col: str = "start_lat",
    end_lon_col: str = "end_lon",
    end_lat_col: str = "end_lat",
    tol_m: float = 5.0,
    ignore_grade_cols: Tuple[str, ...] = ("bridge", "tunnel", "layer"),
    include_geometry: bool = False,
) -> pd.DataFrame | gpd.GeoDataFrame:
    """
    Accepts a plain pandas DataFrame with columns:
      edge_id, start_lon, start_lat, end_lon, end_lat, (others optional)
    Builds a GeoDataFrame of LineStrings in EPSG:4326, computes intersections,
    and returns the nodes table.
    """
    # Construct LineStrings from endpoints
    lines = [
        LineString([(float(sl), float(sa)), (float(el), float(ea))])
        for sl, sa, el, ea in zip(
            edges_df[start_lon_col].to_numpy(),
            edges_df[start_lat_col].to_numpy(),
            edges_df[end_lon_col].to_numpy(),
            edges_df[end_lat_col].to_numpy(),
        )
    ]

    gdf = gpd.GeoDataFrame(edges_df.copy(), geometry=lines, crs="EPSG:4326")

    return build_nodes_intersections(
        gdf,
        edge_id_col=edge_id_col,
        tol_m=tol_m,
        ignore_grade_cols=ignore_grade_cols,
        include_geometry=include_geometry,
    )


# ---------------------------
# Example CLI usage
# ---------------------------

if __name__ == "__main__":
    edges_df = pd.read_parquet("../../data/data_backend/edges_table.parquet")

    nodes = build_nodes_intersections_from_df(
        edges_df,
        edge_id_col="edge_id",
        start_lon_col="start_lon",
        start_lat_col="start_lat",
        end_lon_col="end_lon",
        end_lat_col="end_lat",
        tol_m=5.0,
        include_geometry=False,
    )

    # Save
    out_path = "../../data/data_backend/nodes_table.parquet"

    if isinstance(nodes, gpd.GeoDataFrame):
        nodes.to_parquet(out_path, index=False)
    else:
        pd.DataFrame(nodes).to_parquet(out_path, index=False)

    print(f"Saved {len(nodes)} nodes to {out_path}")