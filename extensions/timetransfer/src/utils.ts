export type InputMode = "auto" | "seconds" | "milliseconds" | "date";
export type TimeZoneMode = "local" | "utc";
export type OutputUnit = "milliseconds" | "seconds";

export type ConversionOptions = {
  timeZone?: TimeZoneMode;
  outputUnit?: OutputUnit;
};

export type ConversionError = {
  code:
    | "empty_input"
    | "invalid_format"
    | "invalid_date"
    | "invalid_time"
    | "invalid_timezone"
    | "sub_millisecond_precision"
    | "non_integer_milliseconds"
    | "out_of_range"
    | "mode_mismatch";
  message: string;
};

export type ConvertResult = {
  type: "timestamp" | "date";
  result: string;
  original: string;
  timestampUnit?: "seconds" | "milliseconds";
  outputUnit?: OutputUnit;
};

export type BatchConversion = {
  original: string;
  output: ConvertResult | null;
  error?: ConversionError;
};

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000n;
const AUTO_SECONDS_THRESHOLD = 100_000_000_000n;
const NUMERIC_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;
const LOCAL_DATE_PATTERN = /^(\d{4,6})([-/])(\d{2})\2(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;
const COMPACT_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const EXPLICIT_DATE_PATTERN = /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

type ParseOutcome = { output: ConvertResult } | { error: ConversionError };
type CalendarOutcome = { date: Date } | { error: ConversionError };

function error(code: ConversionError["code"], message: string): ConversionError {
  return { code, message };
}

function formatYear(year: number): string {
  return year < 0 ? `-${String(Math.abs(year)).padStart(4, "0")}` : String(year).padStart(4, "0");
}

function formatDate(date: Date, timeZone: TimeZoneMode): string {
  const year = formatYear(timeZone === "utc" ? date.getUTCFullYear() : date.getFullYear());
  const month = String((timeZone === "utc" ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, "0");
  const day = String(timeZone === "utc" ? date.getUTCDate() : date.getDate()).padStart(2, "0");
  const hours = String(timeZone === "utc" ? date.getUTCHours() : date.getHours()).padStart(2, "0");
  const minutes = String(timeZone === "utc" ? date.getUTCMinutes() : date.getMinutes()).padStart(2, "0");
  const seconds = String(timeZone === "utc" ? date.getUTCSeconds() : date.getSeconds()).padStart(2, "0");
  const milliseconds = timeZone === "utc" ? date.getUTCMilliseconds() : date.getMilliseconds();
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}${milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : ""}`;
}

function normalizeEpochMilliseconds(
  value: bigint,
  original: string,
  unit: "seconds" | "milliseconds",
  timeZone: TimeZoneMode,
): ParseOutcome {
  if (value < -MAX_DATE_MILLISECONDS || value > MAX_DATE_MILLISECONDS) {
    return { error: error("out_of_range", "时间戳超出可表示日期范围。") };
  }
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return { error: error("out_of_range", "时间戳超出可表示日期范围。") };
  return {
    output: { type: "timestamp", original, result: formatDate(date, timeZone), timestampUnit: unit },
  };
}

function parseNumericTimestamp(
  value: string,
  mode: InputMode,
  original: string,
  timeZone: TimeZoneMode,
): ParseOutcome | undefined {
  const match = NUMERIC_PATTERN.exec(value);
  if (!match) return undefined;
  if (mode === "date")
    return { error: error("mode_mismatch", "纯数字默认是时间戳；如需解析 yyyyMMdd，请切换日期模式。") };

  const sign = match[1] === "-" ? -1n : 1n;
  const wholeText = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const hasFractionalValue = /[1-9]/.test(fraction);
  const whole = BigInt(wholeText);
  let unit: "seconds" | "milliseconds";
  if (mode === "seconds") {
    unit = "seconds";
  } else if (mode === "milliseconds") {
    unit = "milliseconds";
  } else {
    unit = whole < AUTO_SECONDS_THRESHOLD ? "seconds" : "milliseconds";
  }

  if (mode === "milliseconds" && hasFractionalValue) {
    return { error: error("non_integer_milliseconds", "毫秒时间戳必须是整数；请改用秒级模式表示小数秒。") };
  }
  if (unit === "milliseconds" && hasFractionalValue) {
    return { error: error("non_integer_milliseconds", "毫秒时间戳必须是整数；请切换秒级模式表示小数秒。") };
  }
  if (unit === "seconds" && fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) {
    return { error: error("sub_millisecond_precision", "秒级时间戳最多支持毫秒精度，请缩短小数位。") };
  }

  const epochMilliseconds =
    unit === "seconds"
      ? sign * (whole * 1_000n + BigInt((fraction.slice(0, 3) + "000").slice(0, 3) || "0"))
      : sign * whole;
  return normalizeEpochMilliseconds(epochMilliseconds, original, unit, timeZone);
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function buildCalendarDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: TimeZoneMode,
): CalendarOutcome {
  if (!isValidCalendarDate(year, month, day)) {
    return { error: error("invalid_date", "日期无效，请检查年月日和闰年日期。") };
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return { error: error("invalid_time", "时间无效，请检查时分秒（不支持闰秒）。") };
  }

  const date = new Date(0);
  if (timeZone === "utc") {
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, millisecond);
    if (!Number.isFinite(date.getTime())) return { error: error("out_of_range", "日期超出可表示范围。") };
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day ||
      date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute ||
      date.getUTCSeconds() !== second ||
      date.getUTCMilliseconds() !== millisecond
    ) {
      return { error: error("invalid_time", "日期时间无效，请检查时间字段。") };
    }
  } else {
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, second, millisecond);
    if (!Number.isFinite(date.getTime())) return { error: error("out_of_range", "日期超出可表示范围。") };
    if (
      date.getFullYear() !== year ||
      date.getMonth() + 1 !== month ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute ||
      date.getSeconds() !== second ||
      date.getMilliseconds() !== millisecond
    ) {
      return { error: error("invalid_time", "本机时区不存在该本地时间，请选择其他时间或使用带时区的日期。") };
    }
  }
  if (!Number.isFinite(date.getTime())) return { error: error("out_of_range", "日期超出可表示范围。") };
  return { date };
}

function outputDate(date: Date, original: string, options: ConversionOptions): ConvertResult {
  const outputUnit = options.outputUnit ?? "milliseconds";
  const epochMilliseconds = BigInt(date.getTime());
  let result: string;
  if (outputUnit === "seconds") {
    const sign = epochMilliseconds < 0n ? "-" : "";
    const absolute = epochMilliseconds < 0n ? -epochMilliseconds : epochMilliseconds;
    const wholeSeconds = absolute / 1_000n;
    const millisecondRemainder = absolute % 1_000n;
    const fraction =
      millisecondRemainder === 0n ? "" : `.${String(millisecondRemainder).padStart(3, "0").replace(/0+$/, "")}`;
    result = `${sign}${wholeSeconds}${fraction}`;
  } else {
    result = epochMilliseconds.toString();
  }
  return { type: "date", original, result, outputUnit };
}

function resultFromDate(date: Date, original: string, options: ConversionOptions): ParseOutcome {
  if (!Number.isFinite(date.getTime()) || Math.abs(date.getTime()) > Number(MAX_DATE_MILLISECONDS)) {
    return { error: error("out_of_range", "日期超出可表示范围。") };
  }
  return { output: outputDate(date, original, options) };
}

function parseDate(value: string, original: string, options: ConversionOptions): ParseOutcome {
  const timeZone = options.timeZone ?? "local";
  const explicitZone = EXPLICIT_DATE_PATTERN.exec(value);

  if (explicitZone) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", rawFraction = "", zone] =
      explicitZone;
    if (!/^(?:Z|[+-]\d{2}:\d{2})$/.test(zone)) {
      return { error: error("invalid_timezone", "时区格式无效，请使用 Z 或 ±HH:mm。") };
    }
    if (rawFraction.length > 3) {
      return { error: error("invalid_time", "日期毫秒最多支持三位小数。") };
    }
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const millisecond = Number((rawFraction + "000").slice(0, 3));
    const wallClock = buildCalendarDate(year, month, day, hour, minute, second, millisecond, "utc");
    if ("error" in wallClock) return wallClock;

    let offsetMinutes = 0;
    if (zone !== "Z") {
      const offset = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
      if (!offset) return { error: error("invalid_timezone", "时区格式无效，请使用 Z 或 ±HH:mm。") };
      const offsetHours = Number(offset[2]);
      const offsetRemainder = Number(offset[3]);
      if (offsetHours > 23 || offsetRemainder > 59) {
        return { error: error("invalid_timezone", "时区偏移超出范围，请检查 ±HH:mm。") };
      }
      offsetMinutes = (offsetHours * 60 + offsetRemainder) * (offset[1] === "+" ? 1 : -1);
    }
    const date = new Date(wallClock.date.getTime() - offsetMinutes * 60_000);
    return resultFromDate(date, original, options);
  }

  const local = LOCAL_DATE_PATTERN.exec(value);
  const compact = COMPACT_DATE_PATTERN.exec(value);
  if (!local && !compact) {
    const timeSeparator = value.indexOf("T");
    if (timeSeparator >= 0) {
      const zoneMarker = /[Zz+-]/.exec(value.slice(timeSeparator + 1));
      if (zoneMarker) {
        const zoneStart = timeSeparator + 1 + zoneMarker.index;
        if (LOCAL_DATE_PATTERN.test(value.slice(0, zoneStart))) {
          return { error: error("invalid_timezone", "时区格式无效，请使用 Z 或 ±HH:mm。") };
        }
      }
    }
    const dateLike = /^\d{4,6}[-/]\d{2}[-/]\d{2}/.test(value);
    if (dateLike)
      return { error: error("invalid_format", "日期格式不完整，请使用 YYYY-MM-DD 或 YYYY-MM-DD HH:mm[:ss]。") };
    return { error: error("invalid_format", "格式不支持，请输入时间戳或日期。") };
  }
  const fields = local
    ? {
        year: Number(local[1]),
        month: Number(local[3]),
        day: Number(local[4]),
        hour: Number(local[5] ?? "0"),
        minute: Number(local[6] ?? "0"),
        second: Number(local[7] ?? "0"),
        fraction: local[8] ?? "",
      }
    : {
        year: Number(compact![1]),
        month: Number(compact![2]),
        day: Number(compact![3]),
        hour: 0,
        minute: 0,
        second: 0,
        fraction: "",
      };
  if (fields.fraction.length > 3) {
    return { error: error("invalid_time", "日期毫秒最多支持三位小数。") };
  }
  const parsed = buildCalendarDate(
    fields.year,
    fields.month,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    Number((fields.fraction + "000").slice(0, 3)),
    timeZone,
  );
  if ("error" in parsed) return parsed;
  return resultFromDate(parsed.date, original, options);
}

/** Converts one input and returns a stable, user-facing diagnostic on failure. */
export function convertInput(
  input: string,
  mode: InputMode = "auto",
  options: ConversionOptions = {},
): { output: ConvertResult | null; error?: ConversionError } {
  const original = input.trim();
  if (!original) return { output: null, error: error("empty_input", "请输入时间戳或日期。") };
  if (!["auto", "seconds", "milliseconds", "date"].includes(mode)) {
    return { output: null, error: error("mode_mismatch", "输入模式无效，请重新选择输入格式。") };
  }
  if (options.timeZone !== undefined && !["local", "utc"].includes(options.timeZone)) {
    return { output: null, error: error("invalid_timezone", "时区设置无效，请选择本机时区或 UTC。") };
  }
  if (options.outputUnit !== undefined && !["milliseconds", "seconds"].includes(options.outputUnit)) {
    return { output: null, error: error("invalid_format", "输出单位无效，请重新选择秒或毫秒。") };
  }

  if (mode !== "date") {
    const numeric = parseNumericTimestamp(original, mode, original, options.timeZone ?? "local");
    if (numeric) return "error" in numeric ? { output: null, error: numeric.error } : { output: numeric.output };
  } else if (NUMERIC_PATTERN.test(original) && !COMPACT_DATE_PATTERN.test(original)) {
    return {
      output: null,
      error: error("mode_mismatch", "日期模式只接受 yyyyMMdd 或日期文本；纯数字时间戳请切回时间戳模式。"),
    };
  }

  const dateLike =
    LOCAL_DATE_PATTERN.test(original) || EXPLICIT_DATE_PATTERN.test(original) || COMPACT_DATE_PATTERN.test(original);
  if ((mode === "seconds" || mode === "milliseconds") && dateLike) {
    return { output: null, error: error("mode_mismatch", "当前是时间戳模式；日期输入请切换日期模式。") };
  }
  if (mode === "seconds" || mode === "milliseconds") {
    const numericLike = /^[+-]?(?:\d|\.\d)/.test(original);
    return {
      output: null,
      error: numericLike
        ? { code: "invalid_format", message: "数字格式不支持，请移除科学计数法等额外字符。" }
        : { code: "mode_mismatch", message: "当前是时间戳模式；日期输入请切换日期模式。" },
    };
  }

  const parsed = parseDate(original, original, options);
  return "error" in parsed ? { output: null, error: parsed.error } : { output: parsed.output };
}

/** Compatibility helper that returns only the conversion result. */
export function tryConvert(
  input: string,
  mode: InputMode = "auto",
  options: ConversionOptions = {},
): ConvertResult | null {
  return convertInput(input, mode, options).output;
}

/** Splits common list separators while preserving date-time spaces and order. */
export function convertBatch(
  input: string,
  mode: InputMode = "auto",
  options: ConversionOptions = {},
): BatchConversion[] {
  const chunks = input.split(/[\r\n,;，；\t]+/);
  const numericListPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+))+$/;

  return chunks.flatMap((chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return [];
    const values = numericListPattern.test(trimmed) ? trimmed.split(/\s+/) : [trimmed];
    return values.map((original) => {
      const parsed = convertInput(original, mode, options);
      return { original, output: parsed.output, error: parsed.error };
    });
  });
}
