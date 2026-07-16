import type { Store } from "../db/store.js";
import { planRevisionView } from "../domain/orchestrationView.js";
import type { EventBus } from "../ws/eventBus.js";
import type { AgentDispatcher } from "./agentDispatcher.js";

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export type OrchestrationScheduler = {
  startRevision: (revisionId: string) => Promise<ReturnType<Store["getPlanRunForRevision"]>>;
  advanceForTask: (taskId: string) => Promise<void>;
  recover: () => Promise<void>;
};

export function createOrchestrationScheduler(input: {
  store: Store;
  eventBus: EventBus;
  agentDispatcher: AgentDispatcher;
}): OrchestrationScheduler {
  const publishRun = async (run: NonNullable<ReturnType<Store["getPlanRun"]>>) => {
    await input.eventBus.publish(run.flowId, {
      type: "plan_run:event",
      flow_id: run.flowId,
      data: {
        plan_run_id: run.id,
        plan_revision_id: run.planRevisionId,
        user_turn_id: run.userTurnId,
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

  const dispatchReady = async (runId: string) => {
    const run = input.store.getPlanRun(runId);
    if (!run || !["running", "blocked"].includes(run.status)) return;
    const mappings = input.store.listPlanNodeTasks(run.id);
    const taskByNode = new Map(mappings.map((mapping) => [mapping.planNodeId, input.store.getTask(mapping.taskId)]));
    const revision = input.store.getPlanRevision(run.planRevisionId);
    const plan = revision ? input.store.getOrchestrationPlan(revision.planId) : undefined;
    if (!revision || !plan) return;
    const nodes = input.store.listPlanNodes(revision.id);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const runningResources = new Set<string>();
    const activeTaskStatuses = new Set(["in_progress", "queued_for_expert", "recovery_pending"]);
    for (const candidateRun of input.store.listPlanRuns(run.flowId).filter((candidate) => candidate.userTurnId === run.userTurnId)) {
      const candidateRevision = input.store.getPlanRevision(candidateRun.planRevisionId);
      if (!candidateRevision) continue;
      const candidateNodeById = new Map(input.store.listPlanNodes(candidateRevision.id).map((node) => [node.id, node]));
      for (const mapping of input.store.listPlanNodeTasks(candidateRun.id)) {
        const task = input.store.getTask(mapping.taskId);
        const node = candidateNodeById.get(mapping.planNodeId);
        if (task && activeTaskStatuses.has(task.status) && node) {
          parseStringArray(node.resourceKeysJson).forEach((key) => runningResources.add(key));
        }
      }
    }

    let dispatched = false;
    for (const mapping of mappings) {
      const currentRun = input.store.getPlanRun(run.id);
      if (!currentRun || !["running", "blocked"].includes(currentRun.status)) return;
      const task = input.store.getTask(mapping.taskId);
      const node = nodeById.get(mapping.planNodeId);
      if (!task || !node || task.status !== "pending") continue;
      const dependencies = input.store.listPlanNodeDependencies(revision.id, node.id);
      if (!dependencies.every((dependencyId) => taskByNode.get(dependencyId)?.status === "completed")) continue;
      const resources = parseStringArray(node.resourceKeysJson);
      if (resources.some((key) => runningResources.has(key))) continue;
      resources.forEach((key) => runningResources.add(key));
      const acceptance = parseStringArray(node.acceptanceCriteriaJson);
      const sideEffects = parseStringArray(node.sideEffectsJson);
      const result = await input.agentDispatcher.dispatchAgent({
        flowId: run.flowId,
        taskId: task.id,
        expertId: node.expertId,
        resumeAgentSessionId: "",
        prompt: [
          `整体目标：${revision.objective}`,
          `当前任务：${node.title}`,
          node.description,
          acceptance.length > 0 ? `验收标准：\n- ${acceptance.join("\n- ")}` : "",
          sideEffects.length > 0 ? `计划声明的副作用：${sideEffects.join("、")}` : "",
          resources.length > 0 ? `计划资源范围：${resources.join("、")}` : "",
          "只完成当前 Task 的范围；需要改变计划时停止并返回 Leader。",
        ].filter(Boolean).join("\n\n"),
      });
      if (!result.error) dispatched = true;
    }

    const tasks = mappings.map((mapping) => input.store.getTask(mapping.taskId)).filter(Boolean);
    const refreshedRun = input.store.getPlanRun(run.id);
    if (!refreshedRun) return;
    if (tasks.length > 0 && tasks.every((task) => task!.status === "completed")) {
      const completed = input.store.updatePlanRunStatus(run.id, "completed");
      if (completed) await publishRun(completed);
      return;
    }
    const hasFailed = tasks.some((task) => task!.status === "failed");
    const hasRunning = tasks.some((task) => ["in_progress", "queued_for_expert", "recovery_pending"].includes(task!.status));
    if (hasFailed && !hasRunning && !dispatched) {
      const blocked = input.store.updatePlanRunStatus(run.id, "blocked");
      if (blocked) await publishRun(blocked);
    } else if (refreshedRun.status === "blocked" && (hasRunning || dispatched)) {
      const running = input.store.updatePlanRunStatus(run.id, "running");
      if (running) await publishRun(running);
    }
  };

  return {
    async startRevision(revisionId) {
      const run = input.store.materializePlanRun(revisionId);
      if (!run) return input.store.getPlanRunForRevision(revisionId);
      await publishRun(run);
      await dispatchReady(run.id);
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
            if (input.store.listPlanNodeTasks(run.id).some((mapping) => mapping.taskId === taskId)) await dispatchReady(run.id);
          }
        }
      }
    },
    async recover() {
      for (const flow of input.store.listFlows()) {
        for (const run of input.store.listPlanRuns(flow.id).filter((candidate) => candidate.status === "running" || candidate.status === "blocked")) {
          await dispatchReady(run.id);
        }
      }
    },
  };
}
