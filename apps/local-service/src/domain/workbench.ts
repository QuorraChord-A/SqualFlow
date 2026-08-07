import type { Store } from "../db/store.js";
import { listWorkRunReviews } from "./workRunReview.js";
import { currentPlanView } from "./orchestrationView.js";

function roleTitle(store: Store, expertId: string | null | undefined) {
  if (!expertId) return "专家";
  if (expertId === "exp-leader") return "Leader";
  const expert = store.getExpert(expertId);
  if (expert?.name) return expert.name;
  if (expertId.includes("coder")) return "全栈开发专家";
  if (expertId.includes("verify")) return "测试验证专家";
  if (expertId.includes("codereview")) return "代码审查专家";
  if (expertId.includes("research")) return "调研专家";
  return "专家";
}

function memberStatus(status: string) {
  return status === "streaming" || status === "in_progress" || status === "running"
    ? "running"
    : "idle";
}

export function buildFlowWorkbench(store: Store, flowId: string) {
  store.projectLegacyFlowExperts(flowId);
  const flow = store.getFlow(flowId);
  if (!flow) return null;

  const openWorkRun = store.getOpenWorkRun(flowId);
  const sessions = store.listAgentSessions(flowId);
  const artifacts = store.listArtifacts(flowId);
  const reviews = listWorkRunReviews(store, flowId);
  const latestReview = reviews.at(-1) ?? null;
  const project = flow.projectId ? store.getProject(flow.projectId) : null;

  const leaderSession = sessions.filter((session) =>
    session.expertId === "exp-leader" && session.taskId === null
  ).at(-1) ?? null;
  const flowExperts = store.listFlowExperts(flowId);
  const allTasks = store.listTasks(flowId);

  const team = [
    ...(leaderSession ? [{
      id: leaderSession.id,
      // Primary line: person/name; secondary: role title.
      display_name: "Leader",
      role: "Leader",
      status: memberStatus(leaderSession.status),
      current_task_title: null,
      last_active_at: leaderSession.updatedAt || leaderSession.createdAt,
      agent_session_id: null,
      flow_expert_id: null,
      expert_id: "exp-leader",
      is_leader: true,
    }] : []),
    ...flowExperts
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((flowExpert) => {
        const activeTask = allTasks.find((task) =>
          task.flowExpertId === flowExpert.id && task.status === "in_progress"
        );
        return {
          id: flowExpert.id,
          // UI: person name on top, fixed Chinese role title below.
          display_name: flowExpert.displayName || roleTitle(store, flowExpert.expertId),
          role: roleTitle(store, flowExpert.expertId),
          status: memberStatus(flowExpert.status),
          current_task_title: activeTask?.title ?? null,
          last_active_at: flowExpert.updatedAt || flowExpert.createdAt,
          agent_session_id: null,
          flow_expert_id: flowExpert.id,
          expert_id: flowExpert.expertId,
          is_leader: false,
        };
      }),
  ];

  const tasks = allTasks;
  return {
    orchestration_plan: currentPlanView(store, flowId),
    team,
    artifacts: {
      specs: store.listSpecRevisions(flowId).map((spec) => ({
        id: spec.id,
        spec_revision_id: spec.id,
        title: spec.fileName || spec.title,
        file_name: spec.fileName,
        overview: spec.overview,
        content: spec.content,
        status: spec.status,
        created_at: spec.createdAt,
      })),
      files: latestReview?.files.map((file) => ({
        path: file.path,
        status: file.status,
        ...(file.additions !== null ? { additions: file.additions } : {}),
        ...(file.deletions !== null ? { deletions: file.deletions } : {}),
      })) ?? [],
      reports: artifacts
        .filter((artifact) =>
          artifact.type.endsWith("_report")
          || artifact.type === "delivery_summary"
          || artifact.type === "execution_plan"
        )
        .map((artifact) => ({
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
          content: artifact.content,
          created_at: artifact.createdAt,
        })),
    },
    tasks: tasks.map((task) => {
      const flowExpert = task.flowExpertId ? store.getFlowExpert(task.flowExpertId) : null;
      const ownerSession = !flowExpert && task.agentSessionId ? store.getAgentSession(task.agentSessionId) : null;
      const ownerExpertId = flowExpert?.expertId ?? ownerSession?.expertId ?? task.expertId ?? null;
      return {
        id: task.id,
        work_run_id: task.workRunId,
        subject: task.title,
        status: task.status,
        owner_flow_expert_id: flowExpert?.id ?? null,
        owner_expert_id: ownerExpertId,
        owner_name: flowExpert?.displayName ?? ownerSession?.displayName ?? null,
        owner_role: ownerExpertId ? roleTitle(store, ownerExpertId) : null,
        active_form: task.activeForm,
        progress: task.progress,
        blocked_by: store.listTaskDependencies(task.id),
      };
    }),
    files: {
      root_path: openWorkRun?.workRootPath || project?.localPath || null,
      tree_available: Boolean(openWorkRun?.workRootPath || project?.localPath),
    },
    reviews,
  };
}
