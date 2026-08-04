'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  API_BASE,
  fetchAgentRuntimeConfig,
  updateFlowLeaderRuntimeSelection,
  type AgentRuntimeConfigDto,
  type RuntimeModelDto,
} from '../lib/api';
import { AGENT_META, AGENT_ORDER, AgentIcon, runtimeSdkLabel } from '../lib/agentMeta';
import { useFlowStore } from '../stores/useFlowStore';

interface LeaderModelSelectorProps {
  flowId?: string | null;
  defaultSelection?: boolean;
  selection?: { configId: string | null; modelId: string | null } | null;
  onSelectionChange?: (selection: { configId: string; modelId: string }) => void;
  selectionReasoningEffort?: string | null;
  onSelectionReasoningEffortChange?: (effort: string | null) => void;
  className?: string;
  onOpenModelSettings?: () => void;
  onConfiguredChange?: (configured: boolean) => void;
  onUpdatingChange?: (updating: boolean) => void;
  reasoningEffortDisabled?: boolean;
}

const OFFICIAL_REASONING_EFFORT_LABELS: Record<string, string> = {
  low: '轻度',
  medium: '中',
  high: '高级',
  xhigh: '超高',
  max: '最高',
  ultra: '极高',
};

const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function runtimeConfigLabel(config: AgentRuntimeConfigDto | null | undefined) {
  return config?.name?.trim() || config?.fileName || '未配置';
}

function reasoningEffortOptionsForConfig(config: AgentRuntimeConfigDto | null | undefined) {
  if (config?.sdk === 'claudecode') {
    return CLAUDE_REASONING_EFFORTS.map((value) => ({ value, label: value }));
  }
  const values = config?.sdk === 'codex' && config.authMode === 'inherited'
    ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    : [];
  return values.map((value) => ({ value, label: OFFICIAL_REASONING_EFFORT_LABELS[value] ?? value }));
}

function defaultReasoningEffortForConfig(
  config: AgentRuntimeConfigDto | null | undefined,
) {
  const options = reasoningEffortOptionsForConfig(config);
  const fallback = config?.sdk === 'claudecode'
    ? 'high'
    : config?.sdk === 'codex' && config.authMode === 'inherited'
      ? 'medium'
      : '';
  return options.some((option) => option.value === fallback) ? fallback : '';
}

function normalizeReasoningEffortForConfig(
  config: AgentRuntimeConfigDto | null | undefined,
  _model: RuntimeModelDto | null | undefined,
  value: string | null | undefined,
) {
  const options = reasoningEffortOptionsForConfig(config);
  if (options.length === 0) return '';
  return options.some((option) => option.value === value) ? value! : defaultReasoningEffortForConfig(config);
}

function officialReasoningEffortLabel(value: string | null | undefined) {
  return value ? OFFICIAL_REASONING_EFFORT_LABELS[value] ?? value : '';
}

function officialCodexModelLabel(value: string) {
  const match = /^gpt-(\d+\.\d+)-([a-z]+)$/iu.exec(value.trim());
  if (!match) return value;
  return `${match[1]} ${match[2][0].toUpperCase()}${match[2].slice(1)}`;
}

function officialEffortCssPosition(progress: number) {
  const clampedProgress = Math.min(Math.max(progress, 0), 100);
  const pixelOffset = 16 - clampedProgress * 0.32;
  const operator = pixelOffset < 0 ? '-' : '+';
  return `calc(${clampedProgress}% ${operator} ${Math.abs(pixelOffset)}px)`;
}

// Cool -> warm spectrum for reasoning effort: faster/lighter reasoning reads cool,
// slower/deeper reasoning reads warm.
const EFFORT_COLOR_VARS = ['var(--ui-effort-low)', 'var(--ui-effort-medium)', 'var(--ui-effort-high)', 'var(--ui-effort-xhigh)'];
const OFFICIAL_CODEX_EFFORT_GRADIENT = 'linear-gradient(90deg, var(--ui-codex-effort-start) 0%, var(--ui-codex-effort-middle) 58%, var(--ui-codex-effort-end) 100%)';
const OFFICIAL_CODEX_EFFORT_PARTICLES = [
  { left: 8, top: 30, size: 2, delay: -0.4, duration: 2.4 },
  { left: 15, top: 62, size: 1.5, delay: -1.7, duration: 2.8 },
  { left: 24, top: 43, size: 2.5, delay: -0.9, duration: 3.1 },
  { left: 33, top: 68, size: 2, delay: -2.2, duration: 2.7 },
  { left: 42, top: 27, size: 1.5, delay: -1.2, duration: 2.5 },
  { left: 51, top: 53, size: 2.5, delay: -0.2, duration: 3.2 },
  { left: 61, top: 31, size: 2, delay: -2.5, duration: 2.9 },
  { left: 70, top: 66, size: 1.5, delay: -1.4, duration: 2.6 },
  { left: 79, top: 40, size: 2.5, delay: -0.7, duration: 3 },
  { left: 88, top: 59, size: 2, delay: -2, duration: 2.7 },
];

