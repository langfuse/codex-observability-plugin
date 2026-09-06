import { describe, expect, it } from "vitest";

import {
  EXTERNAL_TRACEPARENT_ENV_VAR,
  readExternalParentSpanContext,
} from "../src/parent-context.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

describe("readExternalParentSpanContext", () => {
  it.each([0, 1])("parses a remote context with sampled flag %s", (traceFlags) => {
    expect(
      readExternalParentSpanContext(
        { [EXTERNAL_TRACEPARENT_ENV_VAR]: `00-${TRACE_ID}-${SPAN_ID}-0${traceFlags}` },
        false,
      ),
    ).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags,
      isRemote: true,
    });
  });

  it("does not read the unscoped TRACEPARENT variable", () => {
    expect(
      readExternalParentSpanContext({ TRACEPARENT: `00-${TRACE_ID}-${SPAN_ID}-01` }, false),
    ).toBeUndefined();
  });

  it("ignores an invalid value unless fail-on-error is enabled", () => {
    const env = { [EXTERNAL_TRACEPARENT_ENV_VAR]: "not-a-traceparent" };

    expect(readExternalParentSpanContext(env, false)).toBeUndefined();
    expect(() => readExternalParentSpanContext(env, true)).toThrow(
      `${EXTERNAL_TRACEPARENT_ENV_VAR} must be a valid W3C traceparent value`,
    );
  });
});
