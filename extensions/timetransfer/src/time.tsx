import { Clipboard, getSelectedText, showToast, Toast } from "@raycast/api";
import { useCachedState } from "@raycast/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import FormatView from "./FormatView";
import { initializeInput, InputReadTimeoutError, InputSource, prepareSearchText, withReadTimeout } from "./input";
import { ConversionSettings, DEFAULT_SETTINGS, normalizeSettings } from "./settings";
import { convertBatch } from "./utils";

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const [savedSettings, setSavedSettings] = useCachedState<ConversionSettings>(
    "conversion-settings-v1",
    DEFAULT_SETTINGS,
  );
  const settings = useMemo(() => normalizeSettings(savedSettings), [savedSettings]);
  const [inputSource, setInputSource] = useState<InputSource>("manual");
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [isLoadingClipboard, setIsLoadingClipboard] = useState(false);
  const inputRevision = useRef(0);
  const currentInput = useRef("");
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    let active = true;
    const revision = inputRevision.current;
    const isCurrent = () => active && inputRevision.current === revision;

    void initializeInput({
      readSelection: getSelectedText,
      readClipboard: Clipboard.readText,
      isCurrent,
      onInput: (text, source) => {
        const preparedText = prepareSearchText(text);
        currentInput.current = preparedText;
        setSearchText(preparedText);
        setInputSource(source);
      },
    })
      .catch(async (error: unknown) => {
        if (isCurrent()) {
          await showToast({
            style: Toast.Style.Failure,
            title: error instanceof InputReadTimeoutError ? "读取输入超时" : "读取剪贴板失败",
            message: "可以手动输入，或按 ⌘⇧V 重试",
          });
        }
      })
      .finally(() => {
        if (active) setIsLoadingInitial(false);
      });

    return () => {
      active = false;
      isMounted.current = false;
    };
  }, []);

  const handleSearchTextChange = (text: string) => {
    // Raycast may echo a programmatic update through onSearchTextChange.
    if (text === currentInput.current) return;
    inputRevision.current += 1;
    currentInput.current = text;
    setSearchText(text);
    setInputSource("manual");
  };

  const handleReadClipboard = async () => {
    if (isLoadingClipboard) return;
    const revision = ++inputRevision.current;
    setIsLoadingClipboard(true);
    try {
      const text = await withReadTimeout(Clipboard.readText);
      if (isMounted.current && inputRevision.current === revision) {
        const preparedText = prepareSearchText(text ?? "");
        currentInput.current = preparedText;
        setSearchText(preparedText);
        setInputSource("clipboard");
      }
    } catch (error: unknown) {
      if (isMounted.current && inputRevision.current === revision) {
        await showToast({
          style: Toast.Style.Failure,
          title: error instanceof InputReadTimeoutError ? "读取剪贴板超时" : "读取剪贴板失败",
          message: "可以手动输入，或按 ⌘⇧V 重试",
        });
      }
    } finally {
      if (isMounted.current) setIsLoadingClipboard(false);
    }
  };

  // Conversion is synchronous, so displayed results always belong to the current input and mode.
  const items = useMemo(
    () => convertBatch(searchText, settings.mode, { timeZone: settings.timeZone, outputUnit: settings.outputUnit }),
    [searchText, settings.mode, settings.timeZone, settings.outputUnit],
  );

  const handleSettingsChange = (patch: Partial<ConversionSettings>) => {
    setSavedSettings((previous) => ({ ...normalizeSettings(previous), ...patch }));
  };

  return (
    <FormatView
      items={items}
      searchText={searchText}
      onSearchTextChange={handleSearchTextChange}
      settings={settings}
      onSettingsChange={handleSettingsChange}
      onReadClipboard={handleReadClipboard}
      inputSource={inputSource}
      isLoading={isLoadingInitial || isLoadingClipboard}
    />
  );
}
