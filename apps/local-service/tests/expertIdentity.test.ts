import { describe, expect, it } from "vitest";
import {
  parsePersonNameCandidates,
  pickPersonDisplayName,
} from "../src/domain/expertIdentity.js";

describe("expertIdentity", () => {
  it("parses person name candidates", () => {
    expect(parsePersonNameCandidates('["阿码","小栈"]')).toEqual(["阿码", "小栈"]);
    expect(parsePersonNameCandidates("not-json")).toEqual([]);
  });

  it("picks an unused candidate", () => {
    const name = pickPersonDisplayName({
      candidates: ["阿码", "小栈"],
      usedNames: ["阿码"],
      fallback: "全栈开发专家",
    });
    expect(name).toBe("小栈");
  });

  it("suffixes when all candidates are used", () => {
    const name = pickPersonDisplayName({
      candidates: ["阿码"],
      usedNames: ["阿码"],
      fallback: "全栈开发专家",
    });
    expect(name).toBe("阿码2");
  });
});
