import { beforeEach, expect, it } from "vitest";
import { usePlanFeedbackStore } from "./usePlanFeedbackStore";

beforeEach(() => usePlanFeedbackStore.setState({ activeFlowId: null, drafts: [], draftsByFlow: {} }));

it("同一计划目标只保留一条评论并按 Flow 隔离", () => {
  const store = usePlanFeedbackStore.getState();
  store.setActiveFlowId("flow-1");
  store.upsertDraft({ flowId: "flow-1", planRevisionId: "revision-1", planNodeId: "node-1", targetLabel: "任务", comment: "第一次" });
  usePlanFeedbackStore.getState().upsertDraft({ flowId: "flow-1", planRevisionId: "revision-1", planNodeId: "node-1", targetLabel: "任务", comment: "更新后" });
  expect(usePlanFeedbackStore.getState().drafts).toHaveLength(1);
  expect(usePlanFeedbackStore.getState().drafts[0]?.comment).toBe("更新后");
  usePlanFeedbackStore.getState().setActiveFlowId("flow-2");
  expect(usePlanFeedbackStore.getState().drafts).toEqual([]);
  usePlanFeedbackStore.getState().setActiveFlowId("flow-1");
  expect(usePlanFeedbackStore.getState().drafts[0]?.comment).toBe("更新后");
});
