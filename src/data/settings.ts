import type { DataFs } from "./fs";
import { inTurn } from "./queue";
import { isDict, patchYaml, readYaml, type YamlOp } from "./yamlPatch";

export const SETTINGS_FILE = "settings.yaml";

export interface Location {
  name: string;
  latitude: number | null;
  longitude: number | null;
}

export const WEIGHT_UNITS = ["lb", "kg"] as const;
export const TEMPERATURE_UNITS = ["F", "C"] as const;

export interface Units {
  weight: (typeof WEIGHT_UNITS)[number];
  temperature: (typeof TEMPERATURE_UNITS)[number];
}

/** Non-secret settings only. The intervals.icu key lives in the Keychain. */
export interface Settings {
  location: Location;
  units: Units;
}

/** Any subset of the settings. Only the fields named are written. */
export interface SettingsPatch {
  location?: Partial<Location>;
  units?: Partial<Units>;
}

export const DEFAULT_SETTINGS: Settings = {
  location: { name: "", latitude: null, longitude: null },
  units: { weight: "lb", temperature: "F" },
};

/** settings.yaml can't be used as it is, or a value isn't one that may be saved. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

const inRange = (value: unknown, limit: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

export const isLatitude = (value: unknown): value is number => inRange(value, 90);
export const isLongitude = (value: unknown): value is number => inRange(value, 180);

function oneOf<T extends string>(options: readonly T[], value: unknown): T | null {
  return options.find((option) => option === value) ?? null;
}

/**
 * Reads settings, checking every field. A value of the wrong type or out of
 * range is ignored and its default used; the file itself is left as it is.
 * Throws if the file isn't valid YAML or isn't a map, since it then can't be
 * saved to either.
 */
export function parseSettings(raw: string | null): Settings {
  const data = readYaml(raw) ?? {};
  if (!isDict(data)) {
    throw new SettingsError(`${SETTINGS_FILE} has to be a list of key: value lines`);
  }
  const location = isDict(data.location) ? data.location : {};
  const units = isDict(data.units) ? data.units : {};
  const defaults = DEFAULT_SETTINGS;
  return {
    location: {
      name: typeof location.name === "string" ? location.name : defaults.location.name,
      latitude: isLatitude(location.latitude) ? location.latitude : defaults.location.latitude,
      longitude: isLongitude(location.longitude) ? location.longitude : defaults.location.longitude,
    },
    units: {
      weight: oneOf(WEIGHT_UNITS, units.weight) ?? defaults.units.weight,
      temperature: oneOf(TEMPERATURE_UNITS, units.temperature) ?? defaults.units.temperature,
    },
  };
}

export async function loadSettings(fs: DataFs): Promise<Settings> {
  return parseSettings(await fs.read(SETTINGS_FILE));
}

/** Throws unless every field in the patch is a value that may be saved. */
function checkPatch({ location, units }: SettingsPatch): void {
  const bad = (field: string) => new SettingsError(`Not a valid ${field}`);
  if (location?.name !== undefined && typeof location.name !== "string") throw bad("location name");
  if (location?.latitude !== undefined && location.latitude !== null && !isLatitude(location.latitude)) {
    throw bad("latitude");
  }
  if (location?.longitude !== undefined && location.longitude !== null && !isLongitude(location.longitude)) {
    throw bad("longitude");
  }
  if (units?.weight !== undefined && !oneOf(WEIGHT_UNITS, units.weight)) throw bad("weight unit");
  if (units?.temperature !== undefined && !oneOf(TEMPERATURE_UNITS, units.temperature)) {
    throw bad("temperature unit");
  }
}

/**
 * Patches settings.yaml in place, one value at a time, so comments, hand-added
 * keys and everything else in the file survive. A field that already has the
 * given value is not written, so defaults never land on disk by themselves.
 */
export function saveSettings(fs: DataFs, patch: SettingsPatch): Promise<Settings> {
  checkPatch(patch);
  return inTurn(fs, SETTINGS_FILE, async () => {
    const raw = await fs.read(SETTINGS_FILE);
    const current = parseSettings(raw) as unknown as Record<string, Record<string, unknown>>;
    const ops: YamlOp[] = [];
    for (const [group, fields] of Object.entries(patch)) {
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value !== undefined && value !== current[group][key]) {
          ops.push({ op: "set", path: [group, key], value });
        }
      }
    }
    const next = patchYaml(raw, ops);
    if (next !== raw) await fs.write(SETTINGS_FILE, next);
    return parseSettings(next);
  });
}
