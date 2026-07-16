import { z } from "zod";

export const RiskModeSchema = z.enum(["auto_edit", "full_access"]);
export type RiskMode = z.infer<typeof RiskModeSchema>;

export const PlanApprovalSchema = z.enum(["on", "off"]);
export type PlanApproval = z.infer<typeof PlanApprovalSchema>;