function effortColorAt(position: number, count: number) {
  const stops = EFFORT_COLOR_VARS.slice(0, Math.max(count, 1));
  const clamped = Math.max(0, Math.min(stops.length - 1, position));
  const lower = Math.floor(clamped);
  const upper = Math.min(lower + 1, stops.length - 1);
  if (lower === upper) return stops[lower];
  const upperWeight = Math.round((clamped - lower) * 100);
  return `color-mix(in srgb, ${stops[upper]} ${upperWeight}%, ${stops[lower]})`;
}

function effortSpectrumGradient(count: number) {
  const stops = EFFORT_COLOR_VARS.slice(0, Math.max(count, 1));
  if (stops.length <= 1) return stops[0] ?? 'var(--muted-foreground)';
  return `linear-gradient(90deg, ${stops.map((color, index) => `${color} ${(index / (stops.length - 1)) * 100}%`).join(', ')})`;
}

function EffortIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round">
      <path d="M5 18v-5" />
      <path d="M12 18V9" />
      <path d="M19 18V5" />
    </svg>
  );
}

function resolveDefaultSelection(
  configs: AgentRuntimeConfigDto[],
  leaderConfigId?: string | null,
  preferred?: { configId: string | null; modelId: string | null } | null,
) {
  const preferredConfig = configs.find((config) => config.id === preferred?.configId) ?? null;
  const preferredModel = preferredConfig?.models.find((model) => model.id === preferred?.modelId && model.name.trim()) ?? null;
  if (preferredConfig && preferredModel) return { config: preferredConfig, model: preferredModel };

  const roleConfig = configs.find((config) => config.id === leaderConfigId && config.models.some((model) => model.name.trim())) ?? null;
  const runtimeConfig = roleConfig
    ?? configs.find((config) => config.models.some((model) => model.name.trim()))
    ?? null;
  const model = runtimeConfig?.models.find((item) => item.name.trim()) ?? null;
  return runtimeConfig && model ? { config: runtimeConfig, model } : null;
}

