import pandas as pd

df = pd.read_csv("../../data/data_raw/NYC_WEATHER.csv")

# parse
df["ts"] = pd.to_datetime(df["time"], format="%Y-%m-%dT%H:%M")

df["time"] = pd.to_datetime(df["time"], format="%Y-%m-%dT%H:%M").dt.strftime("%Y/%m/%d %H")

df = df.sort_values("ts")
df = df.set_index("ts")

cut = pd.to_datetime("2016-01-04")
df = df[df.index >= cut]

cut = pd.to_datetime("2022-10-19")
df = df[df.index <= cut]

cols_to_remain = ["time","temperature_2m (°C)","precipitation (mm)","rain (mm)","cloudcover (%)","windspeed_10m (km/h)"]
df = df[cols_to_remain]
df = df.rename(columns={"temperature_2m (°C)": "temperature", "precipitation (mm)": "precipitation", "rain (mm)": "rain", "cloudcover (%)": "cloudcover", "windspeed_10m (km/h)": "windspeed"})
df = df.dropna()

# df.to_csv("../data_processed/weather.csv")

pd.set_option("display.max_columns", None)
pd.set_option("display.max_colwidth", None)
pd.set_option("display.width", None)
print(df.columns)
print(df.head(1))