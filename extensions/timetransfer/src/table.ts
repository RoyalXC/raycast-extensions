import type { BatchConversion } from "./utils";

function cell(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

/** TSV retains one row per input, including invalid entries and duplicates. */
export function buildResultTable(items: BatchConversion[]): string {
  const rows = items.map(({ original, output, error }) =>
    [original, output?.result ?? "", output ? "成功" : (error?.message ?? "无法转换")].map(cell).join("\t"),
  );
  return ["原值\t结果\t状态", ...rows].join("\n");
}
