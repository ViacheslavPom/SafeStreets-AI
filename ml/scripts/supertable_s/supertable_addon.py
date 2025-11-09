import numpy as np
from pandas.util import hash_pandas_object
import pyarrow as pa
import pyarrow.parquet as pq
from tqdm import tqdm

IN_PARQUET  = "../data_final/supertable.parquet"
OUT_PARQUET = "../data_final/supertable_v2.parquet"

pf = pq.ParquetFile(IN_PARQUET)

writer = None
tot_in = pos_in = neg_in = 0
tot_out = pos_out = neg_out = 0

pbar = tqdm(total=pf.num_row_groups, desc="Filtering ~50% negatives per cluster", unit="rg")

def ensure_timestamp_column(df):
    # If timestamp is the index, bring it back as a column
    if "timestamp" not in df.columns:
        if df.index.name == "timestamp":
            df = df.reset_index()
        elif "__index_level_0__" in df.columns:
            df = df.rename(columns={"__index_level_0__": "timestamp"})
        else:
            # Try to detect a single datetime-like column and treat it as timestamp
            dt_candidates = [c for c in df.columns if np.issubdtype(df[c].dtype, np.datetime64)]
            if len(dt_candidates) == 1:
                df = df.rename(columns={dt_candidates[0]: "timestamp"})
            else:
                raise KeyError(
                    "Couldn't find 'timestamp' as a column or index. "
                    f"Available columns: {list(df.columns)} | index name: {df.index.name}"
                )
    return df

for rg in range(pf.num_row_groups):
    tbl = pf.read_row_group(rg)  # if you know exact names you can pass columns=[...]
    df = tbl.to_pandas()         # get a pandas chunk

    # Normalize schema
    df = ensure_timestamp_column(df)
    if "cluster_id" not in df.columns:
        raise KeyError("'cluster_id' missing from columns.")
    if "label" not in df.columns:
        raise KeyError("'label' missing from columns.")

    # counters in
    n = len(df)
    pos_mask = (df["label"] == 1)
    neg_mask = ~pos_mask
    n_pos = int(pos_mask.sum())
    n_neg = int(neg_mask.sum())
    tot_in += n; pos_in += n_pos; neg_in += n_neg

    # deterministic per-row U[0,1) from hash(cluster_id, timestamp)
    h = hash_pandas_object(
        df[["cluster_id", "timestamp"]],
        index=False,
        categorize=True
    ).astype(np.uint64)
    u = (h / np.float64(2**64)).to_numpy()

    # keep all positives; for negatives, keep those with u >= 0.5 (drop ~50%)
    keep_mask = pos_mask | (neg_mask & (u >= 0.5))
    df_out = df.loc[keep_mask]

    # counters out
    n_out = len(df_out)
    n_pos_out = int((df_out["label"] == 1).sum())
    n_neg_out = int((df_out["label"] == 0).sum())
    tot_out += n_out; pos_out += n_pos_out; neg_out += n_neg_out

    # write/append — do NOT preserve index to avoid hidden __index_level_0__
    tbl_out = pa.Table.from_pandas(df_out, preserve_index=False)
    if writer is None:
        writer = pq.ParquetWriter(OUT_PARQUET, tbl_out.schema, compression="zstd")
    writer.write_table(tbl_out)

    kept_ratio = (neg_out / max(1, neg_in))
    pbar.set_postfix({
        "rg_rows": n,
        "rg_kept": n_out,
        "neg_kept%": f"{kept_ratio*100:.1f}"
    })
    pbar.update(1)

pbar.close()
if writer is not None:
    writer.close()

print({
    "in_rows": tot_in,
    "in_pos": pos_in,
    "in_neg": neg_in,
    "out_rows": tot_out,
    "out_pos": pos_out,
    "out_neg": neg_out,
    "neg_kept_ratio": neg_out / max(1, neg_in)
})
