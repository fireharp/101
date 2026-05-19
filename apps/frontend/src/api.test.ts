import test from "node:test";
import assert from "node:assert/strict";

// api.ts only imports types and uses fetch(), so it's safe to load under
// node:test without a DOM. This is the only frontend module covered today;
// the rest of the UI is exercised end-to-end by `pnpm smoke:browser`.
const { ApiError, isApiError } = await import("./api.js");

test("isApiError narrows to ApiError instances only", () => {
  const e = new ApiError({
    message: "boom",
    status: 500,
    statusText: "Internal",
    path: "/api/x",
    payload: null,
    requestId: null,
  });
  assert.equal(isApiError(e), true);
  assert.equal(isApiError(new Error("ordinary")), false);
  assert.equal(isApiError("string"), false);
  assert.equal(isApiError(null), false);
  assert.equal(isApiError(undefined), false);
  assert.equal(isApiError({ name: "ApiError" }), false);
});

test("ApiError extracts the OpenAI metadata into top-level fields", () => {
  const e = new ApiError({
    message: "503 upstream rate limited",
    status: 503,
    statusText: "Service Unavailable",
    path: "/api/realtime/token",
    payload: {
      error: "upstream rate limited",
      openai_request_id: "req_abc123",
      openai_status: 429,
      retryable: true,
      retry_after: "30",
    },
    requestId: "rid_local",
  });
  assert.equal(e.status, 503);
  assert.equal(e.openaiRequestId, "req_abc123");
  assert.equal(e.openaiStatus, 429);
  assert.equal(e.retryable, true);
  assert.equal(e.requestId, "rid_local");
  // Source object remains intact for callers that need the raw payload.
  assert.equal(e.payload?.retry_after, "30");
});

test("ApiError requestId falls back through opts.requestId → payload.request_id → null", () => {
  // 1. opts.requestId wins.
  const e1 = new ApiError({
    message: "x",
    status: 400,
    statusText: "Bad Request",
    path: "/api/x",
    payload: { request_id: "from_payload" },
    requestId: "from_header",
  });
  assert.equal(e1.requestId, "from_header");

  // 2. payload.request_id is the fallback when header is absent.
  const e2 = new ApiError({
    message: "x",
    status: 400,
    statusText: "Bad Request",
    path: "/api/x",
    payload: { request_id: "from_payload" },
    requestId: null,
  });
  assert.equal(e2.requestId, "from_payload");

  // 3. null when neither is set.
  const e3 = new ApiError({
    message: "x",
    status: 400,
    statusText: "Bad Request",
    path: "/api/x",
    payload: null,
    requestId: null,
  });
  assert.equal(e3.requestId, null);
  assert.equal(e3.openaiRequestId, null);
  assert.equal(e3.retryable, false);
});