export default function LeaderModelSelector({
  flowId,
  defaultSelection = false,
  selection,
  onSelectionChange,
  selectionReasoningEffort,
  onSelectionReasoningEffortChange,
  className,
  onOpenModelSettings,
  onConfiguredChange,
  onUpdatingChange,
  reasoningEffortDisabled = false,
}: LeaderModelSelectorProps) {
  const [runtimePickerOpen, setRuntimePickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const [runtimeConfigs, setRuntimeConfigs] = useState<AgentRuntimeConfigDto[]>([]);
  const [defaultLeaderRuntimeConfigId, setDefaultLeaderRuntimeConfigId] = useState<string | null>(null);
  const [selectedRuntimeConfigId, setSelectedRuntimeConfigId] = useState<string | null>(null);
  const [selectedRuntimeModelId, setSelectedRuntimeModelId] = useState<string | null>(null);
  const [flowRuntimeSdk, setFlowRuntimeSdk] = useState<AgentRuntimeConfigDto['sdk'] | null>(null);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<string | null>(null);
  const [draftReasoningEffortPosition, setDraftReasoningEffortPosition] = useState<number | null>(null);
  const [frozenReasoningEffortLabel, setFrozenReasoningEffortLabel] = useState<string | null>(null);
  const [isDraggingEffort, setIsDraggingEffort] = useState(false);
  const [activeRuntimeConfigId, setActiveRuntimeConfigId] = useState<string | null>(null);
  const [showRuntimeModelMenu, setShowRuntimeModelMenu] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isUpdatingRuntime, setIsUpdatingRuntime] = useState(false);
  const [isUpdatingEffort, setIsUpdatingEffort] = useState(false);
  const [officialEffortAlignOffset, setOfficialEffortAlignOffset] = useState(0);
  const pointerPreviewConfigIdRef = useRef<string | null>(null);
  const pendingReasoningEffortRef = useRef<string | null>(null);
  const effortTrackRef = useRef<HTMLDivElement | null>(null);
  const selectorGroupRef = useRef<HTMLDivElement | null>(null);
  const effortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedFlow = useFlowStore((state) => state.selectedFlow);
  const flows = useFlowStore((state) => state.flows);
  const refreshFlowDetail = useFlowStore((state) => state.refreshFlowDetail);
  const refreshFlows = useFlowStore((state) => state.refreshFlows);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onSelectionReasoningEffortChangeRef = useRef(onSelectionReasoningEffortChange);
  onSelectionChangeRef.current = onSelectionChange;
  onSelectionReasoningEffortChangeRef.current = onSelectionReasoningEffortChange;

  useEffect(() => {
    let cancelled = false;
    fetchAgentRuntimeConfig()
      .then((snapshot) => {
        if (cancelled) return;
        setRuntimeConfigs(snapshot.configs);
        setDefaultLeaderRuntimeConfigId(
          snapshot.roles.find((role) => role.role === 'leader')?.configId ?? null,
        );
      })
      .catch((fetchError) => {
        if (!cancelled) setRuntimeError(fetchError instanceof Error ? fetchError.message : '加载模型配置失败');
      });
    return () => {
      cancelled = true;
    };
  }, [defaultSelection, flowId]);

  useEffect(() => {
    if (flowId || !defaultSelection || runtimeConfigs.length === 0) return;
    const resolved = resolveDefaultSelection(
      runtimeConfigs,
      defaultLeaderRuntimeConfigId,
      selection,
    );
    const resolvedEffort = normalizeReasoningEffortForConfig(
      resolved?.config,
      resolved?.model,
      selectionReasoningEffort,
    );
    setSelectedRuntimeConfigId(resolved?.config.id ?? null);
    setSelectedRuntimeModelId(resolved?.model.id ?? null);
    setSelectedReasoningEffort(resolvedEffort || null);
    setActiveRuntimeConfigId(resolved?.config.id ?? null);
    if (
      resolved
      && (selection?.configId !== resolved.config.id || selection?.modelId !== resolved.model.id)
    ) {
      onSelectionChangeRef.current?.({ configId: resolved.config.id, modelId: resolved.model.id });
    }
    if ((resolvedEffort || null) !== selectionReasoningEffort) {
      onSelectionReasoningEffortChangeRef.current?.(resolvedEffort || null);
    }
  }, [
    defaultLeaderRuntimeConfigId,
    defaultSelection,
    flowId,
    runtimeConfigs,
    selection?.configId,
    selection?.modelId,
    selectionReasoningEffort,
  ]);

  useEffect(() => {
    let cancelled = false;
    const localFlow = flowId && selectedFlow?.id === flowId
      ? selectedFlow
      : flows.find((flow) => flow.id === flowId) ?? null;
    if (!flowId) {
      setFlowRuntimeSdk(null);
      if (selection) {
        setSelectedRuntimeConfigId(selection.configId);
        setSelectedRuntimeModelId(selection.modelId);
        setActiveRuntimeConfigId(selection.configId);
      } else if (!defaultSelection) {
        setSelectedRuntimeConfigId(null);
        setSelectedRuntimeModelId(null);
        setActiveRuntimeConfigId(null);
      }
      return;
    }
    if (localFlow) {
      setFlowRuntimeSdk(localFlow.leader_runtime_sdk === 'claudecode' || localFlow.leader_runtime_sdk === 'codex'
        ? localFlow.leader_runtime_sdk
        : null);
      setSelectedRuntimeConfigId(localFlow.leader_runtime_config_id ?? null);
      setSelectedRuntimeModelId(localFlow.leader_runtime_model_id ?? null);
      setSelectedReasoningEffort(localFlow.leader_runtime_reasoning_effort ?? null);
      setActiveRuntimeConfigId(localFlow.leader_runtime_config_id ?? null);
      return;
    }
    fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((flow: {
        leader_runtime_sdk?: string | null;
        leader_runtime_config_id?: string | null;
        leader_runtime_model_id?: string | null;
        leader_runtime_reasoning_effort?: string | null;
      } | null) => {
        if (cancelled) return;
        setFlowRuntimeSdk(flow?.leader_runtime_sdk === 'claudecode' || flow?.leader_runtime_sdk === 'codex'
          ? flow.leader_runtime_sdk
          : null);
        setSelectedRuntimeConfigId(flow?.leader_runtime_config_id ?? null);
        setSelectedRuntimeModelId(flow?.leader_runtime_model_id ?? null);
        setSelectedReasoningEffort(flow?.leader_runtime_reasoning_effort ?? null);
        setActiveRuntimeConfigId(flow?.leader_runtime_config_id ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setFlowRuntimeSdk(null);
          setSelectedRuntimeConfigId(null);
          setSelectedRuntimeModelId(null);
          setSelectedReasoningEffort(null);
          setActiveRuntimeConfigId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [defaultSelection, flowId, flows, selectedFlow, selection]);

  const leaderRuntimeConfig = useMemo(
    () => runtimeConfigs.find((config) => config.id === selectedRuntimeConfigId) ?? null,
    [runtimeConfigs, selectedRuntimeConfigId],
  );

  const activeRuntimeConfig = useMemo(
    () => runtimeConfigs.find((config) => config.id === activeRuntimeConfigId)
      ?? leaderRuntimeConfig
      ?? runtimeConfigs[0]
      ?? null,
    [activeRuntimeConfigId, leaderRuntimeConfig, runtimeConfigs],
  );

  const leaderModel = leaderRuntimeConfig?.models.find((model) => model.id === selectedRuntimeModelId)
    ?? null;
  const leaderModelName = leaderModel?.name.trim() || '未配置';
  const lockedRuntimeSdk = flowId ? flowRuntimeSdk ?? leaderRuntimeConfig?.sdk ?? null : null;
  const runtimeConfigDisabledReason = (runtimeConfig: AgentRuntimeConfigDto | null | undefined) => {
    if (!flowId || !runtimeConfig) return null;
    if (lockedRuntimeSdk && runtimeConfig.sdk !== lockedRuntimeSdk) {
      return `当前 Flow 已锁定 ${runtimeSdkLabel(lockedRuntimeSdk)}，不能切换到 ${runtimeSdkLabel(runtimeConfig.sdk)}。`;
    }
    if (
      leaderRuntimeConfig?.sdk === 'codex'
      && runtimeConfig.sdk === 'codex'
      && (leaderRuntimeConfig.authMode === 'inherited') !== (runtimeConfig.authMode === 'inherited')
    ) {
      return 'Codex 官方登录态与非官方配置不能在同一 Flow 内直接切换。';
    }
    return null;
  };
  const isConfigured = Boolean(leaderRuntimeConfig && leaderModel?.name.trim());
  const isOfficialCodex = leaderRuntimeConfig?.sdk === 'codex' && leaderRuntimeConfig.authMode === 'inherited';
  const effortOptions = reasoningEffortOptionsForConfig(leaderRuntimeConfig);
  const usesOfficialCodexEffort = isOfficialCodex && effortOptions.length > 0;
  const usesClaudeEffortMenu = leaderRuntimeConfig?.sdk === 'claudecode' && effortOptions.length > 0;
  const activeReasoningEffort = normalizeReasoningEffortForConfig(leaderRuntimeConfig, leaderModel, selectedReasoningEffort);
  const activeReasoningEffortIndex = Math.max(0, effortOptions.findIndex((option) => option.value === activeReasoningEffort));
  const activeReasoningEffortOption = effortOptions[activeReasoningEffortIndex] ?? null;
  const draftEffortPosition = draftReasoningEffortPosition ?? activeReasoningEffortIndex;
  const draftReasoningEffortIndex = Math.min(
    Math.max(Math.round(draftEffortPosition), 0),
    Math.max(effortOptions.length - 1, 0),
  );
  const draftReasoningEffortOption = effortOptions[draftReasoningEffortIndex] ?? activeReasoningEffortOption;
  const effortProgress = effortOptions.length <= 1 ? 0 : (draftEffortPosition / (effortOptions.length - 1)) * 100;
  const triggerReasoningEffortLabel = effortPickerOpen
    ? frozenReasoningEffortLabel ?? activeReasoningEffortOption?.label
    : activeReasoningEffortOption?.label;
  const effortSpectrum = effortSpectrumGradient(effortOptions.length);
  const draftEffortColor = effortColorAt(draftEffortPosition, effortOptions.length);
  const activeEffortProgress = effortOptions.length <= 1 ? 0 : (activeReasoningEffortIndex / (effortOptions.length - 1)) * 100;
  const triggerEffortColor = usesOfficialCodexEffort
    ? `color-mix(in srgb, var(--ui-codex-effort-end) ${Math.round(activeEffortProgress)}%, var(--ui-codex-effort-start))`
    : effortColorAt(activeReasoningEffortIndex, effortOptions.length);
  const officialEffortPosition = officialEffortCssPosition(effortProgress);
  const isHighestOfficialEffort = usesOfficialCodexEffort && draftReasoningEffortIndex === effortOptions.length - 1;

  useEffect(() => {
    onConfiguredChange?.(isConfigured);
  }, [isConfigured, onConfiguredChange]);

  useEffect(() => {
    onUpdatingChange?.(isUpdatingRuntime || isUpdatingEffort);
  }, [isUpdatingEffort, isUpdatingRuntime, onUpdatingChange]);

  useEffect(() => () => {
    onUpdatingChange?.(false);
  }, [onUpdatingChange]);

  const openRuntimePicker = (open: boolean) => {
    if (open && runtimeConfigs.length === 0 && onOpenModelSettings) {
      onOpenModelSettings();
      return;
    }
    setRuntimePickerOpen(open);
    if (open) {
      setRuntimeError(null);
      const currentConfigId = selectedRuntimeConfigId ?? runtimeConfigs[0]?.id ?? null;
      pointerPreviewConfigIdRef.current = null;
      setActiveRuntimeConfigId(currentConfigId);
      setShowRuntimeModelMenu(Boolean(currentConfigId));
    } else {
      setShowRuntimeModelMenu(false);
    }
  };

  const selectReasoningEffort = async (effort: string, closeOnSuccess = false) => {
    if (
      (!flowId && !defaultSelection)
      || isUpdatingEffort
      || reasoningEffortDisabled
      || effort === activeReasoningEffort
      || pendingReasoningEffortRef.current === effort
    ) return;
    if (!flowId && defaultSelection) {
      setSelectedReasoningEffort(effort);
      onSelectionReasoningEffortChange?.(effort);
      if (closeOnSuccess) setEffortPickerOpen(false);
      return;
    }
    if (!flowId) return;
    const previousEffort = selectedReasoningEffort;
    setRuntimeError(null);
    setIsUpdatingEffort(true);
    pendingReasoningEffortRef.current = effort;
    setSelectedReasoningEffort(effort);
    try {
      await updateFlowLeaderRuntimeSelection(flowId, { reasoningEffort: effort });
      await Promise.all([
        refreshFlowDetail(flowId),
        refreshFlows(),
      ]);
      if (closeOnSuccess) setEffortPickerOpen(false);
    } catch (updateError) {
      setSelectedReasoningEffort(previousEffort);
      setRuntimeError(updateError instanceof Error ? updateError.message : '切换推理强度失败');
    } finally {
      if (pendingReasoningEffortRef.current === effort) pendingReasoningEffortRef.current = null;
      setIsUpdatingEffort(false);
    }
  };

  const effortPositionFromPointer = (clientX: number) => {
    const track = effortTrackRef.current;
    if (!track || effortOptions.length <= 1) return 0;
    const rect = track.getBoundingClientRect();
    const endpointInset = usesOfficialCodexEffort ? 16 : 0;
    const usableWidth = rect.width - endpointInset * 2;
    if (usableWidth <= 0) return draftEffortPosition;
    const rawPosition = ((clientX - rect.left - endpointInset) / usableWidth) * (effortOptions.length - 1);
    return Math.min(Math.max(rawPosition, 0), effortOptions.length - 1);
  };

  const commitDraftReasoningEffort = (position = draftEffortPosition) => {
    const nextIndex = Math.min(
      Math.max(Math.round(position), 0),
      Math.max(effortOptions.length - 1, 0),
    );
    const nextOption = effortOptions[nextIndex];
    if (!nextOption) return;
    setDraftReasoningEffortPosition(nextIndex);
    void selectReasoningEffort(nextOption.value);
  };

  const setKeyboardReasoningEffort = (index: number) => {
    const nextIndex = Math.min(Math.max(index, 0), effortOptions.length - 1);
    const nextOption = effortOptions[nextIndex];
    if (!nextOption) return;
    setDraftReasoningEffortPosition(nextIndex);
    void selectReasoningEffort(nextOption.value);
  };

  const previewRuntimeConfig = (configId: string) => {
    if (pointerPreviewConfigIdRef.current !== configId) {
      pointerPreviewConfigIdRef.current = configId;
      setActiveRuntimeConfigId(configId);
    }
    setShowRuntimeModelMenu(true);
  };

  const selectRuntimeModel = async (config: AgentRuntimeConfigDto, model: RuntimeModelDto) => {
    if (
      isUpdatingRuntime
      || !model.name.trim()
      || (!flowId && !defaultSelection)
      || Boolean(runtimeConfigDisabledReason(config))
    ) return;
    const previousConfigId = selectedRuntimeConfigId;
    const previousModelId = selectedRuntimeModelId;
    setRuntimeError(null);
    setIsUpdatingRuntime(true);
    setRuntimePickerOpen(false);
    setShowRuntimeModelMenu(false);
    pointerPreviewConfigIdRef.current = null;
    setSelectedRuntimeConfigId(config.id);
    setSelectedRuntimeModelId(model.id);
    if (!flowId && defaultSelection) {
      const nextEffort = defaultReasoningEffortForConfig(config);
      setSelectedReasoningEffort(nextEffort || null);
      onSelectionChange?.({ configId: config.id, modelId: model.id });
      onSelectionReasoningEffortChange?.(nextEffort || null);
      setIsUpdatingRuntime(false);
      return;
    }
    if (!flowId) return;
    try {
      await updateFlowLeaderRuntimeSelection(flowId, { configId: config.id, modelId: model.id });
      await Promise.all([
        refreshFlowDetail(flowId),
        refreshFlows(),
      ]);
      onSelectionChange?.({ configId: config.id, modelId: model.id });
    } catch (updateError) {
      setSelectedRuntimeConfigId(previousConfigId);
      setSelectedRuntimeModelId(previousModelId);
      setRuntimeError(updateError instanceof Error ? updateError.message : '切换模型失败');
    } finally {
      setIsUpdatingRuntime(false);
    }
  };

  return (
    <div
      ref={selectorGroupRef}
      data-testid="leader-model-selector"
      data-effort-layout={usesOfficialCodexEffort ? 'combined' : usesClaudeEffortMenu ? 'claude-menu' : 'split'}
      className={cn(
        'inline-flex h-7 w-fit max-w-[330px] items-center',
        usesOfficialCodexEffort
          ? 'gap-0 rounded-full bg-ui-control ring-1 ring-ui-border-subtle'
          : 'gap-1',
        className,
      )}
    >
      <Popover open={runtimePickerOpen} onOpenChange={openRuntimePicker}>
      <PopoverTrigger
        type="button"
        disabled={
          (!flowId && !defaultSelection)
          || isUpdatingRuntime
          || (runtimeConfigs.length === 0 && !onOpenModelSettings)
        }
        className={cn(
          'inline-flex h-7 min-w-0 flex-1 items-center justify-start text-[13px] font-medium text-foreground transition-colors hover:bg-ui-control-hover disabled:cursor-not-allowed disabled:opacity-45',
          usesOfficialCodexEffort
            ? 'gap-1.5 rounded-l-full py-0 pl-2.5 pr-1'
            : 'gap-1.5 rounded-lg px-2.5',
        )}
        aria-label={runtimeConfigs.length === 0 ? "配置模型" : "切换模型"}
      >
        <span className="min-w-0 truncate text-left">
          {usesOfficialCodexEffort ? officialCodexModelLabel(leaderModelName) : leaderModelName || '选择模型'}
        </span>
        {!usesOfficialCodexEffort ? (
          runtimeConfigs.length === 0
            ? <ChevronRight className="size-[15px] shrink-0 text-muted-foreground" />
            : <ChevronDown className="size-[15px] shrink-0 text-muted-foreground" />
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={14}
        collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
        className={cn(
          'max-w-[calc(100vw-32px)] overflow-visible border-0 bg-transparent p-0 shadow-none ring-0',
          showRuntimeModelMenu && activeRuntimeConfig ? 'w-[468px]' : 'w-[200px]',
        )}
      >
        <div
          data-testid="runtime-model-menu-zone"
          className="relative min-h-[176px]"
          onMouseLeave={() => {
            pointerPreviewConfigIdRef.current = null;
            setShowRuntimeModelMenu(false);
          }}
        >
          <div className="flex min-h-[176px] w-[200px] flex-col rounded-xl border border-ui-border-subtle bg-ui-overlay p-1.5 shadow-[var(--ui-shadow-overlay)]">
            <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">供应商</div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {AGENT_ORDER.map((sdk) => {
                const group = runtimeConfigs.filter((config) => config.sdk === sdk);
                if (group.length === 0) return null;
                return (
                  <div key={sdk}>
                    <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                      <AgentIcon sdk={sdk} />
                      {AGENT_META[sdk].label}
                    </div>
                    {group.map((config) => {
                      const selected = config.id === selectedRuntimeConfigId;
                      const active = config.id === activeRuntimeConfig?.id;
                      const disabledReason = runtimeConfigDisabledReason(config);
                      return (
                        <button
                          key={config.id}
                          type="button"
                          aria-disabled={Boolean(disabledReason)}
                          title={disabledReason ?? undefined}
                          onMouseEnter={() => previewRuntimeConfig(config.id)}
                          onClick={() => previewRuntimeConfig(config.id)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors',
                            disabledReason
                              ? 'cursor-not-allowed text-muted-foreground opacity-55'
                              : active
                                ? 'bg-ui-control-hover text-foreground'
                                : 'text-foreground hover:bg-ui-control-hover',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{runtimeConfigLabel(config)}</span>
                          {selected ? <Check className="size-[15px] shrink-0 text-muted-foreground" /> : null}
                          <ChevronRight className="size-[15px] shrink-0 text-muted-foreground" />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {onOpenModelSettings ? (
              <button
                type="button"
                onClick={() => {
                  setRuntimePickerOpen(false);
                  onOpenModelSettings();
                }}
                className="mt-1 border-t border-ui-border-subtle px-2.5 py-2 text-left text-[13px] font-semibold text-foreground transition-colors hover:bg-ui-control-hover"
              >
              管理模型
              </button>
            ) : null}
          </div>

          {showRuntimeModelMenu && activeRuntimeConfig ? (
            <div className="absolute left-[208px] top-11 w-[260px] overflow-hidden rounded-xl border border-ui-border-subtle bg-ui-overlay p-2 shadow-[var(--ui-shadow-overlay)]">
              <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                {runtimeConfigLabel(activeRuntimeConfig)}
              </div>
              {runtimeConfigDisabledReason(activeRuntimeConfig) ? (
                <div className="mx-2 mb-1 rounded-md bg-ui-control px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
                  {runtimeConfigDisabledReason(activeRuntimeConfig)}
                </div>
              ) : null}
              <div className="max-h-[280px] overflow-y-auto">
                {activeRuntimeConfig.models.filter((model) => model.name.trim()).map((model) => {
                  const selected = activeRuntimeConfig.id === selectedRuntimeConfigId && model.id === selectedRuntimeModelId;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => void selectRuntimeModel(activeRuntimeConfig, model)}
                      disabled={isUpdatingRuntime || Boolean(runtimeConfigDisabledReason(activeRuntimeConfig))}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-ui-control-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{model.name}</span>
                      {selected ? <Check className="size-[15px] shrink-0 text-muted-foreground" /> : null}
                    </button>
                  );
                })}
                {activeRuntimeConfig.models.filter((model) => model.name.trim()).length === 0 ? (
                  <div className="px-2.5 py-8 text-center text-xs text-muted-foreground">暂无可用模型</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        {runtimeError ? (
          <div className="border-t border-ui-border-subtle px-3 py-2 text-xs text-destructive" aria-live="polite">
            {runtimeError}
          </div>
        ) : null}
      </PopoverContent>
      </Popover>
      {(flowId || defaultSelection) && activeReasoningEffortOption ? (
        <Popover
          open={effortPickerOpen}
          onOpenChange={(open) => {
            if (open && usesOfficialCodexEffort && selectorGroupRef.current && effortTriggerRef.current) {
              const groupRect = selectorGroupRef.current.getBoundingClientRect();
              const triggerRect = effortTriggerRef.current.getBoundingClientRect();
              setOfficialEffortAlignOffset(
                groupRect.left + groupRect.width / 2 - (triggerRect.left + triggerRect.width / 2),
              );
            }
            setEffortPickerOpen(open);
            setDraftReasoningEffortPosition(open ? activeReasoningEffortIndex : null);
            setFrozenReasoningEffortLabel(open ? activeReasoningEffortOption.label : null);
            if (!open) setIsDraggingEffort(false);
          }}
        >
          <PopoverTrigger
            ref={effortTriggerRef}
            type="button"
            disabled={(!flowId && !defaultSelection) || reasoningEffortDisabled}
            aria-label={usesClaudeEffortMenu ? '调整 Claude effort' : '调整 Codex 推理强度'}
            data-updating={isUpdatingEffort}
            className={cn(
              'inline-flex h-7 shrink-0 items-center justify-center text-[12px] font-semibold text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-45',
              usesOfficialCodexEffort
                ? 'min-w-0 gap-1 rounded-r-full py-0 pl-1 pr-2 hover:bg-ui-control-hover'
                : usesClaudeEffortMenu
                  ? 'min-w-[78px] gap-1 rounded-lg border border-ui-border-subtle bg-ui-control px-2 hover:bg-ui-control-hover'
                  : 'min-w-[68px] gap-1.5 rounded-lg border px-2',
            )}
            style={usesOfficialCodexEffort || usesClaudeEffortMenu ? undefined : {
              borderColor: `color-mix(in srgb, ${triggerEffortColor} 36%, transparent)`,
              background: `color-mix(in srgb, ${triggerEffortColor} 13%, transparent)`,
            }}
          >
            {!usesOfficialCodexEffort && !usesClaudeEffortMenu ? <EffortIcon className="size-3.5 shrink-0" style={{ color: triggerEffortColor }} /> : null}
            <span
              data-testid={usesOfficialCodexEffort ? 'codex-effort-trigger-label' : undefined}
              className={usesOfficialCodexEffort ? 'w-7 shrink-0 text-center' : undefined}
              style={usesOfficialCodexEffort && draftReasoningEffortIndex === effortOptions.length - 1
                ? { color: 'var(--ui-codex-effort-end)' }
                : undefined}
            >{usesOfficialCodexEffort
              ? officialReasoningEffortLabel(effortPickerOpen
                ? draftReasoningEffortOption?.value
                : activeReasoningEffortOption?.value)
              : triggerReasoningEffortLabel}</span>
            {usesOfficialCodexEffort || usesClaudeEffortMenu ? <ChevronDown className="size-[15px] shrink-0 text-muted-foreground" /> : null}
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align={usesOfficialCodexEffort ? 'center' : 'end'}
            alignOffset={usesOfficialCodexEffort ? officialEffortAlignOffset : 0}
            sideOffset={14}
            collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
            data-testid={usesClaudeEffortMenu ? 'claude-effort-popover' : 'codex-effort-popover'}
            data-effort-variant={usesOfficialCodexEffort ? 'official' : usesClaudeEffortMenu ? 'claude-menu' : 'classic'}
            className={cn(
              'max-w-[calc(100vw-32px)] rounded-2xl border border-ui-border-subtle bg-ui-overlay shadow-[var(--ui-shadow-overlay)]',
              usesOfficialCodexEffort
                ? 'w-[225px] rounded-[13px] px-3 py-3'
                : usesClaudeEffortMenu
                  ? 'w-[256px] rounded-xl px-2.5 py-2.5'
                  : 'w-[272px] px-4 py-3.5',
            )}
          >
            <div className="relative rounded-xl">
              {usesClaudeEffortMenu ? (
                <div
                  data-testid="claude-effort-options"
                  role="menu"
                  aria-label="Claude effort levels"
                  className="space-y-1"
                >
                  <div className="px-2 pb-1.5 pt-0.5 text-[14px] font-semibold leading-5 text-foreground">Effort</div>
                  {effortOptions.map((option) => {
                    const selected = option.value === activeReasoningEffort;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        disabled={isUpdatingEffort}
                        onClick={() => void selectReasoningEffort(option.value, true)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                          selected ? 'bg-ui-control-hover' : 'hover:bg-ui-control-hover',
                        )}
                      >
                        <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold leading-5 text-foreground">
                          {option.value}
                        </span>
                        {selected ? <Check className="size-[15px] shrink-0 text-foreground" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <>
              {usesOfficialCodexEffort ? (
                <div className="mb-2 flex h-5 items-center text-[14px] font-medium leading-5 text-muted-foreground">
                  <span
                    data-testid="codex-effort-current-label"
                    className="inline-flex items-center gap-1"
                    style={isHighestOfficialEffort ? { color: 'var(--ui-codex-effort-end)' } : undefined}
                  >
                    {officialReasoningEffortLabel(draftReasoningEffortOption?.value)}
                    <ChevronRight className="size-3.5" />
                  </span>
                </div>
              ) : (
                <div className="mb-3 flex items-baseline gap-2">
                  <span className="text-[15px] font-medium leading-none text-muted-foreground">Effort</span>
                  <span className="text-[15px] font-semibold leading-none text-foreground transition-colors duration-150">
                    {draftReasoningEffortOption?.label}
                  </span>
                </div>
              )}
              <div
                ref={effortTrackRef}
                role="slider"
                tabIndex={0}
                aria-label="Codex 推理强度"
                aria-valuemin={0}
                aria-valuemax={effortOptions.length - 1}
                aria-valuenow={draftReasoningEffortIndex}
                aria-valuetext={draftReasoningEffortOption?.label}
                data-disabled={isUpdatingEffort}
                className={cn(
                  'relative w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/35',
                  usesOfficialCodexEffort ? 'h-8 rounded-full' : 'h-9 rounded-md',
                )}
                onPointerDown={(event) => {
                  if (isUpdatingEffort) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  setIsDraggingEffort(true);
                  setDraftReasoningEffortPosition(effortPositionFromPointer(event.clientX));
                }}
                onPointerMove={(event) => {
                  if (isUpdatingEffort || event.buttons !== 1) return;
                  setDraftReasoningEffortPosition(effortPositionFromPointer(event.clientX));
                }}
                onPointerUp={(event) => {
                  if (isUpdatingEffort) return;
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  const nextPosition = effortPositionFromPointer(event.clientX);
                  setIsDraggingEffort(false);
                  setDraftReasoningEffortPosition(nextPosition);
                  commitDraftReasoningEffort(nextPosition);
                }}
                onPointerCancel={() => {
                  setIsDraggingEffort(false);
                  setDraftReasoningEffortPosition(activeReasoningEffortIndex);
                }}
                onKeyDown={(event) => {
                  if (isUpdatingEffort) return;
                  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setKeyboardReasoningEffort(draftReasoningEffortIndex + 1);
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    setKeyboardReasoningEffort(draftReasoningEffortIndex - 1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    setKeyboardReasoningEffort(0);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    setKeyboardReasoningEffort(effortOptions.length - 1);
                  }
                }}
              >
                {usesOfficialCodexEffort ? (
                  <>
                    <div aria-hidden="true" className="absolute inset-x-0 inset-y-1 rounded-full bg-foreground/12 shadow-inner" />
                    <div
                      aria-hidden="true"
                      data-testid="codex-effort-fill"
                      className="absolute inset-x-0 bottom-1 top-1 overflow-hidden rounded-full transition-[clip-path] duration-150 ease-out"
                      style={{
                        clipPath: `inset(0 ${100 - effortProgress}% 0 0 round 999px)`,
                        background: 'var(--ui-codex-effort-start)',
                      }}
                    >
                      <div
                        className="sf-codex-effort-gradient absolute inset-0 transition-opacity duration-500"
                        style={{
                          backgroundImage: OFFICIAL_CODEX_EFFORT_GRADIENT,
                          opacity: isHighestOfficialEffort ? 1 : 0,
                        }}
                      />
                      {OFFICIAL_CODEX_EFFORT_PARTICLES.map((particle, index) => (
                        <span
                          key={index}
                          data-testid="codex-effort-particle"
                          className="sf-codex-effort-particle absolute rounded-full bg-[var(--ui-codex-effort-highlight)]"
                          style={{
                            left: `${particle.left}%`,
                            top: `${particle.top}%`,
                            width: particle.size,
                            height: particle.size,
                            animationDelay: `${particle.delay}s`,
                            animationDuration: `${particle.duration}s`,
                          }}
                        />
                      ))}
                    </div>
                    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                      {effortOptions.map((option, index) => (
                        <span
                          key={option.value}
                          className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color-mix(in_srgb,var(--ui-codex-effort-highlight)_25%,transparent)]"
                          style={{ left: officialEffortCssPosition(
                            effortOptions.length <= 1 ? 0 : (index / (effortOptions.length - 1)) * 100,
                          ) }}
                        />
                      ))}
                    </div>
                    <div
                      data-testid="codex-effort-knob"
                      className="absolute top-1/2 size-8 rounded-full bg-[var(--ui-codex-effort-highlight)] shadow-[var(--ui-codex-effort-knob-shadow)] transition-[left,transform] duration-150 ease-out"
                      style={{
                        left: officialEffortPosition,
                        transform: `translate(-50%, -50%) scale(${isDraggingEffort ? 1.03 : 1})`,
                      }}
                    />
                  </>
                ) : (
                  <>
                    <div
                      aria-hidden="true"
                      className="absolute inset-x-2 h-1.5 rounded-full opacity-30"
                      style={{ top: 'calc(50% - 3px)', background: effortSpectrum }}
                    />
                    <div
                      aria-hidden="true"
                      className="absolute inset-x-2 h-1.5 rounded-full transition-[clip-path] duration-150 ease-out"
                      style={{
                        top: 'calc(50% - 3px)',
                        background: effortSpectrum,
                        clipPath: `inset(0 ${100 - effortProgress}% 0 0 round 999px)`,
                      }}
                    />
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-2 flex justify-between"
                      style={{ top: 'calc(50% - 3px)', height: '6px' }}
                    >
                      {effortOptions.map((option) => (
                        <span key={option.value} className="size-[5px] rounded-full border border-border/70 bg-background" />
                      ))}
                    </div>
                    <div
                      aria-hidden="true"
                      className="absolute h-4 w-6 rounded-full blur-md transition-[left,opacity] duration-200"
                      style={{
                        top: 'calc(50% - 6px)',
                        left: `calc(8px + (100% - 16px) * ${effortProgress / 100})`,
                        opacity: isDraggingEffort ? 0.4 : 0.18,
                        transform: 'translateX(-50%)',
                        background: draftEffortColor,
                      }}
                    />
                    <div
                      className="absolute flex size-4 items-center justify-center rounded-full border-2 bg-background shadow-md transition-[left,transform,box-shadow] duration-150 ease-out"
                      style={{
                        top: 'calc(50% - 8px)',
                        left: `calc(8px + (100% - 16px) * ${effortProgress / 100})`,
                        borderColor: draftEffortColor,
                        boxShadow: isDraggingEffort
                          ? `0 0 0 5px color-mix(in srgb, ${draftEffortColor} 18%, transparent), 0 4px 12px color-mix(in srgb, var(--background) 62%, transparent)`
                          : '0 2px 8px color-mix(in srgb, var(--background) 58%, transparent)',
                        transform: `translateX(-50%) scaleX(${isDraggingEffort ? 1.16 : 1}) scaleY(${isDraggingEffort ? 0.96 : 1})`,
                      }}
                    />
                  </>
                )}
              </div>
                </>
              )}
            </div>
            {runtimeError ? (
              <div className="mt-3 border-t border-ui-border-subtle pt-2 text-xs text-destructive" aria-live="polite">
                {runtimeError}
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
