"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "../lib/api";
import { wsClient } from "../lib/ws";
import type { OrchestrationPlanView } from "../types/orchestration";

export type ChangeSetFile = {
  path: string;
  status: "modified" | "added" | "deleted" | string;
  patch: string | null;
  additions: number | null;
  deletions: number | null;
  attribution_kind: string;
};

export type ChangeSetView = {
  change_set_id: string;
  title: string;
  status: "open" | "finalized" | "abandoned";
  root_path: string;
  baseline_kind: string;
  baseline_ref: string | null;
  partial_reason: string | null;
  review: Record<string, unknown> | null;
  created_at: string;
  finalized_at: string | null;
  abandoned_at: string | null;
  updated_at: string;
  files: ChangeSetFile[];
};

export interface FlowWorkbench {
  orchestration_plan: OrchestrationPlanView | null;
  team: Array<{
    id: string;
    display_name: string;
    role: string;
    status: "running" | "idle";
    current_task_title: string | null;
    last_active_at: string | null;
    agent_run_id: string | null;
    agent_session_id: string;
    agent_definition_id: string;
    is_leader: boolean;
  }>;
  artifacts: {
    plans: Array<{
      plan_revision_id: string;
      revision_number: number;
      title: string;
      overview: string;
      content: string;
      source_agent_run_id: string;
      created_at: string;
    }>;
    files: Array<ChangeSetFile & { change_set_id: string }>;
    reports: Array<{
      artifact_id: string;
      type: string;
      title: string;
      content: string;
      source_agent_run_id: string;
      created_at: string;
    }>;
    change_sets: ChangeSetView[];
  };
  tasks: Array<{
    id: string;
    subject: string;
    description: string;
    status: string;
    revision: number;
    owner_agent_session_id: string | null;
    recommended_agent_definition_id: string | null;
    owner_name: string | null;
    owner_role: string | null;
    active_form: string | null;
    progress: string | null;
    blocked_by: string[];
    orchestration_revision_id: string | null;
    orchestration_node_id: string | null;
  }>;
  files: { root_path: string | null; tree_available: boolean };
}

export type WorkbenchTeamMember = FlowWorkbench["team"][number];

export const emptyWorkbench: FlowWorkbench = {
  orchestration_plan: null,
  team: [],
  artifacts: { plans: [], files: [], reports: [], change_sets: [] },
  tasks: [],
  files: { root_path: null, tree_available: false },
};

export function hasWorkbenchContent(workbench: FlowWorkbench) {
  return Boolean(workbench.orchestration_plan)
    || workbench.tasks.length > 0
    || workbench.artifacts.plans.length > 0
    || workbench.artifacts.files.length > 0
    || workbench.artifacts.reports.length > 0
    || workbench.artifacts.change_sets.length > 0;
}

export function useFlowWorkbench(flowId: string | null) {
  const [workbench, setWorkbench] = useState<FlowWorkbench>(emptyWorkbench);
  useEffect(() => {
    setWorkbench(emptyWorkbench);
    if (!flowId) return;
    let stale = false;
    let loading: Promise<void> | null = null;
    const load = () => {
      if (loading) return loading;
      loading = fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}/workbench`)
        .then(async (response) => { if (response.ok && !stale) setWorkbench(await response.json() as FlowWorkbench); })
        .catch(() => undefined)
        .finally(() => { loading = null; });
      return loading;
    };
    void load();
    const reload = (message: { flow_id?: string }) => { if (message.flow_id === flowId) void load(); };
    const unsubs = [
      "flow:state", "agent_run:event", "agent_session:event", "task:event", "artifact:event",
      "plan:event", "orchestration:event", "orchestration_approval:event", "change_set:event",
    ].map((event) => wsClient.onEvent(event, reload));
    return () => { stale = true; unsubs.forEach((unsubscribe) => unsubscribe()); };
  }, [flowId]);
  return { workbench, hasContent: hasWorkbenchContent(workbench) };
}
