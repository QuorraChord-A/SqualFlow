import { describe, expect, it } from "vitest";
import {
  applyComposerMode,
  assertAgentRunTransition,
  assertTaskTransition,
  assertToolCallTransition,
  canTransitionAgentRun,
  canTransitionTask,
  canTransitionToolCall,
  deriveFlowIndicator,
  exitPlanModeAfterApproval,
  selectComposerMode,
} from "../src/domain/supervisor.js";

describe("Supervisor domain contract", () => {
  it("keeps terminal AgentRuns immutable", () => {
    expect(canTransitionAgentRun("completed", "running")).toBe(false);
    expect(canTransitionAgentRun("cancelled", "queued")).toBe(false);
    expect(() => assertAgentRunTransition("failed", "running")).toThrow(
      "INVALID_AGENT_RUN_TRANSITION:failed->running",
    );
  });

  it("resumes the same run only for tool approval", () => {
    expect(canTransitionAgentRun("running", "waiting_tool_approval")).toBe(true);
    expect(canTransitionAgentRun("waiting_tool_approval", "running")).toBe(true);
  });

  it("keeps Task business status explicit and terminal", () => {
    expect(canTransitionTask("pending", "completed")).toBe(true);
    expect(canTransitionTask("blocked", "in_progress")).toBe(true);
    expect(canTransitionTask("completed", "in_progress")).toBe(false);
    expect(() => assertTaskTransition("cancelled", "pending")).toThrow(
      "INVALID_TASK_TRANSITION:cancelled->pending",
    );
  });

  it("keeps ToolCall state transitions independent from AgentRun state", () => {
    expect(canTransitionToolCall("started", "waiting_approval")).toBe(true);
    expect(canTransitionToolCall("waiting_approval", "running")).toBe(true);
    expect(canTransitionToolCall("completed", "running")).toBe(false);
    expect(() => assertToolCallTransition("failed", "completed")).toThrow(
      "INVALID_TOOL_CALL_TRANSITION:failed->completed",
    );
  });

  it("derives the sidebar indicator with pending > running > unread priority", () => {
    expect(deriveFlowIndicator({
      hasPendingUserAction: true,
      hasActiveAgentRun: true,
      hasUnreadOutput: true,
    })).toBe("pending_user_action");
    expect(deriveFlowIndicator({
      hasPendingUserAction: false,
      hasActiveAgentRun: true,
      hasUnreadOutput: true,
    })).toBe("running");
    expect(deriveFlowIndicator({
      hasPendingUserAction: false,
      hasActiveAgentRun: false,
      hasUnreadOutput: true,
    })).toBe("unread");
  });

  it("keeps Plan behavior separate from execution risk", () => {
    const plan = applyComposerMode({ behaviorMode: "execute", riskMode: "full_access" }, "plan");
    expect(plan).toEqual({ behaviorMode: "plan", riskMode: "full_access" });
    expect(selectComposerMode(plan)).toBe("plan");
    expect(exitPlanModeAfterApproval(plan)).toEqual({ behaviorMode: "execute", riskMode: "full_access" });
  });

  it("does not override an explicit mode change made before approval", () => {
    const changed = applyComposerMode({ behaviorMode: "plan", riskMode: "auto_edit" }, "full_access");
    expect(exitPlanModeAfterApproval(changed)).toEqual({ behaviorMode: "execute", riskMode: "full_access" });
  });
});
