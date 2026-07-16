import type { StageType } from '../types';

export const LEGACY_STAGE_MAP: Record<string, StageType> = {
  briefing: 'clarify',
  architecture: 'architecture',
  tasking: 'develop',
};

export function mapLegacyStage(stage: string | null | undefined): StageType | null {
  if (!stage) return null;
  return LEGACY_STAGE_MAP[stage] || (stage as StageType);
}
