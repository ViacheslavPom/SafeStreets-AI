import pandas as pd

df = pd.read_csv("../../data/data_raw/CAR_CRASH.csv")
# cols = ["NUMBER OF PERSONS INJURED", "NUMBER OF PERSONS KILLED", "NUMBER OF PEDESTRIANS INJURED", "NUMBER OF PEDESTRIANS KILLED", "NUMBER OF CYCLIST INJURED", "NUMBER OF CYCLIST KILLED", "NUMBER OF MOTORIST INJURED", "NUMBER OF MOTORIST KILLED"]

dt = df["CRASH DATE"] + " " + df["CRASH TIME"]

# parse
df["ts"] = pd.to_datetime(dt, format="%m/%d/%Y %H:%M")

df["time"] = (
    pd.to_datetime(df["CRASH DATE"] + " " + df["CRASH TIME"], format="%m/%d/%Y %H:%M")
      .dt.strftime("%Y/%m/%d %H")
)

df = df.sort_values("ts")
df = df.set_index("ts")

cut = pd.to_datetime("2016-01-04")
df = df[df.index >= cut]

cut = pd.to_datetime("2022-10-19")
df = df[df.index <= cut]

cols_to_remain = ["time","LATITUDE","LONGITUDE","NUMBER OF PERSONS INJURED","NUMBER OF PERSONS KILLED","NUMBER OF PEDESTRIANS INJURED","NUMBER OF PEDESTRIANS KILLED","NUMBER OF CYCLIST INJURED","NUMBER OF CYCLIST KILLED","NUMBER OF MOTORIST INJURED","NUMBER OF MOTORIST KILLED"]
df = df[cols_to_remain]
df = df.dropna()

# df.to_csv("../data_processed/crashes.csv")

pd.set_option("display.max_columns", None)
pd.set_option("display.max_colwidth", None)
pd.set_option("display.width", None)
print(df.columns)
print(df.head(1))