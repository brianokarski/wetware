/**
 * Open-Meteo's daily weather, as the API sends it, into one entry per day.
 * The shell always asks for °C and millimetres; the units a day file is
 * written in are chosen when the values are planned.
 */
import { parseDateKey } from "../data";
import { SourceShapeError } from "./problems";

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

export interface WeatherDay {
  /** °C. */
  high: number | null;
  /** °C. */
  low: number | null;
  /** Millimetres. */
  precipitation: number | null;
  /** WMO weather interpretation code. */
  code: number | null;
}

/** The daily series the shell asks for, and the unit each has to come back in. */
const SERIES = {
  high: { name: "temperature_2m_max", unit: "°C" },
  low: { name: "temperature_2m_min", unit: "°C" },
  precipitation: { name: "precipitation_sum", unit: "mm" },
  code: { name: "weather_code", unit: null },
} as const;

const numberAt = (series: unknown, index: number): number | null => {
  const value = Array.isArray(series) ? series[index] : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * `GET /v1/forecast?daily=...`: `daily.time` is a list of local days, and
 * each series is a list of the same length, with null where there is no value.
 */
export function readWeather(raw: unknown): Map<string, WeatherDay> {
  const daily = isDict(raw) ? raw.daily : null;
  if (!isDict(daily) || !Array.isArray(daily.time)) throw new SourceShapeError("the weather had no list of days");
  // A number in the wrong unit would be written as if it were the right one. Better nothing.
  const units = isDict(raw) && isDict(raw.daily_units) ? raw.daily_units : {};
  for (const { name, unit } of Object.values(SERIES)) {
    if (unit !== null && name in units && units[name] !== unit) {
      throw new SourceShapeError(`the weather's ${name} was not in ${unit}`);
    }
  }
  const days = new Map<string, WeatherDay>();
  daily.time.forEach((day, index) => {
    if (typeof day !== "string" || !parseDateKey(day)) return;
    days.set(day, {
      high: numberAt(daily[SERIES.high.name], index),
      low: numberAt(daily[SERIES.low.name], index),
      precipitation: numberAt(daily[SERIES.precipitation.name], index),
      code: numberAt(daily[SERIES.code.name], index),
    });
  });
  return days;
}

/** The words a day's weather is written in. */
export const CONDITIONS = ["clear", "cloudy", "fog", "drizzle", "rain", "snow", "storm"] as const;
export type Condition = (typeof CONDITIONS)[number];

/**
 * WMO weather interpretation codes, as Open-Meteo documents them, in a word.
 * Null for a code that isn't one of them.
 */
export function condition(code: number): Condition | null {
  if (code === 0 || code === 1) return "clear"; // clear sky, mainly clear
  if (code === 2 || code === 3) return "cloudy"; // partly cloudy, overcast
  if (code === 45 || code === 48) return "fog"; // fog, depositing rime fog
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzle"; // drizzle, freezing drizzle
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain"; // rain, freezing rain, rain showers
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow"; // snowfall, snow grains, snow showers
  if ([95, 96, 99].includes(code)) return "storm"; // thunderstorm, with or without hail
  return null;
}
