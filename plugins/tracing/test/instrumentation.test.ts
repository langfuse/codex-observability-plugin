import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("setupInstrumentation", () => {
  it("wires @langfuse/tracing to the registered NodeTracerProvider", () => {
    const source = fs.readFileSync(new URL("../src/instrumentation.ts", import.meta.url), "utf-8");

    expect(source).toContain("setLangfuseTracerProvider(provider)");
  });
});
