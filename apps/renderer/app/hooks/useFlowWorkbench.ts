"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "../lib/api";
import { wsClient } from "../lib/ws";
import type { OrchestrationPlanView } from "../types/orchestration";

export interface FlowWorkbench {
  orchestration_plan?: OrchestrationPlanView | null;
  team: Array<{
    id: string;
    display_name: string;
    role: string;
    status: "running" | "idle";
    current_task_title: string | null;
    last_active_at: string | null;
    agent_session_id: string | null;
    flow_expert_id: string | null;
    expert_id: string | null;
    is_leader: boolean;
  }>;
  artifacts: {
    specs: Array<{
      id: string;
      spec_revision_id: string;
      title: string;
      file_name: string;
      overview: string;
      content: string;
      status: string;
      created_at: string;
    }>;
    files: Array<{
      path: string;
      status?: string;
      additions?: number;
      deletions?: number;
      source_artifact_id?: string;
    }>;
    reports: Array<{
      id: string;
      type: string;
      title: string;
      content: string;
      created_at: string;
    }>;
  };
  tasks: Array<{
    id: string;
    user_turn_id: string;
    subject: string;
    status: string;
    owner_flow_expert_id: string | null;
    owner_expert_id: string | null;
    owner_name: string | null;
    owner_role: string | null;
    active_form: string | null;
    progress: string | null;
    blocked_by: string[];
  }>;
  files: {
    root_path: string | null;
    tree_available: boolean;
  };
  review: UserTurnReview | null;
}

export type WorkbenchTeamMember = FlowWorkbench["team"][number];

export type UserTurnReviewLine = {
  kind: "context" | "added" | "removed";
  old_line: number | null;
  new_line: number | null;
  text: string;
};

export type UserTurnReviewFile = {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  lines: UserTurnReviewLine[];
};

export type UserTurnReview = {
  flow_id: string;
  user_turn_id: string;
  completed_at: string | null;
  totals: {
    files: number;
    additions: number;
    deletions: number;
    modified: number;
    added: number;
    deleted: number;
  };
  files: UserTurnReviewFile[];
};

export const emptyWorkbench: FlowWorkbench = {
  orchestration_plan: null,
  team: [],
  artifacts: { specs: [], files: [], reports: [] },
  tasks: [],
  files: { root_path: null, tree_available: false },
  review: null,
};

export function hasWorkbenchContent(workbench: FlowWorkbench) {
  return Boolean(workbench.orchestration_plan)
    || workbench.tasks.length > 0
    || workbench.artifacts.specs.length > 0
    || workbench.artifacts.files.length > 0
    || workbench.artifacts.reports.length > 0
    || Boolean(workbench.review);
}

export function useFlowWorkbench(flowId: string | null) {
  const [workbench, setWorkbench] = useState<FlowWorkbench>(emptyWorkbench);

  useEffect(() => {
    setWorkbench(emptyWorkbench);
    if (!flowId) return;

    let stale = false;
    let loadPromise: Promise<void> | null = null;
    const load = () => {
      if (loadPromise) return loadPromise;
      loadPromise = (async () => {
        try {
          const response = await fetch(`${API_BASE}/api/flows/${flowId}/workbench`);
          if (!response.ok) return;
          const data = await response.json() as FlowWorkbench;
          if (!stale) setWorkbench(data);
        } catch {
          // WebSocket reconnects and later events will retry the snapshot.
        }
      })().finally(() => {
        loadPromise = null;
      });
      return loadPromise;
    };

    void load();
    const reloadForFlow = (message: { flow_id?: string }) => {
      if (message.flow_id === flowId) void load();
    };
    const unsubs = [
      wsClient.onEvent("flow:state", reloadForFlow),
      wsClient.onEvent("user_turn:event", reloadForFlow),
      wsClient.onEvent("task:event", reloadForFlow),
      wsClient.onEvent("session:event", reloadForFlow),
      wsClient.onEvent("flow_expert:event", reloadForFlow),
      wsClient.onEvent("artifact:event", reloadForFlow),
      wsClient.onEvent("plan:event", reloadForFlow),
      wsClient.onEvent("plan_approval:event", reloadForFlow),
      wsClient.onEvent("plan_run:event", reloadForFlow),
    ];

    return () => {
      stale = true;
      for (const unsub of unsubs) unsub();
    };
  }, [flowId]);

  return { workbench, hasContent: hasWorkbenchContent(workbench) };
}
