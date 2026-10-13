export type InputSource = "selection" | "clipboard" | "manual";

export class InputReadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Input read timed out after ${timeoutMs}ms`);
    this.name = "InputReadTimeoutError";
  }
}

export function withReadTimeout<T>(read: () => Promise<T>, timeoutMs = 1500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new InputReadTimeoutError(timeoutMs));
    }, timeoutMs);

    // Attach both handlers immediately so a read that settles after its timeout
    // cannot produce an unhandled rejection.
    Promise.resolve()
      .then(read)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/** Raycast's search field is single-line, so preserve batch boundaries with commas. */
export function prepareSearchText(text: string): string {
  return text.replace(/[\r\n\t]+/g, ", ");
}

interface InitialInputOptions {
  readSelection: () => Promise<string>;
  readClipboard: () => Promise<string | undefined>;
  isCurrent: () => boolean;
  onInput: (text: string, source: InputSource) => void;
  timeoutMs?: number;
}

/** Read both sources once, preferring selection without waiting for the clipboard. */
export async function initializeInput({
  readSelection,
  readClipboard,
  isCurrent,
  onInput,
  timeoutMs = 1500,
}: InitialInputOptions) {
  const selectionRead = withReadTimeout(readSelection, timeoutMs).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  const clipboardRead = withReadTimeout(readClipboard, timeoutMs).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );

  const selection = await selectionRead;
  if (!isCurrent()) return;

  if (selection.status === "fulfilled" && selection.value.trim()) {
    onInput(selection.value, "selection");
    return;
  }

  const clipboard = await clipboardRead;
  if (!isCurrent()) return;
  if (clipboard.status === "rejected") throw clipboard.reason;
  if (clipboard.value?.trim()) onInput(clipboard.value, "clipboard");
}
