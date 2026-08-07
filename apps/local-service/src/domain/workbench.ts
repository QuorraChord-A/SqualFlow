import type { Store } from "../db/store.js";
import { isActiveAgentRunStatus } from "./supervisor.js";
import { currentOrchestrationView } from "./orchestrationView.js";

function roleTitle(store: Store, agentDefinitionId: string) {
  return store.getAgentDefinition(agentDefinitionId)?.name ?? "专家";
}

export function buildFlowWorkbench(store: Store, flowId: string) {
  const flow = store.getFlow(flowId);
  if (!flow) return null;
  const project = flow.projectId ? store.getProject(flow.projectId) : null;
  const sessions = store.listAgentSessions(flowId);
  const runs = store.listAgentRuns(flowId);
  const tasks = store.listTasks(flowId);
  const changeSets = store.listChangeSets(flowId);

  return {
    orchestration_plan: currentOrchestrationView(store, flowId),
    team: sessions.map((session) => {
      const sessionRuns = runs.filter((run) => run.agentSessionId === session.id);
      const activeRun = sessionRuns.find((run) => isActiveAgentRunStatus(run.status)) ?? null;
      const activeTask = activeRun?.taskId ? store.getTask(activeRun.taskId) : null;
      return {
        id: session.id,
        display_name: session.displayName,
        role: roleTitle(store, session.agentDefinitionId),
        status: activeRun ? "running" : "idle",
        current_task_title: activeTask?.title ?? null,
        last_active_at: sessionRuns.at(-1)?.updatedAt ?? session.updatedAt,
        agent_run_id: activeRun?.id ?? null,
        agent_session_id: session.id,
        agent_definition_id: session.agentDefinitionId,
        is_leader: session.role === "leader",
      };
    }),
    tasks: tasks.map((task) => {
      const owner = task.agentSessionId ? store.getAgentSession(task.agentSessionId) : null;
      return {
        id: task.id,
        subject: task.title,
        description: task.description,
        status: task.status,
        revision: task.revision,
        owner_agent_session_id: owner?.id ?? null,
        recommended_agent_definition_id: task.recommendedAgentDefinitionId,
        owner_name: owner?.displayName ?? null,
        owner_role: owner ? roleTitle(store, owner.agentDefinitionId) : null,
        active_form: task.activeForm,
        progress: task.progress,
        blocked_by: store.listTaskDependencies(task.id),
        orchestration_revision_id: task.orchestrationRevisionId,
        orchestration_node_id: task.orchestrationNodeId,
      };
    }),
    artifacts: {
      plans: store.listPlanRevisions(flowId).map((revision) => ({
        plan_revision_id: revision.id,
        revision_number: revision.revisionNumber,
        title: revision.title,
        overview: revision.overview,
        content: revision.content,
        source_agent_run_id: revision.sourceAgentRunId,
        created_at: revision.createdAt,
      })),
      files: changeSets.flatMap((changeSet) => store.listChangeSetFiles(String(changeSet.id)).map((file) => ({
        change_set_id: changeSet.id,
        path: file.path,
        status: file.status,
        patch: file.patch,
        additions: file.additions,
        deletions: file.deletions,
        attribution_kind: file.attributionKind,
      }))),
      reports: store.listArtifacts(flowId).filter((artifact) => {
        const type = String(artifact.type ?? "");
        return type.endsWith("_report") || type === "delivery_summary" || type === "execution_plan";
      }).map((artifact) => ({
        artifact_id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        content: artifact.content,
        source_agent_run_id: artifact.sourceAgentRunId,
        created_at: artifact.createdAt,
      })),
      change_sets: changeSets.map((changeSet) => ({
        change_set_id: changeSet.id,
        title: changeSet.title,
        status: changeSet.status,
        root_path: changeSet.rootPath,
        baseline_kind: changeSet.baselineKind,
        baseline_ref: changeSet.baselineRef,
        partial_reason: changeSet.partialReason,
        review: changeSet.reviewJson ? JSON.parse(String(changeSet.reviewJson)) : null,
        created_at: changeSet.createdAt,
        finalized_at: changeSet.finalizedAt,
        abandoned_at: changeSet.abandonedAt,
        updated_at: changeSet.updatedAt,
        files: store.listChangeSetFiles(String(changeSet.id)).map((file) => ({
          path: file.path,
          status: file.status,
          patch: file.patch,
          additions: file.additions,
          deletions: file.deletions,
          attribution_kind: file.attributionKind,
        })),
      })),
    },
    files: {
      root_path: project?.localPath ?? null,
      tree_available: Boolean(project?.localPath),
    },
  };
}
