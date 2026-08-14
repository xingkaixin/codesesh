import { describe, expect, it } from "vitest";
import { evaluateLoopbackWriteRequest } from "./loopback-write-guard.js";

const REQUEST_ORIGIN = "http://localhost:4521";

function evaluate(request: Partial<Parameters<typeof evaluateLoopbackWriteRequest>[0]> = {}) {
  return evaluateLoopbackWriteRequest({
    method: "POST",
    contentType: "application/json",
    requestOrigin: REQUEST_ORIGIN,
    ...request,
  });
}

describe("evaluateLoopbackWriteRequest", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("rejects cross-origin safe %s requests", (method) => {
    expect(
      evaluate({
        method,
        contentType: "text/plain",
        fetchSite: "cross-site",
        origin: "https://attacker.example",
      }),
    ).toEqual({ allowed: false, reason: "fetch-site", status: 403 });
  });

  it.each(["GET", "HEAD", "OPTIONS"])("allows metadata-free safe %s requests", (method) => {
    expect(evaluate({ method, contentType: "text/plain" })).toEqual({ allowed: true });
  });

  it.each(["application/json", "Application/JSON; charset=UTF-8"])(
    "accepts the JSON media type %s",
    (contentType) => {
      expect(evaluate({ contentType })).toEqual({ allowed: true });
    },
  );

  it.each([undefined, "", "text/plain", "application/x-www-form-urlencoded"])(
    "rejects the non-JSON media type %j",
    (contentType) => {
      expect(evaluate({ contentType })).toEqual({
        allowed: false,
        reason: "content-type",
        status: 415,
      });
    },
  );

  it.each(["same-origin", "none"])("allows Sec-Fetch-Site: %s", (fetchSite) => {
    expect(evaluate({ fetchSite })).toEqual({ allowed: true });
  });

  it.each(["same-site", "cross-site", "invalid"])("rejects Sec-Fetch-Site: %s", (fetchSite) => {
    expect(evaluate({ fetchSite })).toEqual({
      allowed: false,
      reason: "fetch-site",
      status: 403,
    });
  });

  it("requires a supplied Origin to match the request", () => {
    expect(evaluate({ origin: REQUEST_ORIGIN })).toEqual({ allowed: true });
    expect(evaluate({ origin: "https://attacker.example" })).toEqual({
      allowed: false,
      reason: "origin",
      status: 403,
    });
    expect(evaluate({ origin: "null" })).toEqual({
      allowed: false,
      reason: "origin",
      status: 403,
    });
  });

  it("allows non-browser clients that omit fetch metadata and Origin", () => {
    expect(evaluate()).toEqual({ allowed: true });
  });

  it("does not require a media type for a bodyless DELETE", () => {
    expect(evaluate({ method: "DELETE", contentType: undefined })).toEqual({ allowed: true });
    expect(evaluate({ method: "DELETE", contentType: undefined, fetchSite: "cross-site" })).toEqual(
      { allowed: false, reason: "fetch-site", status: 403 },
    );
  });
});
