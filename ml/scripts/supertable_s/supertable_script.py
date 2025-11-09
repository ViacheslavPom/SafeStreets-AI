import os
import numpy as np
import pandas as pd
import geopandas as gpd
from shapely import wkt
from shapely.geometry import LineString, Point
from tqdm import tqdm

tqdm.pandas()

def h3_index(lat: float, lon: float, res: int) -> str:
    import h3
    if hasattr(h3, "geo_to_h3"):          # v3
        return h3.geo_to_h3(lat, lon, res)
    if hasattr(h3, "latlng_to_cell"):     # v4
        return h3.latlng_to_cell(lat, lon, res)
    raise RuntimeError("Unsupported h3 API")

def h3_center(cell: str):
    import h3
    if hasattr(h3, "h3_to_geo"):          # v3
        lat, lon = h3.h3_to_geo(cell)
        return lat, lon
    if hasattr(h3, "cell_to_latlng"):     # v4
        lat, lon = h3.cell_to_latlng(cell)
        return lat, lon
    raise RuntimeError("Unsupported h3 API")

# ----------------------------
# Config / file paths
# ----------------------------
EDGES_CSV        = "../data_processed/edges.csv"         # columns: coordinates (WKT MULTILINESTRING), rw_type (1..5)
SPEEDLIMIT_CSV   = "../data_processed/speedlimit.csv"    # columns: coordinates (WKT MULTILINESTRING), speedlimit (int)
CRASHES_CSV      = "../data_processed/crashes.csv"       # columns as specified; time "YYYY/MM/DD HH"
WEATHER_CSV      = "../data_processed/weather.csv"       # columns as specified; time "YYYY/MM/DD HH"
OUT_DIR          = "../../data/data_final"
OUT_PARQUET      = os.path.join(OUT_DIR, "supertable.parquet")

# CRS
CRS_GEO = "EPSG:4326"      # lon/lat
CRS_M  = "EPSG:32618"      # NY feet
FT_TO_M = 0.3048
BUFFER_M = 200.0           # (retained if you later want to use it)

# Dist threshold for nearest matching (60 m in feet)
DIST_THRESH_M = 60.0 / FT_TO_M  # ≈ 196.85 ft

# H3 resolution
H3_RES = 9

# ----------------------------
# Helpers
# ----------------------------
def parse_multilinestring_to_linestring(wkt_str: str) -> LineString:
    geom = wkt.loads(wkt_str)
    if geom.geom_type == "MultiLineString":
        if len(geom.geoms) == 1:
            return LineString(list(geom.geoms[0].coords))
        # merge by chaining coords
        coords = []
        for ls in geom.geoms:
            coords.extend(list(ls.coords))
        return LineString(coords)
    elif geom.geom_type == "LineString":
        return geom
    raise ValueError(f"Unexpected geometry type: {geom.geom_type}")

def time_score(ts: pd.Timestamp) -> float:
    """
    Spec-driven scoring (0..1).

    Weekdays (Mon–Fri):
      Rush 06–10, 16–20 => 1.00
      Midday 10–16      => 0.65
      Eve 20–23         => 0.45
      Night 23–06       => 0.20

    Weekends (Sat–Sun):
      Rush 10–16        => 1.00
      Other daytime 07–10, 16–20 => 0.55
      Night 20–07       => 0.20
    """
    h = ts.hour
    wd = ts.weekday()  # 0=Mon,...,6=Sun
    is_weekend = wd >= 5

    if not is_weekend:
        if (6 <= h < 10) or (16 <= h < 20):
            return 1.0
        if 10 <= h < 16:
            return 0.65
        if 20 <= h < 23:
            return 0.45
        return 0.20  # 23–06
    else:
        if 10 <= h < 16:
            return 1.0
        if (7 <= h < 10) or (16 <= h < 20):
            return 0.55
        return 0.20  # 20–07

def normalize_series_01(s: pd.Series) -> pd.Series:
    vmin, vmax = s.min(), s.max()
    if pd.isna(vmin) or pd.isna(vmax) or vmax == vmin:
        return pd.Series(np.zeros(len(s), dtype=float), index=s.index)
    return (s - vmin) / (vmax - vmin)

# ----------------------------
# Load edges & speed limits
# ----------------------------
edges = pd.read_csv(EDGES_CSV)
edges["geometry"] = edges["coordinates"].apply(parse_multilinestring_to_linestring)
g_edges = gpd.GeoDataFrame(edges.drop(columns=["coordinates"]),
                           geometry="geometry", crs=CRS_GEO).to_crs(CRS_M)
