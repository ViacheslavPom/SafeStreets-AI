import os
import json
import gc
import joblib
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupShuffleSplit
import lightgbm as lgb
from torch.utils.tensorboard import SummaryWriter
from pathlib import Path
from sklearn.metrics import average_precision_score, precision_recall_curve



def make_tb_callback(writer, log_train=False):
    """
    Logs LightGBM metrics to TensorBoard at each iteration.
    Set log_train=True if you also pass train_set in valid_sets and want those logs.
    """
    def _callback(env):
        # env.iteration starts from 0; TensorBoard charts better with 1-based steps
        step = env.iteration + 1
        if env.evaluation_result_list is None:
            return
        for data_name, metric_name, value, *_ in env.evaluation_result_list:
            if (data_name == "train" and not log_train):
                continue
            writer.add_scalar(f"{data_name}/{metric_name}", value, step)
    _callback.order = 10
    _callback.before_iteration = False
    return _callback

def make_checkpoint_callback(out_dir: str,
                             every_n: int = 200,
                             metric_name: str = "accuracy",
                             data_name: str = "valid",
                             keep_last_k: int = 5):
    """
    Save model checkpoints during training as LightGBM model files (.lgb):
      • every_n iterations → checkpoint_iter{N}.lgb
      • whenever {data_name}/{metric_name} improves → checkpoint_best.lgb
      • always keep rolling checkpoint_latest.lgb
    """
    p_out = Path(out_dir)
    p_out.mkdir(parents=True, exist_ok=True)

    state = {"best": None, "history": []}

    def _save(model, fname):
        path = p_out / fname
        # save at best_iteration if available, else current_iteration
        n_iter = model.best_iteration or model.current_iteration()
        model.save_model(str(path), num_iteration=n_iter)
        return path

    def _is_better(curr, best):
        # Higher is better for accuracy; lower for loss metrics like 'brier'
        if best is None:
            return True
        if metric_name.lower() in ("accuracy", "auc", "average_precision", "ap"):
            return curr > best
        return curr < best  # loss-like metric

    def _callback(env):
        step = env.iteration + 1

        # periodic snapshot
        if every_n and step % every_n == 0:
            p = _save(env.model, f"checkpoint_iter{step}.lgb")
            state["history"].append(p)
            while len(state["history"]) > keep_last_k:
                old = state["history"].pop(0)
                try:
                    old.unlink(missing_ok=True)
                except Exception:
                    pass

        # check tracked metric
        score_now = None
        for dn, mn, val, *_ in (env.evaluation_result_list or []):
            if dn == data_name and mn == metric_name:
                score_now = float(val); break

        if score_now is not None and _is_better(score_now, state["best"]):
            state["best"] = score_now
            _save(env.model, "checkpoint_best.lgb")

        # always keep rolling latest
        _save(env.model, "checkpoint_latest.lgb")

    _callback.order = 15
    _callback.before_iteration = False
    return _callback


def pr_auc_eval(y_pred, dset):
    y = dset.get_label()
    p = 1.0/(1.0+np.exp(-y_pred))
    return "pr_auc", float(average_precision_score(y, p)), True  # higher better

def balanced_accuracy_eval(y_pred, dset):
    y = dset.get_label()
    p = 1.0/(1.0+np.exp(-y_pred))
    yhat = (p >= 0.5).astype(np.uint8)
    tn = ((y==0)&(yhat==0)).sum(); tp = ((y==1)&(yhat==1)).sum()
    fn = ((y==1)&(yhat==0)).sum(); fp = ((y==0)&(yhat==1)).sum()
    tpr = tp / max(tp+fn, 1); tnr = tn / max(tn+fp, 1)
    bacc = 0.5*(tpr+tnr)
    return "balanced_acc@0.5", float(bacc), True

def acc_at_best_f1_eval(y_pred, dset):
    y = dset.get_label()
    p = 1.0/(1.0+np.exp(-y_pred))
    prec, rec, thr = precision_recall_curve(y, p)
    f1 = 2*prec*rec/(prec+rec+1e-15)
    i = int(np.nanargmax(f1))
    thr_best = 0.5 if i==0 else float(thr[i-1])
    yhat = (p >= thr_best).astype(np.uint8)
    acc = (yhat == y).mean()
    return "acc@bestF1", float(acc), True

def acc_at_p90_eval(y_pred, dset, target_p=0.90):
    y = dset.get_label()
    p = 1.0/(1.0+np.exp(-y_pred))
    prec, rec, thr = precision_recall_curve(y, p)
    # find highest threshold with precision >= target_p
    idx = np.where(prec[:-1] >= target_p)[0]
    thr_use = 1.0 if len(idx)==0 else float(thr[idx[-1]])
    yhat = (p >= thr_use).astype(np.uint8)
    acc = (yhat == y).mean()
    return f"acc@P>={int(target_p*100)}", float(acc), True

def brier_eval(y_pred, dset):
    y = dset.get_label()
    p = 1.0/(1.0+np.exp(-y_pred))
    brier = np.mean((p - y)**2)
    return "brier", float(brier), False  # lower better

