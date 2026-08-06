import type { EventBus } from "../ws/eventBus.js";
import type { OperationalLogger } from "../observability/operationalLogger.js";
import type { RuntimeDiagnosticEvent } from "./adapters/runtimeAdapter.js";

export type RuntimeDiagnosticContext = {
  runtimeRole: "leader" | "leader_compaction" | "expert";
  flowId: string;
  workRunId: string | null;
  agentSessionId: string;
  taskId?: string;
  flowExpertId?: string;
};

export function reportRuntimeDiagnostic(input: {
  logger?: OperationalLogger;
  eventBus: EventBus;
  context: RuntimeDiagnosticContext;
  event: RuntimeDiagnosticEvent;
}) {
  const { logger, eventBus, context, event } = input;
  const fields = { ...context, ...event };
  if (event.type === "foreign_thread_notification") {
    logger?.warn(fields, "runtime received notification for a different SDK session");
  } else {
    logger?.info(fields, "runtime provider diagnostic");
  }

  if (event.type !== "provider_connection_status" || context.runtimeRole === "leader_compaction") return;
  void eventBus.publish(context.flowId, {
    type: "runtime:transport",
    flow_id: context.flowId,
    agent_session_id: context.agentSessionId,
    ...(context.flowExpertId ? { flow_expert_id: context.flowExpertId } : {}),
    data: {
      state: event.state,
      ...(event.message ? { message: event.message } : {}),
      ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
      ...(event.maxAttempts !== undefined ? { max_attempts: event.maxAttempts } : {}),
      runtime_role: context.runtimeRole,
      ...(context.workRunId ? { work_run_id: context.workRunId } : {}),
      ...(context.taskId ? { task_id: context.taskId } : {}),
    },
  }).catch((error) => {
    logger?.warn({
      ...context,
      error: error instanceof Error ? error.message : String(error),
    }, "failed to publish runtime transport status");
  });
}
