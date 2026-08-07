import { beforeEach, expect, it } from "vitest";
import { useOrchestrationFeedbackStore } from "./useOrchestrationFeedbackStore";

beforeEach(() => useOrchestrationFeedbackStore.setState({ activeFlowId: null, drafts: [], draftsByFlow: {} }));

it("同一计划目标只保留一条评论并按 Flow 隔离", () => {
  const store = useOrchestrationFeedbackStore.getState();
  store.setActiveFlowId("flow-1");
  store.upsertDraft({ flowId: "flow-1", orchestrationRevisionId: "revision-1", orchestrationNodeId: "node-1", targetLabel: "任务", comment: "第一次" });
  useOrchestrationFeedbackStore.getState().upsertDraft({ flowId: "flow-1", orchestrationRevisionId: "revision-1", orchestrationNodeId: "node-1", targetLabel: "任务", comment: "更新后" });
  expect(useOrchestrationFeedbackStore.getState().drafts).toHaveLength(1);
  expect(useOrchestrationFeedbackStore.getState().drafts[0]?.comment).toBe("更新后");
  useOrchestrationFeedbackStore.getState().setActiveFlowId("flow-2");
  expect(useOrchestrationFeedbackStore.getState().drafts).toEqual([]);
  useOrchestrationFeedbackStore.getState().setActiveFlowId("flow-1");
  expect(useOrchestrationFeedbackStore.getState().drafts[0]?.comment).toBe("更新后");
});
