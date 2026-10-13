import { Action, ActionPanel, Clipboard, closeMainWindow, Icon, List, showToast, Toast } from "@raycast/api";
import { InputSource } from "./input";
import { ConversionSettings, DEFAULT_SETTINGS } from "./settings";
import { buildResultTable } from "./table";
import { BatchConversion, InputMode } from "./utils";

const INPUT_MODES = [
  { value: "auto", title: "自动识别", key: "1" },
  { value: "seconds", title: "秒级时间戳", key: "2" },
  { value: "milliseconds", title: "毫秒级时间戳", key: "3" },
  { value: "date", title: "日期（含 yyyyMMdd）", key: "4" },
] as const;

interface FormatViewProps {
  items: BatchConversion[];
  searchText: string;
  onSearchTextChange: (text: string) => void;
  settings: ConversionSettings;
  onSettingsChange: (patch: Partial<ConversionSettings>) => void;
  onReadClipboard: () => Promise<void>;
  inputSource: InputSource;
  isLoading: boolean;
}

export default function FormatView({
  items,
  searchText,
  onSearchTextChange,
  settings,
  onSettingsChange,
  onReadClipboard,
  inputSource,
  isLoading,
}: FormatViewProps) {
  const validItems = items.flatMap((item, index) => (item.output ? [{ output: item.output, index }] : []));
  const invalidItems = items.flatMap((item, index) => (!item.output ? [{ ...item, index }] : []));
  const allResults = validItems.map(({ output }) => output.result).join("\n");
  const timeZone = settings.timeZone === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const outputUnitLabel = settings.outputUnit === "seconds" ? "秒" : "毫秒";
  const sourceLabel = { selection: "选中文本", clipboard: "剪贴板", manual: "手动输入" }[inputSource];

  const handleCopy = async (text: string, title = "已复制结果") => {
    try {
      await Clipboard.copy(text);
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "复制失败", message: "请重试" });
      return;
    }
    await showToast({ style: Toast.Style.Success, title });
    if (settings.closeAfterCopy) await closeMainWindow();
  };

  const commonActions = (
    <>
      <ActionPanel.Section title="批量与输入">
        {validItems.length > 0 && items.length > 1 && (
          <Action
            title={`复制全部有效结果 (${validItems.length})`}
            onAction={() =>
              handleCopy(
                allResults,
                `已复制 ${validItems.length} 条结果${invalidItems.length ? `，跳过 ${invalidItems.length} 条无效输入` : ""}`,
              )
            }
            icon={Icon.CopyClipboard}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        )}
        {items.length > 0 && (
          <Action
            title="复制对照表（含无效项）"
            onAction={() => handleCopy(buildResultTable(items), `已复制 ${items.length} 行对照表`)}
            icon={Icon.CopyClipboard}
            shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
          />
        )}
        <Action
          title="从剪贴板读取"
          onAction={onReadClipboard}
          icon={Icon.Clipboard}
          shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="输入模式">
        {INPUT_MODES.map((option) => (
          <Action
            key={option.value}
            title={`切换为${option.title}`}
            icon={settings.mode === option.value ? Icon.CheckCircle : Icon.Circle}
            shortcut={{ modifiers: ["cmd", "opt"], key: option.key }}
            onAction={() => onSettingsChange({ mode: option.value })}
          />
        ))}
      </ActionPanel.Section>
      <ActionPanel.Section title="设置（自动保存）">
        <Action
          title={settings.timeZone === "local" ? "改用 UTC 时区" : "改用本地时区"}
          icon={Icon.Globe}
          onAction={() => onSettingsChange({ timeZone: settings.timeZone === "local" ? "utc" : "local" })}
        />
        <Action
          title={`日期输出改为${settings.outputUnit === "milliseconds" ? "秒" : "毫秒"}`}
          icon={Icon.Clock}
          onAction={() =>
            onSettingsChange({ outputUnit: settings.outputUnit === "milliseconds" ? "seconds" : "milliseconds" })
          }
        />
        <Action
          title={settings.closeAfterCopy ? "复制后保持窗口" : "复制后关闭窗口"}
          icon={Icon.Window}
          onAction={() => onSettingsChange({ closeAfterCopy: !settings.closeAfterCopy })}
        />
        <Action title="恢复默认设置" icon={Icon.ArrowClockwise} onAction={() => onSettingsChange(DEFAULT_SETTINGS)} />
      </ActionPanel.Section>
    </>
  );

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={onSearchTextChange}
      searchBarPlaceholder="输入时间戳或日期，支持逗号分隔多条..."
      filtering={false}
      navigationTitle={`时间戳转换 · ${timeZone} · 日期输出${outputUnitLabel}`}
      searchBarAccessory={
        <List.Dropdown
          tooltip="输入格式与时间戳单位"
          value={settings.mode}
          onChange={(value) => onSettingsChange({ mode: value as InputMode })}
        >
          {INPUT_MODES.map((option) => (
            <List.Dropdown.Item key={option.value} title={option.title} value={option.value} />
          ))}
        </List.Dropdown>
      }
    >
      {validItems.length > 0 && (
        <List.Section title={`转换结果 (${validItems.length}) · ${sourceLabel}`}>
          {validItems.map(({ output, index }) => (
            <List.Item
              key={`result-${index}`}
              icon={Icon.CheckCircle}
              title={output.result}
              subtitle={`源: ${output.original}`}
              accessories={[
                {
                  text:
                    output.type === "date"
                      ? `日期 → ${outputUnitLabel}`
                      : `${output.timestampUnit === "seconds" ? "秒" : "毫秒"} → ${timeZone}`,
                },
              ]}
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="复制">
                    <Action title="复制结果" onAction={() => handleCopy(output.result)} icon={Icon.CopyClipboard} />
                    <Action
                      title="复制原始内容"
                      onAction={() => handleCopy(output.original, "已复制原始内容")}
                      icon={Icon.CopyClipboard}
                    />
                  </ActionPanel.Section>
                  {commonActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {invalidItems.length > 0 && (
        <List.Section title={`无法转换 (${invalidItems.length})`}>
          {invalidItems.map(({ original, error, index }) => (
            <List.Item
              key={`invalid-${index}`}
              icon={Icon.ExclamationMark}
              title={original}
              subtitle={error?.message ?? "格式不支持，请检查输入或切换模式"}
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="复制">
                    <Action
                      title="复制错误说明"
                      onAction={() => handleCopy(`${original}\t${error?.message ?? "无法转换"}`, "已复制错误说明")}
                      icon={Icon.CopyClipboard}
                    />
                    <Action
                      title="复制输入内容"
                      onAction={() => handleCopy(original, "已复制输入内容")}
                      icon={Icon.CopyClipboard}
                    />
                  </ActionPanel.Section>
                  {commonActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {items.length === 0 && (
        <List.EmptyView
          icon={Icon.Clock}
          title={isLoading && !searchText.trim() ? "正在读取输入" : "输入时间戳或日期"}
          description="优先读取选中文本，否则读取剪贴板。yyyyMMdd 请选日期模式；⌘⇧V 重新读取剪贴板。"
          actions={<ActionPanel>{commonActions}</ActionPanel>}
        />
      )}
    </List>
  );
}
