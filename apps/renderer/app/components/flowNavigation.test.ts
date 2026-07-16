import { describe, expect, it } from "vitest";
import { recordFlowNavigationVisit } from "./flowNavigation";

describe("recordFlowNavigationVisit", () => {
  it("keeps flow history deduped by moving revisited flows to the current position", () => {
    const afterFlow2 = recordFlowNavigationVisit({ entries: ["flow-1"], index: 0 }, "flow-2", "flow-1");
    const afterFlow1Again = recordFlowNavigationVisit(afterFlow2, "flow-1", "flow-2");

    expect(afterFlow1Again).toEqual({ entries: ["flow-2", "flow-1"], index: 1 });
    expect(afterFlow1Again.entries[afterFlow1Again.index - 1]).toBe("flow-2");
    expect(afterFlow1Again.entries[afterFlow1Again.index - 2]).toBeUndefined();
  });

  it("uses the selected flow as the first history entry when the user starts from restored state", () => {
    expect(recordFlowNavigationVisit({ entries: [], index: -1 }, "flow-2", "flow-1")).toEqual({
      entries: ["flow-1", "flow-2"],
      index: 1,
    });
  });
});
