import { describe, expect, it } from "vitest";
import { errorDiagnostic } from "../src/observability/operationalLogger.js";

describe("operational diagnostics", () => {
  it("fingerprints error messages without copying their text", () => {
    const diagnostic = errorDiagnostic(Object.assign(
      new Error("provider response included sensitive user content"),
      { code: "PROVIDER_FAILED" },
    ));

    expect(diagnostic).toMatchObject({
      errorName: "Error",
      errorCode: "PROVIDER_FAILED",
      errorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(diagnostic)).not.toContain("sensitive user content");
  });
});
