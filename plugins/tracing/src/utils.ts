/** Read and JSON-parse the hook payload Codex writes to stdin. */
export function readStdin<T>(): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (buffer += chunk));
    process.stdin.on("end", () => {
      const trimmed = buffer.trim();
      if (!trimmed) {
        reject(new Error("empty hook stdin"));
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as T);
      } catch (error) {
        reject(
          new Error(
            `failed to parse hook stdin: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
    process.stdin.once("error", reject);
  });
}

export function isPrimitive(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

/** Stringify a value for display, leaving strings untouched. */
export function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (isPrimitive(value)) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let debugEnabled = false;
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}
export function debugLog(...args: unknown[]): void {
  if (!debugEnabled) return;
  console.error("[langfuse-codex]", ...args);
}
