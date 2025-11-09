import os
import pandas as pd

OUT_DIR = "../../data/data_backend"
SUPER_PARQUET = os.path.join(OUT_DIR, "../../data/data_final/supertable.parquet")
OUT_PATH = os.path.join(OUT_DIR, "cluster_table.parquet")

TEMPERATURE = 0.36
PRECIPITATION = 0.86
RAIN = 1.0
CLOUDCOVER = 1.0
WINDSPEED = 0.62
TIME = 1.0

GROUP = "cluster_id"
COORD_FEATS = ["lat_sin", "lat_cos", "lon_sin", "lon_cos"]

def build_cluster_coords():
    # Load only what's needed
    df = pd.read_parquet(SUPER_PARQUET, columns=[GROUP] + COORD_FEATS)

    # Check if coords are constant within each cluster
    nunq = df.groupby(GROUP)[COORD_FEATS].nunique(dropna=False)
    coords_constant = (nunq.max() <= 1).all()

    if coords_constant:
        # One set of coords per cluster already → take the first occurrence
        cluster_data = (
            df.drop_duplicates(subset=[GROUP])
              .loc[:, [GROUP] + COORD_FEATS]
              .sort_values(GROUP)
              .reset_index(drop=True)
        )
    else:
        # Coords vary (e.g., multiple time slices) → use mean per cluster
        cluster_data = (
            df.groupby(GROUP, as_index=False)[COORD_FEATS].mean()
              .sort_values(GROUP)
              .reset_index(drop=True)
        )

    cluster_data["temperature"] = TEMPERATURE
    cluster_data["precipitation"] = PRECIPITATION
    cluster_data["rain"] = RAIN
    cluster_data["cloudcover"] = CLOUDCOVER
    cluster_data["windspeed"] = WINDSPEED
    cluster_data["time"] = TIME

    cluster_data.to_parquet(OUT_PATH, index=False)
    print(f"Saved {len(cluster_data):,} clusters with traffic_volume → {OUT_PATH}")
    return cluster_data

build_cluster_coords()