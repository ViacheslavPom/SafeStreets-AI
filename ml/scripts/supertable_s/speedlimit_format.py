import pandas as pd

df = pd.read_csv("../../data/data_raw/SPEED_LIMITS.csv")


cols_to_remain = ["the_geom", "postvz_sl"]
df = df[cols_to_remain]
df = df.rename(columns={"the_geom": "coordinates", "postvz_sl": "speedlimit"})
df = df.dropna()

pd.set_option("display.max_columns", None)
pd.set_option("display.max_colwidth", None)
pd.set_option("display.width", None)
print(df.head(1))
# df.to_csv("../data_processed/speedlimit.csv")
