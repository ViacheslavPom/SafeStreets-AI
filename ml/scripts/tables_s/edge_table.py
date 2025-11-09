import os
import numpy as np
import pandas as pd
import geopandas as gpd
from shapely import wkt
from shapely.geometry import LineString
import lightgbm as lgb


# ----------------------------
# Config / file paths
# ----------------------------
EDGES_CSV   = "../../data/data_processed/edges.csv"   # columns: coordinates (WKT MULTILINESTRING or LINESTRING), rw_type (optional)
OUT_DIR     = "../../data/data_backend"
OUT_PARQUET = os.path.join(OUT_DIR, "edges_table.parquet")


# CRS
CRS_GEO = "EPSG:4326"   # lon/lat
CRS_M   = "EPSG:32618"  # UTM Zone 18N (meters, good for NYC region)

# H3 resolution (match your main pipeline)
H3_RES = 9

# ----------------------------
# Helpers
# ----------------------------
def parse_multilinestring_to_linestring(wkt_str: str) -> LineString:
    geom = wkt.loads(wkt_str)
    if geom.geom_type == "MultiLineString":
        if len(geom.geoms) == 1:
            return LineString(list(geom.geoms[0].coords))
        coords = []
        for ls in geom.geoms:
            coords.extend(list(ls.coords))
        return LineString(coords)
    elif geom.geom_type == "LineString":
        return geom
    raise ValueError(f"Unexpected geometry type: {geom.geom_type}")

def h3_index(lat: float, lon: float, res: int) -> str:
    import h3
    if hasattr(h3, "geo_to_h3"):        # v3
        return h3.geo_to_h3(lat, lon, res)
    if hasattr(h3, "latlng_to_cell"):   # v4
        return h3.latlng_to_cell(lat, lon, res)
    raise RuntimeError("Unsupported h3 API")

# ----------------------------
# Load edges
# ----------------------------
edges = pd.read_csv(EDGES_CSV)
edges["geometry"] = edges["coordinates"].apply(parse_multilinestring_to_linestring)

# GeoDataFrames
g_edges_ll = gpd.GeoDataFrame(edges.drop(columns=["coordinates"]),
                              geometry="geometry", crs=CRS_GEO)
g_edges_m  = g_edges_ll.to_crs(CRS_M).copy()

# Edge ids
g_edges_m["edge_id"] = np.arange(len(g_edges_m))

# Start / end / midpoint (in meters CRS), then convert to lon/lat
starts_m = g_edges_m.geometry.interpolate(0.0, normalized=True)
ends_m   = g_edges_m.geometry.interpolate(1.0, normalized=True)
mids_m   = g_edges_m.geometry.interpolate(0.5, normalized=True)

starts_ll = gpd.GeoSeries(starts_m, crs=CRS_M).to_crs(CRS_GEO)
ends_ll   = gpd.GeoSeries(ends_m,   crs=CRS_M).to_crs(CRS_GEO)
mids_ll   = gpd.GeoSeries(mids_m,   crs=CRS_M).to_crs(CRS_GEO)

# Length in meters
length_m = g_edges_m.geometry.length

# Cluster (H3) from midpoint lon/lat
mid_lon = mids_ll.x.values
mid_lat = mids_ll.y.values
cluster_ids = [h3_index(lat, lon, H3_RES) for lat, lon in zip(mid_lat, mid_lon)]

# Assemble output
out = pd.DataFrame({
    "edge_id":   g_edges_m["edge_id"].astype(int),
    "start_lon": starts_ll.x.values,
    "start_lat": starts_ll.y.values,
    "end_lon":   ends_ll.x.values,
    "end_lat":   ends_ll.y.values,
    "mid_lon":   mid_lon,
    "mid_lat":   mid_lat,
    "length_m":  length_m.values,
    "cluster_id": cluster_ids,
})

cluster_df = pd.read_parquet("../../data/data_backend/cluster_table.parquet")
cluster_cols = [
    'lat_sin', 'lat_cos', 'lon_sin', 'lon_cos',
    'temperature', 'precipitation', 'rain', 'cloudcover', 'windspeed', 'time'
]
cluster_df = cluster_df[['cluster_id'] + cluster_cols]

