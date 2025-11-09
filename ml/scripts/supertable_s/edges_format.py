import pandas as pd

df = pd.read_csv("../../data/data_raw/EDGES.csv")


cols_to_remain = ["the_geom", "RW_TYPE"]
df = df[cols_to_remain]
df = df.rename(columns={"the_geom": "coordinates", "RW_TYPE": "rw_type"})
df = df.dropna()

pd.set_option("display.max_columns", None)
pd.set_option("display.max_colwidth", None)
pd.set_option("display.width", None)
print(df.head(1))
# df.to_csv("../data_processed/edges.csv")
