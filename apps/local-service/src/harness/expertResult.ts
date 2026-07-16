export type TurnOutcome = "completed" | "errored" | "interrupted";

export type ExpertResult = {
  turn_outcome: TurnOutcome;
  summary: string;
  files_changed: string[];
  metrics: Record<string, unknown>;
  error: string | null;
};

export function assembleExpertResult(input: {
  finalAssistantText: string | null;
  turnOutcome: TurnOutcome;
  errorMessage?: string | null;
  filesChanged?: string[];
  metrics?: Record<string, unknown>;
}): ExpertResult {
  const text = input.finalAssistantText?.trim() || "";
  const errorMessage = input.errorMessage?.trim() || "";
  const summary = text || errorMessage || (input.turnOutcome === "completed" ? "Expert turn completed without a final message; review the session transcript before judging completion." : "Expert turn ended without a final message");
  return {
    turn_outcome: input.turnOutcome,
    summary,
    files_changed: input.filesChanged ?? [],
    metrics: input.metrics ?? {},
    error: input.turnOutcome === "completed" ? null : (errorMessage || null),
  };
}
