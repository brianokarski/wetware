import { parse } from "yaml";
import type { DataFs } from "./fs";
import { patchYaml } from "./yamlPatch";

export const SETTINGS_FILE = "settings.yaml";

export interface Location {
  name: string;
  latitude: number | null;
  longitude: number | null;
}

export interface Units {
  weight: "lb" | "kg";
  temperature: "F" | "C";
}

/** Non-secret settings only. The intervals.icu key lives in the Keychain. */
export interface Settings {
  location: Location;
  units: Units;
}

export const DEFAULT_SETTINGS: Settings = {
  location: { name: "", latitude: null, longitude: null },
  units: { weight: "lb", temperature: "F" },
};

export function parseSettings(raw: string | null): Settings {
  const data = (raw ? parse(raw) : null) as Partial<Settings> | null;
  return {
    location: { ...DEFAULT_SETTINGS.location, ...data?.location },
    units: { ...DEFAULT_SETTINGS.units, ...data?.units },
  };
}

export async function loadSettings(fs: DataFs): Promise<Settings> {
  return parseSettings(await fs.read(SETTINGS_FILE));
}

/** Patches settings.yaml in place so hand-added keys and comments survive. */
export async function saveSettings(fs: DataFs, patch: Partial<Settings>): Promise<Settings> {
  const next = patchYaml(await fs.read(SETTINGS_FILE), patch);
  await fs.write(SETTINGS_FILE, next);
  return parseSettings(next);
}