g_edges["edge_id"] = np.arange(len(g_edges))

g_edges["rw_type"] = pd.to_numeric(g_edges["rw_type"], errors="coerce")
g_edges.loc[~g_edges["rw_type"].isin([1,2,3,4,5]), "rw_type"] = np.nan
rw_map = {1:1.0, 2:0.8, 3:0.6, 4:0.4, 5:0.2}
g_edges["rw_score"] = g_edges["rw_type"].map(rw_map)

# If any rw_score is still NaN (missing rw_type), use a neutral default (type=3 -> 0.6)
g_edges["rw_score"] = g_edges["rw_score"].fillna(0.6)

# Speed limits
sl = pd.read_csv(SPEEDLIMIT_CSV)
sl["geometry"] = sl["coordinates"].apply(parse_multilinestring_to_linestring)
g_sl = gpd.GeoDataFrame(sl.drop(columns=["coordinates"]), geometry="geometry", crs=CRS_GEO).to_crs(CRS_M)

# --------------------------------------------

# Attach speedlimit to edges by nearest line (centroid along line)
centroids = g_edges.geometry.interpolate(0.5, normalized=True)
pts = gpd.GeoDataFrame({"edge_idx": g_edges.index}, geometry=centroids, crs=g_edges.crs)

g_edges["speedlimit"] = np.nan
g_edges["sl_dist_ft"] = np.nan

try:
    joined = gpd.sjoin_nearest(
        pts,
        g_sl[["speedlimit", "geometry"]],
        how="left",
        distance_col="sl_dist_ft"
    )
    joined.loc[joined["sl_dist_ft"] > DIST_THRESH_M, "speedlimit"] = np.nan
    g_edges.loc[joined["edge_idx"], "speedlimit"] = joined["speedlimit"].to_numpy()
    g_edges.loc[joined["edge_idx"], "sl_dist_ft"] = joined["sl_dist_ft"].to_numpy()
except Exception:
    # Fallback: manual spatial index nearest
    sidx = g_sl.sindex
    spd = np.full(len(g_edges), np.nan, dtype=float)
    dist = np.full(len(g_edges), np.nan, dtype=float)
    for i, c in tqdm(enumerate(pts.geometry.values), total=len(pts), desc="Finding nearest speed limits"):
        try:
            cand_idx = next(iter(sidx.nearest(c.bounds, num_results=1)))
        except Exception:
            cand_list = list(sidx.intersection(c.bounds))
            if not cand_list:
                continue
            dists = g_sl.geometry.iloc[cand_list].distance(c).to_numpy()
            cand_idx = cand_list[int(np.nanargmin(dists))]
        line = g_sl.geometry.iloc[cand_idx]
        d = c.distance(line)  # feet
        if d <= DIST_THRESH_M:
            spd[i] = float(g_sl["speedlimit"].iloc[cand_idx])
            dist[i] = d
    g_edges["speedlimit"] = spd
    g_edges["sl_dist_ft"] = dist

# --- Normalize speedlimit globally to [0,1] ---
sl_min, sl_max = g_edges["speedlimit"].min(), g_edges["speedlimit"].max()
if pd.isna(sl_min) or pd.isna(sl_max) or sl_max == sl_min:
    g_edges["speed_score"] = 0.5
else:
    g_edges["speed_score"] = (g_edges["speedlimit"] - sl_min) / (sl_max - sl_min)

# ----------------------------
# H3 clusters (canonical)
# ----------------------------
# Interpolate midpoints in projected CRS (meters)
midpoints_m = g_edges.geometry.interpolate(0.5, normalized=True)

# Convert those points to lat/lon for H3
midpoints_ll = gpd.GeoSeries(midpoints_m, crs=CRS_M).to_crs(CRS_GEO)

# h3 expects (lat, lon)
g_edges["cluster_id"] = [
    h3_index(pt.y, pt.x, H3_RES) for pt in midpoints_ll
]

# Cluster aggregates (avg over member edges)
cluster_stats = g_edges.groupby("cluster_id").agg(
    n_edges=("edge_id", "count"),
    avg_rw=("rw_score", "mean"),
    avg_speed=("speed_score", "mean")
).reset_index()

cluster_centers = cluster_stats[["cluster_id"]].copy()
cluster_centers["lat"], cluster_centers["lon"] = zip(
    *cluster_centers["cluster_id"].map(h3_center)
)