TENSORBOARD_DIR = "../tensorboard_logs"
os.makedirs(TENSORBOARD_DIR, exist_ok=True)
# ----------------------------
# Config
# ----------------------------
DATA_PATH = "supertable_v2.parquet"   # change if CSV: use pd.read_csv
# DATA_PATH = "../../data/data_final/supertable_v2.parquet"   # change if CSV: use pd.read_csv

OUTPUT_DIR = "models/lgbm_v2"
os.makedirs(OUTPUT_DIR, exist_ok=True)

USE_GPU = True            # set False to force CPU
VALID_FRACTION = 0.1      # 10% of clusters for validation
RANDOM_STATE = 42
N_BOOST_ROUND = 5000
EARLY_STOP_ROUNDS = 200
N_THREADS = os.cpu_count() or 8

FEATURES = [
    "lat_sin", "lat_cos", "lon_sin", "lon_cos",
    "temperature", "precipitation", "rain", "cloudcover",
    "windspeed", "traffic_volume"
]
LABEL = "label"
GROUP = "cluster_id"      # only for group split; NOT a feature

# ----------------------------
# Load & memory-optimize
# ----------------------------
print("Loading data...")
if DATA_PATH.endswith(".parquet"):
    df = pd.read_parquet(DATA_PATH)
else:
    df = pd.read_csv(DATA_PATH)

required_cols = set(FEATURES + [LABEL, GROUP])
missing = required_cols - set(df.columns)
if missing:
    raise ValueError(f"Missing columns: {missing}")

# Ensure numeric types + guard against infs
df[FEATURES] = df[FEATURES].astype(np.float32)
df[LABEL] = df[LABEL].astype(np.uint8)
df[FEATURES] = df[FEATURES].replace([np.inf, -np.inf], np.nan)

# ----------------------------
# Group-aware split (by cluster_id)
# ----------------------------
print("Splitting by groups (cluster_id)...")
gss = GroupShuffleSplit(n_splits=1, test_size=VALID_FRACTION, random_state=RANDOM_STATE)
groups = df[GROUP].values
train_idx, valid_idx = next(gss.split(df[FEATURES], df[LABEL], groups=groups))
train_df = df.iloc[train_idx]
valid_df = df.iloc[valid_idx]
del df; gc.collect()

X_train = train_df[FEATURES]
y_train = train_df[LABEL].values
X_valid = valid_df[FEATURES]
y_valid = valid_df[LABEL].values

# ----------------------------
# LightGBM datasets
# ----------------------------
USE_GPU = True  # train on GPU
TENSORBOARD_DIR = "../tensorboard_logs"

# ... (load/split data exactly as you already do; keep pandas/NumPy) ...

train_set = lgb.Dataset(X_train, label=y_train, feature_name=FEATURES, free_raw_data=False)
valid_set = lgb.Dataset(X_valid, label=y_valid, feature_name=FEATURES, reference=train_set, free_raw_data=False)

pos = float(y_train.sum())
neg = float(len(y_train) - y_train.sum())
scale_pos_weight = float(max(1.0, neg / max(pos, 1.0)))

params = {
    "objective": "binary",
    "metric": [],                 # use custom feval for accuracy & brier
    "boosting_type": "gbdt",
    "learning_rate": 0.02,
    "num_leaves": 128,
    "path_smooth": 0.5,
    "max_depth": -1,

    "min_data_in_leaf": 20,
    "min_sum_hessian_in_leaf": 15.0,
    "lambda_l2": 5.0,

    "feature_fraction": 0.75,
    "bagging_fraction": 0.75,
    "bagging_freq": 1,

    "scale_pos_weight": scale_pos_weight,

    "deterministic": True,
    "force_col_wise": True,
    "feature_fraction_seed": 42,
    "bagging_seed": 42,
    "data_random_seed": 42,
    "verbosity": -1,
    "num_threads": os.cpu_count() or 8,

    # ---- GPU switch (training on GPU, data on CPU) ----
    "device": "gpu",
    "max_bin": 63,                # faster for GPU
}

writer = SummaryWriter(log_dir=TENSORBOARD_DIR)
tb_cb = make_tb_callback(writer, log_train=False)

N_BOOST_ROUND = 20000
# EARLY_STOP_ROUNDS = 500

ckpt_cb = make_checkpoint_callback(
    out_dir=OUTPUT_DIR,
    every_n=200,
    metric_name="accuracy",   # track best accuracy on 'valid'
    data_name="valid",
    keep_last_k=5
)


fevals = [pr_auc_eval, balanced_accuracy_eval, acc_at_best_f1_eval, brier_eval]

model = lgb.train(
    params | {"metric": ["auc","binary_logloss"], "first_metric_only": True},
    train_set,
    num_boost_round=N_BOOST_ROUND,
    valid_sets=[valid_set],
    valid_names=["valid"],
    feval=fevals,                # logs all; ES uses the first metric (PR-AUC here)
    callbacks=[lgb.log_evaluation(1), tb_cb, ckpt_cb],
)
writer.flush()
writer.close()

MODEL_DIR = OUTPUT_DIR
os.makedirs(MODEL_DIR, exist_ok=True)

MODEL_DIR = OUTPUT_DIR
os.makedirs(MODEL_DIR, exist_ok=True)
model_path = os.path.join(MODEL_DIR, "model.lgb")
model.save_model(model_path, num_iteration=model.best_iteration or model.current_iteration())
print(f"Model saved to: {model_path}")