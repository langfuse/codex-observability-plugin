import { TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import {
  EXTERNAL_PARENT_SPAN_ID_ENV_VAR,
  EXTERNAL_PARENT_TRACE_ID_ENV_VAR,
  EXTERNAL_TRACEPARENT_ENV_VAR,
  readExternalParentSpanContext,
} from "../src/parent-context.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

const expected = {
  traceId: TRACE_ID,
  spanId: SPAN_ID,
  traceFlags: TraceFlags.SAMPLED,
  isRemote: true,
};

describe("readExternalParentSpanContext", () => {
  it("parses a W3C traceparent", () => {
    expect(
      readExternalParentSpanContext(
        { [EXTERNAL_TRACEPARENT_ENV_VAR]: `00-${TRACE_ID}-${SPAN_ID}-01` },
        false,
      ),
    ).toEqual(expected);
  });

  it("ignores the parent's sampled bit and always records", () => {
    expect(
      readExternalParentSpanContext(
        { [EXTERNAL_TRACEPARENT_ENV_VAR]: `00-${TRACE_ID}-${SPAN_ID}-00` },
        false,
      ),
    ).toEqual(expected);
  });

  it.each([
    ["a trailing newline", `00-${TRACE_ID}-${SPAN_ID}-01\n`],
    ["surrounding whitespace", `  00-${TRACE_ID}-${SPAN_ID}-01  `],
    ["uppercase hex", `00-${TRACE_ID.toUpperCase()}-${SPAN_ID.toUpperCase()}-01`],
  ])("normalizes %s", (_label, value) => {
    expect(readExternalParentSpanContext({ [EXTERNAL_TRACEPARENT_ENV_VAR]: value }, false)).toEqual(
      expected,
    );
  });

  it.each(["", "   "])("treats a blank traceparent as unset (%j)", (value) => {
    const env = { [EXTERNAL_TRACEPARENT_ENV_VAR]: value };
    expect(readExternalParentSpanContext(env, false)).toBeUndefined();
    expect(readExternalParentSpanContext(env, true)).toBeUndefined();
  });

  it("does not read the unscoped TRACEPARENT variable", () => {
    expect(
      readExternalParentSpanContext({ TRACEPARENT: `00-${TRACE_ID}-${SPAN_ID}-01` }, false),
    ).toBeUndefined();
  });

  it.each([
    ["a malformed value", "not-a-traceparent"],
    ["an unsupported version", `01-${TRACE_ID}-${SPAN_ID}-01`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${SPAN_ID}-01`],
    ["an all-zero span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["a short trace id", `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`],
  ])("rejects %s", (_label, value) => {
    const env = { [EXTERNAL_TRACEPARENT_ENV_VAR]: value };
    expect(readExternalParentSpanContext(env, false)).toBeUndefined();
    expect(() => readExternalParentSpanContext(env, true)).toThrow(
      `${EXTERNAL_TRACEPARENT_ENV_VAR} must be a valid W3C traceparent value`,
    );
  });

  describe("explicit id pair", () => {
    it("accepts a valid trace id and span id", () => {
      expect(
        readExternalParentSpanContext(
          {
            [EXTERNAL_PARENT_TRACE_ID_ENV_VAR]: TRACE_ID,
            [EXTERNAL_PARENT_SPAN_ID_ENV_VAR]: SPAN_ID,
          },
          false,
        ),
      ).toEqual(expected);
    });

    it("normalizes case and whitespace", () => {
      expect(
        readExternalParentSpanContext(
          {
            [EXTERNAL_PARENT_TRACE_ID_ENV_VAR]: ` ${TRACE_ID.toUpperCase()}\n`,
            [EXTERNAL_PARENT_SPAN_ID_ENV_VAR]: `${SPAN_ID.toUpperCase()} `,
          },
          false,
        ),
      ).toEqual(expected);
    });

    it("loses to the traceparent when both are set", () => {
      const other = "1".repeat(32);
      expect(
        readExternalParentSpanContext(
          {
            [EXTERNAL_TRACEPARENT_ENV_VAR]: `00-${TRACE_ID}-${SPAN_ID}-01`,
            [EXTERNAL_PARENT_TRACE_ID_ENV_VAR]: other,
            [EXTERNAL_PARENT_SPAN_ID_ENV_VAR]: "2".repeat(16),
          },
          false,
        ),
      ).toEqual(expected);
    });

    it("returns undefined when neither is set", () => {
      expect(readExternalParentSpanContext({}, false)).toBeUndefined();
    });

    it.each([
      ["only the trace id", { [EXTERNAL_PARENT_TRACE_ID_ENV_VAR]: TRACE_ID }],
      ["only the span id", { [EXTERNAL_PARENT_SPAN_ID_ENV_VAR]: SPAN_ID }],
    ])("rejects %s", (_label, env) => {
      expect(readExternalParentSpanContext(env, false)).toBeUndefined();
      expect(() => readExternalParentSpanContext(env, true)).toThrow(
        `${EXTERNAL_PARENT_TRACE_ID_ENV_VAR} and ${EXTERNAL_PARENT_SPAN_ID_ENV_VAR} must both be set`,
      );
    });
  });
});