# Convert to radians first
lat_rad = np.radians(cluster_centers["lat"])
lon_rad = np.radians(cluster_centers["lon"])

# Compute sine and cosine for each
cluster_centers["lat_sin"] = np.sin(lat_rad)
cluster_centers["lat_cos"] = np.cos(lat_rad)
cluster_centers["lon_sin"] = np.sin(lon_rad)
cluster_centers["lon_cos"] = np.cos(lon_rad)

# Drop raw coordinates if you no longer need them
cluster_centers.drop(columns=["lat", "lon"], inplace=True)

global_speed_mean = g_edges["speed_score"].mean()
cluster_stats["avg_speed"] = cluster_stats["avg_speed"].fillna(global_speed_mean if not np.isnan(global_speed_mean) else 0.5)
cluster_stats["avg_rw"]    = cluster_stats["avg_rw"].fillna(0.6)  # neutral default

# ----------------------------
# Time grid (4-hour bins) & time scores
# ----------------------------
t_start = pd.Timestamp("2016-01-04 00:00:00")
t_end   = pd.Timestamp("2022-10-19 23:59:59")
time_index_4h = pd.date_range(t_start, t_end, freq="4h")

time_scores = pd.Series([time_score(ts) for ts in time_index_4h],
                        index=time_index_4h, name="time_score")

# ----------------------------
# Weather: resample to 4-hour & normalize per-column (0..1)
# ----------------------------
weather = pd.read_csv(WEATHER_CSV)
weather["time"] = pd.to_datetime(weather["time"], format="%Y/%m/%d %H", errors="coerce")
weather = weather.dropna(subset=["time"]).set_index("time").sort_index()

num_cols = ["temperature", "precipitation", "rain", "cloudcover", "windspeed"]
for c in num_cols:
    weather[c] = pd.to_numeric(weather[c], errors="coerce")

weather_4h = weather[num_cols].resample("4h", label="left", closed="left").mean()
weather_4h = weather_4h.reindex(time_index_4h)

for col in num_cols:
    x = weather_4h[col]
    vmin, vmax = x.min(), x.max()
    if pd.isna(vmin) or pd.isna(vmax) or vmax == vmin:
        weather_4h[col] = 0.0
    else:
        weather_4h[col] = (x - vmin) / (vmax - vmin)

# ----------------------------
# Crashes: snap to nearest edge (≤60 m), aggregate per 4h & cluster
# ----------------------------
crashes = pd.read_csv(CRASHES_CSV)

g_cr = gpd.GeoDataFrame(
    crashes,
    geometry=gpd.points_from_xy(crashes["LONGITUDE"], crashes["LATITUDE"]),
    crs=CRS_GEO
).to_crs(CRS_M)

edges_for_join = g_edges[["edge_id", "cluster_id", "geometry"]].copy()

try:
    snapped = gpd.sjoin_nearest(
        g_cr,
        edges_for_join,
        how="left",
        distance_col="cr_dist_ft"
    )
    snapped = snapped[snapped["cr_dist_ft"] <= DIST_THRESH_M].copy()
except Exception:
    sidx = edges_for_join.sindex
    edge_id_arr = np.full(len(g_cr), np.nan)
    cluster_id_arr = np.full(len(g_cr), np.nan)
    dist_arr = np.full(len(g_cr), np.nan)
    for i, p in tqdm(enumerate(g_cr.geometry.values), total=len(g_cr), desc="Snapping crashes to nearest edges"):
        try:
            cand_idx = next(iter(sidx.nearest(p.bounds, num_results=1)))
        except Exception:
            cand_list = list(sidx.intersection(p.bounds))
            if not cand_list:
                continue
            dists = edges_for_join.geometry.iloc[cand_list].distance(p).to_numpy()
            cand_idx = cand_list[int(np.nanargmin(dists))]
        line = edges_for_join.geometry.iloc[cand_idx]
        d = p.distance(line)  # feet
        if d <= DIST_THRESH_M:
            edge_id_arr[i] = edges_for_join["edge_id"].iloc[cand_idx]
            cluster_id_arr[i] = edges_for_join["cluster_id"].iloc[cand_idx]
            dist_arr[i] = d
    snapped = g_cr.copy()
    snapped["edge_id"] = edge_id_arr
    snapped["cluster_id"] = cluster_id_arr
    snapped["cr_dist_ft"] = dist_arr
    snapped = snapped.dropna(subset=["cluster_id"])

