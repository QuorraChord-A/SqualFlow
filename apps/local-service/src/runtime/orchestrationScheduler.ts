import type { Store } from "../db/store.js";
import { planRevisionView } from "../domain/orchestrationView.js";
import type { EventBus } from "../ws/eventBus.js";

// 编排执行账本（原自动调度器，2026-07 L2 决议后降级）：
// 派发权归 Leader（逐节点 dispatch_agent），本模块只负责
// 物化 plan run、按任务状态对账 run 状态并发布事件，不派发任何节点。
export type OrchestrationScheduler = {
  startRevision: (revisionId: string) => Promise<ReturnType<Store["getPlanRunForRevision"]>>;
  advanceForTask: (taskId: string) => Promise<void>;
  recover: () => Promise<void>;
};

export function createOrchestrationScheduler(input: {
  store: Store;
  eventBus: EventBus;
}): OrchestrationScheduler {
  const publishRun = async (run: NonNullable<ReturnType<Store["getPlanRun"]>>) => {
    await input.eventBus.publish(run.flowId, {
      type: "plan_run:event",
      flow_id: run.flowId,
      data: {
        plan_run_id: run.id,
        plan_revision_id: run.planRevisionId,
        work_run_id: run.workRunId,
        status: run.status,
      },
    });
  };

  const publishRevisionView = async (revisionId: string) => {
    const view = planRevisionView(input.store, revisionId);
    if (!view) return;
    await input.eventBus.publish(view.flow_id, {
      type: "plan:event",
      flow_id: view.flow_id,
      data: view,
    });
  };

  const reconcileRun = async (runId: string) => {
    const run = input.store.getPlanRun(runId);
    if (!run || !["running", "blocked"].includes(run.status)) return;
    const tasks = input.store.listPlanNodeTasks(run.id)
      .map((mapping) => input.store.getTask(mapping.taskId))
      .filter(Boolean);
    if (tasks.length === 0) return;
    if (tasks.every((task) => task!.status === "completed")) {
      const completed = input.store.updatePlanRunStatus(run.id, "completed");
      if (completed) await publishRun(completed);
      return;
    }
    const hasFailed = tasks.some((task) => task!.status === "failed");
    const hasBlocked = tasks.some((task) => task!.status === "blocked");
    const hasActive = tasks.some((task) => task!.status === "in_progress");
    if ((hasFailed || hasBlocked) && !hasActive && run.status !== "blocked") {
      const blocked = input.store.updatePlanRunStatus(run.id, "blocked");
      if (blocked) await publishRun(blocked);
    } else if (run.status === "blocked" && !hasFailed && !hasBlocked) {
      const running = input.store.updatePlanRunStatus(run.id, "running");
      if (running) await publishRun(running);
    }
  };

  return {
    async startRevision(revisionId) {
      const run = input.store.materializePlanRun(revisionId);
      if (!run) return input.store.getPlanRunForRevision(revisionId);
      await publishRun(run);
      const revision = input.store.getPlanRevision(revisionId);
      if (revision?.parentRevisionId) await publishRevisionView(revision.parentRevisionId);
      await publishRevisionView(revisionId);
      return input.store.getPlanRun(run.id);
    },
    async advanceForTask(taskId) {
      for (const plan of input.store.listOrchestrationPlans(input.store.getTask(taskId)?.flowId ?? "")) {
        for (const revision of input.store.listPlanRevisions(plan.id)) {
          const run = input.store.getPlanRunForRevision(revision.id);
          if (run?.status === "running" || run?.status === "blocked") {
            if (input.store.listPlanNodeTasks(run.id).some((mapping) => mapping.taskId === taskId)) await reconcileRun(run.id);
          }
        }
      }
    },
    async recover() {
      for (const flow of input.store.listFlows()) {
        for (const run of input.store.listPlanRuns(flow.id).filter((candidate) => candidate.status === "running" || candidate.status === "blocked")) {
          await reconcileRun(run.id);
        }
      }
    },
  };
}