# --- Join cluster features onto edges by cluster_id ---
out = out.merge(cluster_df, on='cluster_id', how='left')


EDGES_PROCESSED_CSV = "../../data/data_processed/edges.csv"  # columns: coordinates, rw_type
SPEEDLIMIT_CSV      = "../../data/data_processed/speedlimit.csv"       # columns: coordinates, speedlimit

def linestring_key(ls: LineString, decimals: int = 6) -> str:
    """
    Build a stable key from a LineString by rounding coordinates.
    This makes sure equal geometries (from different files) match exactly.
    """
    pts = [f"{x:.{decimals}f},{y:.{decimals}f}" for x, y in ls.coords]
    return ";".join(pts)

edges_key_map = pd.DataFrame({
    "edge_id": g_edges_m["edge_id"].astype(int).values,
    "geom_key": g_edges_ll.geometry.apply(linestring_key).values
})

ep = pd.read_csv(EDGES_PROCESSED_CSV, usecols=["coordinates", "rw_type"])
ep["geometry"] = ep["coordinates"].apply(parse_multilinestring_to_linestring)
ep["geom_key"] = ep["geometry"].apply(linestring_key)
ep = ep.drop(columns=["coordinates", "geometry"]).drop_duplicates(subset=["geom_key"])

sl = pd.read_csv(SPEEDLIMIT_CSV, usecols=["coordinates", "speedlimit"])
sl["geometry"] = sl["coordinates"].apply(parse_multilinestring_to_linestring)
sl["geom_key"] = sl["geometry"].apply(linestring_key)
sl = sl.drop(columns=["coordinates", "geometry"]).drop_duplicates(subset=["geom_key"])

attr = edges_key_map.merge(ep[["geom_key", "rw_type"]], on="geom_key", how="left") \
                    .merge(sl[["geom_key", "speedlimit"]], on="geom_key", how="left") \
                    .drop(columns=["geom_key"])

out = out.merge(attr, on="edge_id", how="left")

mask = out["speedlimit"].isna()
n_missing = mask.sum()

if n_missing > 0:
    np.random.seed(42)  # optional for reproducibility
    out.loc[mask, "speedlimit"] = np.random.randint(15, 31, size=n_missing)

rw = out["rw_type"].astype(float)
rw_weight = np.select(
    [rw == 1, rw == 2, rw == 3, rw == 4],
    [1.0,     0.8,     0.6,     0.4],
    default=0.2
)

out["traffic_volume"] = (
    0.45 * rw_weight
    + 0.35 * out["time"].astype(float)
    + 0.15 * out["speedlimit"].astype(float)
)

FEATURES = [
    "lat_sin", "lat_cos", "lon_sin", "lon_cos",
    "temperature", "precipitation", "rain", "cloudcover", "windspeed",
    "traffic_volume"
]

def load_model(path: str) -> lgb.Booster:
    booster = lgb.Booster(model_file=path)
    # sanity: ensure feature order compatibility
    trained_feats = list(booster.feature_name())
    if trained_feats and trained_feats != FEATURES:
        raise ValueError(f"Feature mismatch:\ntrained={trained_feats}\ncode   ={FEATURES}")
    return booster

def predict_batch(booster: lgb.Booster, df: pd.DataFrame) -> np.ndarray:
    X = df[FEATURES].astype(np.float32).replace([np.inf, -np.inf], np.nan)
    return booster.predict(X, num_iteration=booster.best_iteration)

booster = load_model("../../model/main_model.lgb")
out["risk_score"] = predict_batch(booster, out)
max_r = out["risk_score"].max()
min_r = out["risk_score"].min()
out["risk_score"] = (out["risk_score"] - min_r) / (max_r - min_r)

os.makedirs(OUT_DIR, exist_ok=True)
out.to_parquet(OUT_PARQUET, index=False)
print(f"Saved: {OUT_PARQUET} with {len(out)} rows and columns: {list(out.columns)}")