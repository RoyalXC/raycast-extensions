import type { InputMode, OutputUnit, TimeZoneMode } from "./utils";

export interface ConversionSettings {
  mode: InputMode;
  outputUnit: OutputUnit;
  timeZone: TimeZoneMode;
  closeAfterCopy: boolean;
}

export const DEFAULT_SETTINGS: ConversionSettings = {
  mode: "auto",
  outputUnit: "milliseconds",
  timeZone: "local",
  closeAfterCopy: true,
};

/** Keep valid saved choices and recover individual fields from stale or corrupted settings. */
export function normalizeSettings(value: unknown): ConversionSettings {
  const saved = value && typeof value === "object" ? (value as Partial<ConversionSettings>) : {};
  return {
    mode: saved.mode && ["auto", "seconds", "milliseconds", "date"].includes(saved.mode) ? saved.mode : "auto",
    outputUnit: saved.outputUnit === "seconds" ? "seconds" : "milliseconds",
    timeZone: saved.timeZone === "utc" ? "utc" : "local",
    closeAfterCopy: typeof saved.closeAfterCopy === "boolean" ? saved.closeAfterCopy : true,
  };
}