# 4-hour bin from crash time
snapped["t4h"] = pd.to_datetime(snapped["time"], format="%Y/%m/%d %H", errors="coerce").dt.floor("4h")

casualty_cols = [
    "NUMBER OF PERSONS INJURED","NUMBER OF PERSONS KILLED",
    "NUMBER OF PEDESTRIANS INJURED","NUMBER OF PEDESTRIANS KILLED",
    "NUMBER OF CYCLIST INJURED","NUMBER OF CYCLIST KILLED",
    "NUMBER OF MOTORIST INJURED","NUMBER OF MOTORIST KILLED"
]
snapped["casualties_total"] = snapped[casualty_cols].fillna(0).sum(axis=1)

cr_agg = (snapped.groupby(["cluster_id", "t4h"])["casualties_total"].sum()
          .to_frame().reset_index())

cr_agg = cr_agg.merge(cluster_stats[["cluster_id", "n_edges"]], on="cluster_id", how="left")
cr_agg["n_edges"] = cr_agg["n_edges"].clip(lower=1)
cr_agg["casualties_avg_per_edge"] = cr_agg["casualties_total"] / cr_agg["n_edges"]

labels = cr_agg.assign(label=(cr_agg["casualties_avg_per_edge"] >= 0).astype(int))[["cluster_id", "t4h", "label"]]

# ----------------------------
# Synthetic traffic per cluster & 4h bin
# ----------------------------
WEIGHT_RW, WEIGHT_TIME, WEIGHT_SPEED = 0.45, 0.35, 0.15
MAX_SUM = WEIGHT_RW + WEIGHT_TIME + WEIGHT_SPEED  # 0.95

clusters_df = cluster_stats[["cluster_id", "avg_rw", "avg_speed"]].copy()
clusters_df["key"] = 1
ts_df = time_scores.rename("time_score").to_frame().reset_index().rename(columns={"index": "t4h"})
ts_df["key"] = 1

print(f"Combining {len(clusters_df)} clusters × {len(ts_df)} time bins ≈ {len(clusters_df)*len(ts_df):,} rows...")
grid = clusters_df.merge(ts_df, on="key").drop(columns=["key"])

grid["traffic_raw"] = (
    WEIGHT_RW*grid["avg_rw"] +
    WEIGHT_TIME*grid["time_score"] +
    WEIGHT_SPEED*grid["avg_speed"]
)

WEIGHT_RW, WEIGHT_TIME, WEIGHT_SPEED = 0.45, 0.35, 0.15
MAX_SUM = WEIGHT_RW + WEIGHT_TIME + WEIGHT_SPEED  # 0.95
grid["traffic_raw"] = WEIGHT_RW*grid["avg_rw"] + WEIGHT_TIME*grid["time_score"] + WEIGHT_SPEED*grid["avg_speed"]
grid["traffic_volume"] = (grid["traffic_raw"] / MAX_SUM).clip(0, 1)
traffic = grid[["cluster_id", "t4h", "traffic_volume"]].copy()

# ----------------------------
# Base grid: (cluster × time) × weather
# ----------------------------
weather_4h_reset = weather_4h.reset_index().rename(columns={"index": "t4h"})
weather_4h_reset["t4h"] = pd.to_datetime(weather_4h_reset["t4h"])
weather_4h_reset["key"] = 1

clusters_only = cluster_stats[["cluster_id"]].copy()
clusters_only = clusters_only.merge(cluster_centers, on="cluster_id", how="left")
clusters_only["key"] = 1

base = clusters_only.merge(weather_4h_reset, on="key").drop(columns=["key"])

# Join traffic + labels
base = base.merge(traffic, on=["cluster_id", "t4h"], how="left")
base = base.merge(labels, on=["cluster_id", "t4h"], how="left")
base["label"] = base["label"].fillna(0).astype(int)

# Final schema & index
final_cols = ["cluster_id", "lat_sin", "lat_cos", "lon_sin", "lon_cos", "temperature", "precipitation", "rain", "cloudcover", "windspeed", "traffic_volume", "label"]
supertable = base.set_index("t4h").sort_index()[final_cols].copy()
supertable.index.name = "timestamp"

# ----------------------------
# Save
# ----------------------------
os.makedirs(OUT_DIR, exist_ok=True)
supertable.to_parquet(OUT_PARQUET, index=True)
print("Done. Rows:", len(supertable), "| Clusters:", cluster_stats.shape[0], "| Saved to:", OUT_PARQUET)
