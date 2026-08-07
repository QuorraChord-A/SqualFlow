"use client";

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  FileText,
  Moon,
  Palette,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  UserRoundCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { MessageResponse } from "@/components/ai-elements-official/message";
import { useThemeStore, type ThemeName } from "../stores/useThemeStore";
import { useAppPreferencesStore } from "../stores/useAppPreferencesStore";
import { useModalStore } from "../stores/useModalStore";
import { getDesktopUpdateBridge, type DesktopUpdateState } from "../lib/desktopUpdate";
import { AGENT_META, AGENT_ORDER, AgentIcon, runtimeSdkLabel } from "../lib/agentMeta";
import {
  normalizeReasoningEffortForSdk,
  reasoningEffortLabelForSdk,
  reasoningEffortOptionsForSdk,
} from "../lib/runtimeReasoningEffort";
import {
  createAgentRuntimeConfig,
  deleteAgentRuntimeConfig,
  fetchAgentRuntimeConfig,
  fetchAgentDefinitions,
  refreshAgentRuntimeModels,
  testAgentRuntimeConnection,
  updateAgentRuntimeConfig,
  updateAgentRuntimeRole,
  type AgentRuntimeConfigDto as RuntimeConfig,
  type AgentRuntimeRole as AgentRole,
  type AgentDefinitionDto,
  type RuntimeModelDto as RuntimeModel,
  type RuntimeAuthMode,
  type RuntimeSdk,
  type RoleRuntimeBindingDto,
  checkAgentRuntimeLocalAuth,
  type RuntimeLocalAuthResultDto,
} from "../lib/api";

export type SettingsSection = "general" | "agents";
export type AgentSettingsTab = "role_assignment" | "runtime_configs";

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
  initialAgentTab?: AgentSettingsTab;
}

type RoleDefinition = {
  id: string;
  role: AgentRole;
  label: string;
  description: string;
  systemPrompt: string;
  fixedEnabled?: boolean;
  Icon: typeof Bot;
};

type RuntimeModelChoice = RuntimeModel & {
  selected: boolean;
  existing: boolean;
};

const THEME_LABELS: Record<ThemeName, string> = {
  system: "跟随系统",
  dark: "深色",
  light: "浅色",
};

const SYSTEM_PROMPT_PREVIEW_LENGTH = 80;
const MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K = 128;
const CLAUDE_CONTEXT_WINDOW_K_OPTIONS = [200, 1_000] as const;

const maskedTextStyle = { WebkitTextSecurity: "disc" } as CSSProperties;

function isDraftRuntimeConfig(config: RuntimeConfig) {
  return config.id.startsWith("draft-");
}

const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    id: "leader",
    role: "leader",
    label: "Leader",
    description: "负责规划、追问、分派专家和汇总结果。",
    fixedEnabled: true,
    systemPrompt:
      "你是 SquadFlow Leader Agent。负责理解用户目标、拆解编排计划、维护任务上下文、分派合适的 Expert，并在关键节点向用户追问或汇总结果。你需要优先保持任务边界清晰，避免无关改动。",
    Icon: UserRoundCog,
  },
  {
    id: "coder",
    role: "coder",
    label: "Coder Expert",
    description: "负责前后端实现、样式交互、API、数据库与运行时逻辑。",
    systemPrompt:
      "你是 SquadFlow Coder Expert。负责全栈交付：一个连贯任务内完成前端实现与后端 API、数据库、运行时逻辑改动，并给出清晰的最终结论。",
    Icon: Code2,
  },
  {
    id: "research",
    role: "research",
    label: "调研 Expert",
    description: "负责资料检索、方案调研和信息整理。",
    systemPrompt:
      "你是 SquadFlow Research Expert。只使用读取和搜索类内置工具完成调研与总结，不创建或修改文件。你需要标注信息来源、区分事实和推断，并把结论整理成可执行建议。",
    Icon: Search,
  },
  {
    id: "verify",
    role: "verify",
    label: "验证 Expert",
    description: "负责验证结果、执行测试和确认用户流程。",
    systemPrompt:
      "你是 SquadFlow Verify Expert。目标项目目录只读，只能在独立 scratch 目录写临时输出；不得修改目标项目。只验证指定范围并给出明确的验证结论。",
    Icon: Settings2,
  },
  {
    id: "codereview",
    role: "codereview",
    label: "CodeReview Expert",
    description: "负责代码审查、回归风险和缺失测试检查。",
    systemPrompt:
      "你是 SquadFlow CodeReview Expert。目标项目目录只读，只能在独立 scratch 目录写临时输出；不得修改目标项目。优先找 bug、回归、状态不一致、契约不匹配和缺失测试。",
    Icon: FileCode2,
  },
];

const INITIAL_ROLE_CONFIGS: Record<AgentRole, string> = {
  leader: "",
  coder: "",
  research: "",
  verify: "",
  codereview: "",
};

const INITIAL_ROLE_MODELS: Record<AgentRole, string> = {
  leader: "",
  coder: "",
  research: "",
  verify: "",
  codereview: "",
};

const INITIAL_ROLE_ENABLED: Record<AgentRole, boolean> = {
  leader: true,
  coder: true,
  research: false,
  verify: true,
  codereview: true,
};

const INITIAL_ROLE_REASONING_EFFORTS: Record<AgentRole, string> = {
  leader: "high",
  coder: "high",
  research: "high",
  verify: "high",
  codereview: "high",
};

function sectionButtonClass(active: boolean) {
  return [
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
    active
      ? "bg-sidebar-accent text-sidebar-foreground"
      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
  ].join(" ");
}

function agentTabButtonClass(active: boolean) {
  return [
    "inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors",
    active
      ? "bg-muted text-foreground"
      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
  ].join(" ");
}

function promptPreview(prompt: string, expanded: boolean) {
  if (expanded || prompt.length <= SYSTEM_PROMPT_PREVIEW_LENGTH) return prompt;
  return `${prompt.slice(0, SYSTEM_PROMPT_PREVIEW_LENGTH)}...`;
}

function roleConfigMap(bindings: RoleRuntimeBindingDto[]) {
  return Object.fromEntries(bindings.map((binding) => [binding.role, binding.configId])) as Record<AgentRole, string>;
}

function roleModelMap(bindings: RoleRuntimeBindingDto[]) {
  return Object.fromEntries(bindings.map((binding) => [binding.role, binding.modelId ?? ""])) as Record<AgentRole, string>;
}

function roleEnabledMap(bindings: RoleRuntimeBindingDto[]) {
  return Object.fromEntries(bindings.map((binding) => [binding.role, binding.enabled])) as Record<AgentRole, boolean>;
}

function roleReasoningEffortMap(bindings: RoleRuntimeBindingDto[]) {
  return Object.fromEntries(bindings.map((binding) => [binding.role, binding.reasoningEffort])) as Record<AgentRole, string>;
}

function modelFeedbackClass(tone: "info" | "success" | "error") {
  if (tone === "error") return "border-destructive/40 bg-destructive/10 text-destructive";
  if (tone === "success") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  return "border-primary/30 bg-primary/10 text-foreground";
}

function configNameKey(name: string) {
  return name.trim().replace(/\s+/g, "");
}

function configDisplayName(config: RuntimeConfig | null | undefined) {
  return config?.name?.trim() || config?.fileName || "未配置";
}

function localAuthModeLabel(sdk: RuntimeSdk) {
  return sdk === "codex" ? "Codex 本地账号登录态" : "自定义 API Key";
}

function localAuthStatusClass(status: RuntimeLocalAuthResultDto["status"]) {
  if (status === "detected") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "missing" || status === "invalid") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  return "border-border bg-muted/30 text-muted-foreground";
}

function canRefreshAvailableModels(config: RuntimeConfig) {
  return (config.sdk === "codex" && config.authMode === "inherited")
    || config.authMode === "apiKey"
    || config.authMode === "accessToken";
}

function canTestRuntimeModel(config: RuntimeConfig) {
  return config.sdk === "codex" || config.authMode !== "inherited";
}

function modelContextValidationError(config: RuntimeConfig, model: RuntimeModel) {
  if (model.contextWindowK === null || model.contextWindowK === undefined) {
    return "未获取上下文窗口；请获取模型列表或手动填写。";
  }
  const contextWindowK = model.contextWindowK;
  if (config.sdk === "claudecode") {
    return Number.isFinite(contextWindowK) && CLAUDE_CONTEXT_WINDOW_K_OPTIONS.includes(contextWindowK as 200 | 1_000)
      ? null
      : "Claude Code 上下文窗口只能是 200K 或 1000K。";
  }
  if (!Number.isFinite(contextWindowK)) return "非官方 Codex 上下文窗口必须填写数字。";
  return contextWindowK >= MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K
    ? null
    : `非官方 Codex 上下文窗口不能低于 ${MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K}K。`;
}

function modelForSave(config: RuntimeConfig, model: RuntimeModel): RuntimeModel {
  return model;
}

function newRuntimeModelContext(config: Pick<RuntimeConfig, "sdk" | "authMode">) {
  return config.sdk === "claudecode" ? 1_000 : 256;
}

function defaultApiBaseUrl(sdk: RuntimeSdk) {
  return sdk === "claudecode" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
}

function uniqueModels<T extends RuntimeModel>(models: T[]): T[] {
  const usedIds = new Set<string>();
  return models.map((model, index) => {
    let id = model.id.trim() || `model-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    return { ...model, id, name: model.name };
  });
}

function withPreservedModelOrder(config: RuntimeConfig): RuntimeConfig {
  return { ...config, models: [...config.models] };
}

function runtimeConfigComparable(config: RuntimeConfig) {
  return {
    name: config.name,
    sdk: config.sdk,
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: config.models.map((model) => ({
      ...model,
      name: model.name.trim(),
    })),
  };
}

function runtimeConfigHasChanges(config: RuntimeConfig | null | undefined, persisted: RuntimeConfig | null | undefined) {
  if (!config) return false;
  if (isDraftRuntimeConfig(config)) return true;
  if (!persisted) return true;
  return JSON.stringify(runtimeConfigComparable(config)) !== JSON.stringify(runtimeConfigComparable(persisted));
}

function sanitizeConfigNameInput(name: string) {
  return name.replace(/\s+/g, "");
}

function nextUnnamedConfigName(configs: RuntimeConfig[]) {
  const existingNames = new Set(configs.map((config) => configNameKey(config.name)));
  let index = 1;
  while (existingNames.has(`未命名配置${index}`)) index += 1;
  return `未命名配置${index}`;
}

function configNameValidationError(configs: RuntimeConfig[], config: RuntimeConfig) {
  const name = config.name.trim();
  if (!name) return "配置名称不能为空。";
  if (/\s/.test(name)) return "配置名称不能包含空格。";
  const duplicate = configs.some((item) => item.id !== config.id && configNameKey(item.name) === configNameKey(name));
  return duplicate ? "配置名称不能重复。" : null;
}

function runtimeConfigValidationError(configs: RuntimeConfig[], config: RuntimeConfig) {
  const nameError = configNameValidationError(configs, config);
  if (nameError) return { scope: "runtime" as const, message: nameError };
  if (config.models.some((model) => !model.name.trim())) {
    return { scope: "model" as const, message: "请填写所有模型名称。" };
  }
  const invalidContextModel = config.models.find((model) => modelContextValidationError(config, model));
  if (invalidContextModel) {
    return { scope: "model" as const, message: modelContextValidationError(config, invalidContextModel)! };
  }
  return null;
}

function runtimeConfigVersion(config: RuntimeConfig) {
  return JSON.stringify(runtimeConfigComparable(config));
}

function usableModels(config: RuntimeConfig | null | undefined) {
  return config?.models.filter((model) => model.name.trim()) ?? [];
}

function boundModelOf(config: RuntimeConfig | null | undefined, modelId: string) {
  if (!config) return null;
  return config.models.find((model) => model.id === modelId && model.name.trim())
    ?? config.models.find((model) => model.name.trim())
    ?? null;
}

function DesktopUpdateSettings() {
  const [bridge] = useState(() => getDesktopUpdateBridge());
  const [state, setState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    if (!bridge) return undefined;
    let active = true;
    const unsubscribe = bridge.onState((nextState) => {
      if (active) setState(nextState);
    });
    void bridge.getState().then((nextState) => {
      if (active) setState(nextState);
    }).catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  if (!bridge || !state) return null;

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="grid gap-4 border-b border-border px-5 py-4 md:grid-cols-[1fr_auto] md:items-center">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <RefreshCw className="size-4 text-muted-foreground" />
            自动更新
          </div>
        </div>
        <Switch
          checked={state.automaticUpdates}
          disabled={!state.enabled}
          onCheckedChange={(enabled) => {
            void bridge.setAutomaticUpdates(enabled).then(setState).catch(() => {});
          }}
          aria-label="自动更新"
        />
      </div>

      <div className="px-5 py-4">
        <div className="text-sm font-semibold text-foreground">
          版本 {state.currentVersion || "未知"}
        </div>
      </div>
    </section>
  );
}

function GeneralSettings() {
  const { theme, setTheme, availableThemes } = useThemeStore();
  const { showReasoning, setShowReasoning } = useAppPreferencesStore();
  const openClearAllModal = useModalStore((state) => state.openClearAllModal);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="grid gap-4 border-b border-border px-5 py-4 md:grid-cols-[1fr_260px] md:items-center">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Palette className="size-4 text-muted-foreground" />
              界面主题
            </div>
            <p className="mt-1 text-sm text-muted-foreground">切换应用界面使用的主题外观。</p>
          </div>
          <Select value={theme} onValueChange={(value) => setTheme(value as ThemeName)}>
            <SelectTrigger className="w-full">
              <SelectValue>{THEME_LABELS[theme]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {availableThemes.map((themeName) => (
                <SelectItem key={themeName} value={themeName}>
                  {THEME_LABELS[themeName]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-4 border-b border-border px-5 py-4 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Moon className="size-4 text-muted-foreground" />
              展示思考过程
            </div>
            <p className="mt-1 text-sm text-muted-foreground">在对话时间线中显示模型 reasoning 区块。</p>
          </div>
          <Switch checked={showReasoning} onCheckedChange={setShowReasoning} aria-label="展示思考过程" />
        </div>

        <div className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Trash2 className="size-4 text-muted-foreground" />
              清除所有 Flow
            </div>
            <p className="mt-1 text-sm text-muted-foreground">删除当前工作区中所有 Flow 记录。</p>
          </div>
          <Button
            variant="destructive"
            onClick={openClearAllModal}
          >
            <Trash2 className="size-4" />
            清除
          </Button>
        </div>
      </section>
      <DesktopUpdateSettings />
    </div>
  );
}

type RoleModelPickerProps = {
  configs: RuntimeConfig[];
  boundConfigId: string;
  boundModelId: string;
  previewConfigId: string | null;
  onPreview: (configId: string) => void;
  onSelect: (config: RuntimeConfig, model: RuntimeModel) => void;
};

function RoleModelPicker({
  configs,
  boundConfigId,
  boundModelId,
  previewConfigId,
  onPreview,
  onSelect,
}: RoleModelPickerProps) {
  const boundConfig = configs.find((config) => config.id === boundConfigId) ?? null;
  const previewConfig = configs.find((config) => config.id === (previewConfigId ?? boundConfigId))
    ?? boundConfig
    ?? configs[0]
    ?? null;
  const previewModels = usableModels(previewConfig);
  const crossAgent = Boolean(previewConfig && boundConfig && previewConfig.sdk !== boundConfig.sdk);

  return (
    <div className="border-t border-dashed border-border bg-muted/20 px-4 py-3" data-testid="role-model-picker">
      <div className="flex gap-3">
        <div className="w-[220px] shrink-0 rounded-lg border border-border bg-card p-1.5">
          {AGENT_ORDER.map((sdk) => {
            const group = configs.filter((config) => config.sdk === sdk);
            if (group.length === 0) return null;
            return (
              <div key={sdk}>
                <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                  <AgentIcon sdk={sdk} />
                  {AGENT_META[sdk].label}
                </div>
                {group.map((config) => (
                  <button
                    key={config.id}
                    type="button"
                    data-active={config.id === previewConfig?.id}
                    onMouseEnter={() => onPreview(config.id)}
                    onClick={() => onPreview(config.id)}
                    className="flex w-full items-center gap-2 rounded-lg border-l-2 border-l-transparent px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-l-primary/50 hover:bg-muted/60 data-[active=true]:border-l-primary data-[active=true]:bg-primary/10"
                  >
                    <span className="min-w-0 flex-1 truncate">{configDisplayName(config)}</span>
                    {config.id === boundConfigId ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-border bg-card p-1.5">
          <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
            {configDisplayName(previewConfig)} 的模型
          </div>
          <div className="max-h-[220px] overflow-y-auto">
            {previewConfig && previewModels.map((model) => {
              const selected = previewConfig.id === boundConfigId && model.id === boundModelId;
              return (
                <button
                  key={model.id}
                  type="button"
                  data-selected={selected}
                  onClick={() => onSelect(previewConfig, model)}
                  className="flex w-full items-center gap-2 rounded-lg border-l-2 border-l-transparent px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-l-primary/50 hover:bg-muted/60 data-[selected=true]:border-l-primary data-[selected=true]:bg-primary/10"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{model.name}</span>
                  {selected ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                </button>
              );
            })}
            {previewModels.length === 0 ? (
              <div className="px-2.5 py-6 text-center text-xs text-muted-foreground">暂无可用模型</div>
            ) : null}
          </div>
        </div>
      </div>
      <div className={`mt-2 text-[11px] ${crossAgent ? "text-amber-500" : "text-muted-foreground"}`} aria-live="polite">
        {crossAgent && boundConfig && previewConfig
          ? `跨 Agent 切换（${runtimeSdkLabel(boundConfig.sdk)} → ${runtimeSdkLabel(previewConfig.sdk)}）：该角色下次调度将开启新会话`
          : "改动只影响之后新调度的该角色，运行中的会话不受影响"}
      </div>
    </div>
  );
}

function AgentSettings({ initialTab = "role_assignment" }: { initialTab?: AgentSettingsTab }) {
  const [agentTab, setAgentTab] = useState<AgentSettingsTab>(initialTab);
  const [selectedRoleId, setSelectedRoleId] = useState<AgentRole>("leader");
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [runtimeConfigs, setRuntimeConfigs] = useState<RuntimeConfig[]>([]);
  const [persistedRuntimeConfigs, setPersistedRuntimeConfigs] = useState<RuntimeConfig[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<Record<AgentRole, string>>(INITIAL_ROLE_CONFIGS);
  const [roleModels, setRoleModels] = useState<Record<AgentRole, string>>(INITIAL_ROLE_MODELS);
  const [roleEnabled, setRoleEnabled] = useState<Record<AgentRole, boolean>>(INITIAL_ROLE_ENABLED);
  const [roleReasoningEfforts, setRoleReasoningEfforts] = useState<Record<AgentRole, string>>(INITIAL_ROLE_REASONING_EFFORTS);
  const [agentDefinitions, setAgentDefinitions] = useState<AgentDefinitionDto[]>([]);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [runtimeFeedback, setRuntimeFeedback] = useState<string | null>(null);
  const [modelFeedback, setModelFeedback] = useState<string | null>(null);
  const [modelFeedbackTone, setModelFeedbackTone] = useState<"info" | "success" | "error">("info");
  const [localAuthStatus, setLocalAuthStatus] = useState<RuntimeLocalAuthResultDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCheckingLocalAuth, setIsCheckingLocalAuth] = useState(false);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [availableModelChoices, setAvailableModelChoices] = useState<RuntimeModelChoice[] | null>(null);
  const [availableModelsDialogOpen, setAvailableModelsDialogOpen] = useState(false);
  const [availableModelSearchQuery, setAvailableModelSearchQuery] = useState("");
  const [collapsedModelGroups, setCollapsedModelGroups] = useState({ configured: false, new: false });
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [openPickerRole, setOpenPickerRole] = useState<AgentRole | null>(null);
  const [previewConfigId, setPreviewConfigId] = useState<string | null>(null);
  const [agentChoiceOpen, setAgentChoiceOpen] = useState(false);
  const [draftAgentSdk, setDraftAgentSdk] = useState<RuntimeSdk | null>(null);
  const [configPendingDelete, setConfigPendingDelete] = useState<RuntimeConfig | null>(null);
  const [copyConfigPathState, setCopyConfigPathState] = useState<"idle" | "copied" | "failed">("idle");
  const failedAutoSaveVersionsRef = useRef(new Map<string, string>());
  const roleDefinitions = useMemo(() => ROLE_DEFINITIONS.map((role) => {
    const definition = agentDefinitions.find((item) => item.role === role.role);
    return definition ? { ...role, systemPrompt: definition.system_prompt } : role;
  }), [agentDefinitions]);
  const selectedRole = roleDefinitions.find((role) => role.role === selectedRoleId) ?? roleDefinitions[0];
  const savedRuntimeConfigs = runtimeConfigs.filter((config) => !isDraftRuntimeConfig(config));
  const selectedRoleConfig = savedRuntimeConfigs.find((config) => config.id === roleConfigs[selectedRole.role]) ?? savedRuntimeConfigs[0];
  const selectedRoleModel = boundModelOf(selectedRoleConfig, roleModels[selectedRole.role]);
  const selectedRoleReasoningEffort = selectedRoleConfig
    ? normalizeReasoningEffortForSdk(selectedRoleConfig.sdk, roleReasoningEfforts[selectedRole.role])
    : null;
  const selectedRuntimeConfig = runtimeConfigs.find((config) => config.id === selectedConfigId) ?? runtimeConfigs[0];
  const SelectedRoleIcon = selectedRole.Icon;

  const applySnapshot = (snapshot: { roles: RoleRuntimeBindingDto[]; configs: RuntimeConfig[] }) => {
    const configs = snapshot.configs.map(withPreservedModelOrder);
    setPersistedRuntimeConfigs(configs);
    setRuntimeConfigs((current) => {
      const drafts = current.filter((config) => isDraftRuntimeConfig(config));
      return [...configs, ...drafts];
    });
    setRoleConfigs(roleConfigMap(snapshot.roles));
    setRoleModels(roleModelMap(snapshot.roles));
    setRoleEnabled(roleEnabledMap(snapshot.roles));
    setRoleReasoningEfforts(roleReasoningEffortMap(snapshot.roles));
  };

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.all([fetchAgentRuntimeConfig(), fetchAgentDefinitions()])
      .then(([snapshot, definitionRows]) => {
        if (cancelled) return;
        applySnapshot(snapshot);
        setAgentDefinitions(definitionRows);
        setSelectedConfigId((current) => current || snapshot.configs[0]?.id || "");
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "加载智能体配置失败");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setAgentTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setCopyConfigPathState("idle");
  }, [selectedRuntimeConfig?.id]);

  const selectRole = (role: AgentRole) => {
    setSelectedRoleId(role);
    setPromptDialogOpen(false);
  };

  const togglePicker = (role: AgentRole) => {
    setRuntimeFeedback(null);
    selectRole(role);
    setOpenPickerRole((current) => {
      const next = current === role ? null : role;
      setPreviewConfigId(next ? roleConfigs[role] ?? null : null);
      return next;
    });
  };

  const openSelectedRoleConfig = () => {
    if (!selectedRoleConfig) return;
    setSelectedConfigId(selectedRoleConfig.id);
    setAgentTab("runtime_configs");
    setAgentChoiceOpen(false);
    setModelFeedback(null);
  };

  const showModelFeedback = (message: string, tone: "info" | "success" | "error" = "info") => {
    setModelFeedback(message);
    setModelFeedbackTone(tone);
  };

  const rolesUsingModel = (configId: string, modelId: string) =>
    roleDefinitions.filter((role) => roleConfigs[role.role] === configId && roleModels[role.role] === modelId);

  const rolesUsingConfig = (configId: string) =>
    roleDefinitions.filter((role) => roleConfigs[role.role] === configId);

  const updateSelectedRuntimeConfig = (patch: Partial<RuntimeConfig>) => {
    if (!selectedRuntimeConfig) return;
    if (
      Object.prototype.hasOwnProperty.call(patch, "authMode")
      || Object.prototype.hasOwnProperty.call(patch, "baseUrl")
      || Object.prototype.hasOwnProperty.call(patch, "apiKey")
    ) {
      setLocalAuthStatus(null);
    }
    setRuntimeConfigs((current) =>
      current.map((config) =>
        config.id === selectedRuntimeConfig.id ? { ...config, ...patch } : config,
      ),
    );
  };

  const updateSelectedModel = (modelId: string, patch: Partial<RuntimeModel>) => {
    if (!selectedRuntimeConfig) return;
    if ((typeof patch.name === "string" && patch.name.trim()) || "contextWindowK" in patch) {
      setModelFeedback(null);
    }
    setRuntimeConfigs((current) =>
      current.map((config) =>
        config.id === selectedRuntimeConfig.id
          ? {
              ...config,
              models: config.models.map((model) =>
                model.id === modelId ? { ...model, ...patch } : model,
              ),
            }
          : config,
      ),
    );
  };

  const copySelectedConfigPath = async () => {
    const filePath = selectedRuntimeConfig?.filePath;
    if (!filePath || !navigator.clipboard) {
      setCopyConfigPathState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(filePath);
      setCopyConfigPathState("copied");
    } catch {
      setCopyConfigPathState("failed");
    }
  };

  const startCreateProvider = () => {
    setAgentChoiceOpen(true);
    setDraftAgentSdk(null);
    setApiKeyVisible(false);
    setLocalAuthStatus(null);
    setRuntimeFeedback(null);
    setModelFeedback(null);
  };

  const chooseDraftAgent = (sdk: RuntimeSdk) => {
    setDraftAgentSdk(sdk);
    setRuntimeFeedback(null);
    setModelFeedback(null);
  };

  const createDraftAgent = (sdk: RuntimeSdk, authMode: RuntimeAuthMode) => {
    const supportedAuthMode = sdk === "claudecode" ? "apiKey" : authMode;
    const draftId = `draft-${Date.now()}`;
    const nextConfig: RuntimeConfig = {
      id: draftId,
      fileName: "保存后生成UUID.json",
      name: nextUnnamedConfigName(runtimeConfigs),
      sdk,
      authMode: supportedAuthMode,
      baseUrl: supportedAuthMode === "apiKey" ? defaultApiBaseUrl(sdk) : "",
      apiKey: "",
      models: [{
        id: `${draftId}-model-1`,
        name: "",
        contextWindowK: newRuntimeModelContext({ sdk, authMode: supportedAuthMode }),
      }],
    };
    setRuntimeConfigs((current) => [...current, nextConfig]);
    setSelectedConfigId(nextConfig.id);
    setAgentChoiceOpen(false);
    setDraftAgentSdk(null);
    setLocalAuthStatus(null);
    setRuntimeFeedback(null);
  };

  const deleteRuntimeConfigWithConfirmation = async (targetConfig: RuntimeConfig) => {
    if (runtimeConfigs.length <= 1) return;
    if (isDraftRuntimeConfig(targetConfig)) {
      const remainingConfigs = runtimeConfigs.filter((config) => config.id !== targetConfig.id);
      setRuntimeConfigs(remainingConfigs);
      setSelectedConfigId(remainingConfigs[0]?.id ?? "");
      setApiKeyVisible(false);
      setLocalAuthStatus(null);
      setConfigPendingDelete(null);
      setRuntimeFeedback("已删除未保存的供应商草稿");
      return;
    }
    setIsSaving(true);
    try {
      const snapshot = await deleteAgentRuntimeConfig(targetConfig.id);
      const configs = snapshot.configs.map(withPreservedModelOrder);
      setRuntimeConfigs(configs);
      setRoleConfigs(roleConfigMap(snapshot.roles));
      setRoleModels(roleModelMap(snapshot.roles));
      setRoleEnabled(roleEnabledMap(snapshot.roles));
      setRoleReasoningEfforts(roleReasoningEffortMap(snapshot.roles));
      setPersistedRuntimeConfigs(configs);
      setSelectedConfigId(configs[0]?.id ?? "");
      setApiKeyVisible(false);
      setLocalAuthStatus(null);
      setConfigPendingDelete(null);
      setRuntimeFeedback("已删除当前供应商配置");
    } catch (error) {
      setRuntimeFeedback(error instanceof Error ? error.message : "删除供应商配置失败");
    } finally {
      setIsSaving(false);
    }
  };

  const addModel = () => {
    if (!selectedRuntimeConfig) return;
    const unfinishedModel = selectedRuntimeConfig.models.find((model) => !model.name.trim());
    if (unfinishedModel) return;
    updateSelectedRuntimeConfig({
      models: [
        {
          id: `${selectedRuntimeConfig.id}-model-${Date.now()}`,
          name: "",
          contextWindowK: newRuntimeModelContext(selectedRuntimeConfig),
        },
        ...selectedRuntimeConfig.models,
      ],
    });
    setModelFeedback(null);
  };

  const deleteModel = (modelId: string) => {
    if (!selectedRuntimeConfig) return;
    const usedBy = rolesUsingModel(selectedRuntimeConfig.id, modelId);
    if (usedBy.length > 0) {
      showModelFeedback(`${usedBy.map((role) => role.label).join("、")} 正在使用该模型，请先调整角色绑定。`, "error");
      return;
    }
    updateSelectedRuntimeConfig({
      models: selectedRuntimeConfig.models.filter((model) => model.id !== modelId),
    });
    setModelFeedback(null);
  };

  const saveRuntimeConfig = async (targetConfig: RuntimeConfig) => {
    const validationError = runtimeConfigValidationError(runtimeConfigs, targetConfig);
    if (validationError) {
      if (targetConfig.id === selectedRuntimeConfig?.id) {
        if (validationError.scope === "runtime") setRuntimeFeedback(validationError.message);
        else showModelFeedback(validationError.message, "error");
      }
      return;
    }
    const normalizedConfig = {
      ...targetConfig,
      name: targetConfig.name.trim(),
      models: targetConfig.models.map((model) => modelForSave(targetConfig, {
        ...model,
        name: model.name.trim(),
      })),
    };
    const submittedVersion = runtimeConfigVersion(normalizedConfig);
    setIsSaving(true);
    try {
      const savedConfig = isDraftRuntimeConfig(normalizedConfig)
        ? await createAgentRuntimeConfig({
            name: normalizedConfig.name,
            sdk: normalizedConfig.sdk,
            authMode: normalizedConfig.authMode,
            baseUrl: normalizedConfig.baseUrl,
            apiKey: normalizedConfig.apiKey,
            models: normalizedConfig.models,
          })
        : await updateAgentRuntimeConfig(normalizedConfig.id, normalizedConfig);
      const savedConfigWithOrder = withPreservedModelOrder(savedConfig);
      setRuntimeConfigs((current) => current.map((config) => {
        if (config.id !== targetConfig.id) return config;
        if (runtimeConfigVersion(config) === submittedVersion) return savedConfigWithOrder;
        return isDraftRuntimeConfig(config)
          ? { ...config, id: savedConfigWithOrder.id, fileName: savedConfigWithOrder.fileName, filePath: savedConfigWithOrder.filePath }
          : config;
      }));
      setPersistedRuntimeConfigs((current) => {
        const targetIndex = current.findIndex((config) => config.id === targetConfig.id || config.id === savedConfigWithOrder.id);
        if (targetIndex < 0) return [...current, savedConfigWithOrder];
        return current.map((config, index) => index === targetIndex ? savedConfigWithOrder : config);
      });
      setSelectedConfigId((current) => current === targetConfig.id ? savedConfigWithOrder.id : current);
      failedAutoSaveVersionsRef.current.delete(targetConfig.id);
      setRuntimeFeedback(null);
      setModelFeedback(null);
    } catch (error) {
      failedAutoSaveVersionsRef.current.set(targetConfig.id, submittedVersion);
      setRuntimeFeedback(error instanceof Error ? error.message : "保存供应商配置失败");
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (isLoading || isSaving) return;
    if (selectedRuntimeConfig) {
      const persistedSelected = persistedRuntimeConfigs.find((config) => config.id === selectedRuntimeConfig.id) ?? null;
      if (runtimeConfigHasChanges(selectedRuntimeConfig, persistedSelected)) {
        const validationError = runtimeConfigValidationError(runtimeConfigs, selectedRuntimeConfig);
        if (validationError?.scope === "runtime") setRuntimeFeedback(validationError.message);
        if (
          validationError?.scope === "model"
          && selectedRuntimeConfig.models.every((model) => model.name.trim())
        ) {
          showModelFeedback(validationError.message, "error");
        }
      }
    }
    const nextConfig = runtimeConfigs.find((config) => {
      const persisted = persistedRuntimeConfigs.find((item) => item.id === config.id) ?? null;
      if (!runtimeConfigHasChanges(config, persisted)) return false;
      if (runtimeConfigValidationError(runtimeConfigs, config)) return false;
      return failedAutoSaveVersionsRef.current.get(config.id) !== runtimeConfigVersion(config);
    });
    if (!nextConfig) return;
    const timer = window.setTimeout(() => {
      void saveRuntimeConfig(nextConfig);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [isLoading, isSaving, persistedRuntimeConfigs, runtimeConfigs, selectedRuntimeConfig]);

  const refreshSelectedRuntimeModels = async () => {
    if (!selectedRuntimeConfig) return;
    if (!canRefreshAvailableModels(selectedRuntimeConfig)) {
      showModelFeedback("当前供应商不支持刷新可用模型。", "info");
      return;
    }
    setIsRefreshingModels(true);
    showModelFeedback("正在获取可用模型列表...");
    try {
      const result = await refreshAgentRuntimeModels(selectedRuntimeConfig.id, {
        config: selectedRuntimeConfig,
      });
      const existingModelsByName = new Map(
        selectedRuntimeConfig.models
          .filter((model) => model.name.trim())
          .map((model) => [model.name.trim(), model]),
      );
      const discoveredChoices = result.models.map((model) => {
        const existingModel = existingModelsByName.get(model.name.trim());
        const { contextWindowK: discoveredContextWindowK, ...discoveredModel } = model;
        const contextWindowK = discoveredContextWindowK ?? existingModel?.contextWindowK;
        return {
          ...existingModel,
          ...discoveredModel,
          ...(contextWindowK === undefined ? {} : { contextWindowK }),
          id: existingModel?.id ?? model.id,
          name: model.name,
          selected: Boolean(existingModel),
          existing: Boolean(existingModel),
        };
      });
      const discoveredNames = new Set(discoveredChoices.map((model) => model.name.trim()));
      const historicalChoices = selectedRuntimeConfig.models
        .filter((model) => model.name.trim() && !discoveredNames.has(model.name.trim()))
        .map((model) => ({ ...model, selected: true, existing: true }));
      const choices = uniqueModels([...discoveredChoices, ...historicalChoices])
        .filter((model) => model.name.trim()).sort((left, right) => {
        if (left.existing !== right.existing) return left.existing ? -1 : 1;
        return right.name.localeCompare(left.name);
      });
      if (choices.length === 0) {
        showModelFeedback("提供商未返回可用模型。", "error");
        return;
      }
      setAvailableModelChoices(choices);
      setCollapsedModelGroups({ configured: false, new: false });
      setAvailableModelSearchQuery("");
      setAvailableModelsDialogOpen(true);
      setModelFeedback(null);
    } catch (error) {
      showModelFeedback(error instanceof Error ? error.message : "刷新可用模型失败", "error");
    } finally {
      setIsRefreshingModels(false);
    }
  };

  const toggleAvailableModel = (modelId: string) => {
    setAvailableModelChoices((current) => current?.map((model) =>
      model.id === modelId ? { ...model, selected: !model.selected } : model,
    ) ?? null);
  };

  const updateAvailableModelContext = (modelId: string, contextWindowK: number | null) => {
    setAvailableModelChoices((current) => current?.map((model) =>
      model.id === modelId ? { ...model, contextWindowK } : model,
    ) ?? null);
  };

  const toggleAllNewModels = () => {
    setAvailableModelChoices((current) => {
      if (!current) return current;
      const newModels = current.filter((model) => !model.existing);
      const shouldSelect = newModels.some((model) => !model.selected);
      return current.map((model) => model.existing ? model : { ...model, selected: shouldSelect });
    });
  };

  const applyAvailableModels = () => {
    if (!selectedRuntimeConfig || !availableModelChoices) return;
    const selectedModels = availableModelChoices.filter((model) => model.selected).map(({ selected: _selected, existing: _existing, ...model }) => model);
    if (selectedModels.length === 0) {
      showModelFeedback("请至少选择一个模型。", "error");
      return;
    }
    const existingModelIds = new Set(selectedRuntimeConfig.models.map((model) => model.id));
    const selectedModelIds = new Set(selectedModels.map((model) => model.id));
    const addedModels = selectedModels.filter((model) => !existingModelIds.has(model.id));
    const retainedModels = selectedRuntimeConfig.models.filter((model) => selectedModelIds.has(model.id));
    updateSelectedRuntimeConfig({ models: [...addedModels, ...retainedModels] });
    setAvailableModelsDialogOpen(false);
    setAvailableModelChoices(null);
    showModelFeedback(`已加入 ${selectedModels.length} 个模型。`, "success");
  };

  const testSelectedRuntimeModel = async (model: RuntimeModel) => {
    if (!selectedRuntimeConfig) return;
    if (!canTestRuntimeModel(selectedRuntimeConfig)) {
      showModelFeedback("本地账号登录态只检测登录状态，不发起模型请求。", "info");
      return;
    }
    const modelName = model.name.trim();
    if (!modelName) {
      showModelFeedback("请先填写要测试的模型名称。", "error");
      return;
    }
    const contextError = modelContextValidationError(selectedRuntimeConfig, model);
    if (contextError) {
      showModelFeedback(contextError, "error");
      return;
    }
    setTestingModelId(model.id);
    showModelFeedback(`正在测试 ${modelName}...`);
    try {
      const result = await testAgentRuntimeConnection(selectedRuntimeConfig.id, {
        model: modelName,
        config: selectedRuntimeConfig,
      });
      if (result.ok) {
        const cost = typeof result.totalCostUsd === "number" ? ` · $${result.totalCostUsd.toFixed(6)}` : "";
        showModelFeedback(`连接成功 · ${result.model} · ${result.latencyMs}ms${cost}`, "success");
      } else {
        showModelFeedback(`${result.code ? `${result.code}: ` : ""}${result.message}`, "error");
      }
    } catch (error) {
      showModelFeedback(error instanceof Error ? error.message : "测试连接失败", "error");
    } finally {
      setTestingModelId(null);
    }
  };

  const checkSelectedLocalAuth = async () => {
    if (!selectedRuntimeConfig) return;
    if (selectedRuntimeConfig.sdk !== "codex" || selectedRuntimeConfig.authMode !== "inherited") {
      setLocalAuthStatus({
        sdk: selectedRuntimeConfig.sdk,
        status: "unsupported",
        message: "只有 Codex 官方登录态支持本地登录检测。",
      });
      return;
    }
    setIsCheckingLocalAuth(true);
    setLocalAuthStatus(null);
    setRuntimeFeedback(null);
    try {
      const result = await checkAgentRuntimeLocalAuth(selectedRuntimeConfig.id, {
        config: selectedRuntimeConfig,
      });
      setLocalAuthStatus(result);
    } catch (error) {
      setLocalAuthStatus({
        sdk: selectedRuntimeConfig.sdk,
        status: "invalid",
        message: error instanceof Error ? error.message : "检测本地登录态失败",
      });
    } finally {
      setIsCheckingLocalAuth(false);
    }
  };

  const applyRoleSelection = async (role: AgentRole, config: RuntimeConfig, model: RuntimeModel) => {
    const previousConfigId = roleConfigs[role];
    const previousModelId = roleModels[role];
    const previousReasoningEffort = roleReasoningEfforts[role];
    const nextReasoningEffort = normalizeReasoningEffortForSdk(config.sdk, previousReasoningEffort);
    setRoleConfigs((current) => ({ ...current, [role]: config.id }));
    setRoleModels((current) => ({ ...current, [role]: model.id }));
    setRoleReasoningEfforts((current) => ({ ...current, [role]: nextReasoningEffort }));
    setOpenPickerRole(null);
    setPreviewConfigId(null);
    try {
      await updateAgentRuntimeRole(role, {
        configId: config.id,
        modelId: model.id,
        enabled: roleEnabled[role],
        reasoningEffort: nextReasoningEffort,
      });
      setRuntimeFeedback(null);
    } catch (error) {
      setRoleConfigs((current) => ({ ...current, [role]: previousConfigId }));
      setRoleModels((current) => ({ ...current, [role]: previousModelId }));
      setRoleReasoningEfforts((current) => ({ ...current, [role]: previousReasoningEffort }));
      setRuntimeFeedback(error instanceof Error ? error.message : "更新角色配置失败");
    }
  };

  const updateRoleEnabled = async (role: AgentRole, enabled: boolean) => {
    const previousEnabled = roleEnabled[role];
    const boundConfig = savedRuntimeConfigs.find((config) => config.id === roleConfigs[role])
      ?? savedRuntimeConfigs[0]
      ?? null;
    const boundModel = boundModelOf(boundConfig, roleModels[role]);
    if (enabled && (!boundConfig || !boundModel)) {
      selectRole(role);
      setRuntimeFeedback("请先在“供应商管理”中新增供应商和模型，再启用角色。");
      return;
    }
    setRoleEnabled((current) => ({ ...current, [role]: enabled }));
    selectRole(role);
    try {
      await updateAgentRuntimeRole(role, {
        enabled,
        configId: roleConfigs[role],
        modelId: roleModels[role],
        reasoningEffort: roleReasoningEfforts[role],
      });
      setRuntimeFeedback(null);
    } catch (error) {
      setRoleEnabled((current) => ({ ...current, [role]: previousEnabled }));
      setRuntimeFeedback(error instanceof Error ? error.message : "更新角色状态失败");
    }
  };

  const updateRoleReasoningEffort = async (role: AgentRole, reasoningEffort: string) => {
    const previousReasoningEffort = roleReasoningEfforts[role];
    setRoleReasoningEfforts((current) => ({ ...current, [role]: reasoningEffort }));
    selectRole(role);
    try {
      await updateAgentRuntimeRole(role, {
        enabled: roleEnabled[role],
        configId: roleConfigs[role],
        modelId: roleModels[role],
        reasoningEffort,
      });
      setRuntimeFeedback(null);
    } catch (error) {
      setRoleReasoningEfforts((current) => ({ ...current, [role]: previousReasoningEffort }));
      setRuntimeFeedback(error instanceof Error ? error.message : "更新角色 Effort 失败");
    }
  };

  return (
    <div className="min-h-0 space-y-5">
      <div className="inline-flex rounded-lg border border-border bg-card p-1">
        <button
          type="button"
          className={agentTabButtonClass(agentTab === "role_assignment")}
          onClick={() => setAgentTab("role_assignment")}
        >
          角色配置
        </button>
        <button
          type="button"
          className={agentTabButtonClass(agentTab === "runtime_configs")}
          onClick={() => setAgentTab("runtime_configs")}
        >
          供应商管理
        </button>
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
          正在加载智能体配置...
        </div>
      ) : null}

      {loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-5 py-4 text-sm text-destructive">
          {loadError}
        </div>
      ) : null}

      {!isLoading && agentTab === "role_assignment" ? (
        <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="self-start overflow-hidden rounded-lg border border-border bg-card">
            {savedRuntimeConfigs.every((config) => usableModels(config).length === 0) ? (
              <div className="border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                请先在“供应商管理”中新增供应商和模型，再启用 Expert 角色。
              </div>
            ) : null}
            <div className="grid grid-cols-[minmax(150px,1fr)_minmax(210px,280px)_112px_88px] gap-3 border-b border-border bg-muted/40 px-4 py-3 text-xs font-semibold text-muted-foreground">
              <span>角色</span>
              <span>默认模型（供应商 / 模型）</span>
              <span>Effort</span>
              <span className="text-right">状态</span>
            </div>
            {runtimeFeedback ? (
              <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive" aria-live="polite">
                {runtimeFeedback}
              </div>
            ) : null}
            {roleDefinitions.map((role) => {
              const boundConfig = savedRuntimeConfigs.find((config) => config.id === roleConfigs[role.role]) ?? savedRuntimeConfigs[0];
              const boundModel = boundModelOf(boundConfig, roleModels[role.role]);
              const hasRoleBinding = Boolean(boundConfig && boundModel);
              const effortOptions = reasoningEffortOptionsForSdk(boundConfig?.sdk ?? "claudecode");
              const boundReasoningEffort = normalizeReasoningEffortForSdk(
                boundConfig?.sdk ?? "claudecode",
                roleReasoningEfforts[role.role],
              );
              const pickerOpen = openPickerRole === role.role;
              return (
                <div key={role.id} className="border-b border-border last:border-b-0">
                  <div
                    data-selected={selectedRole.role === role.role}
                    className="grid grid-cols-[minmax(150px,1fr)_minmax(210px,280px)_112px_88px] items-center gap-3 border-l-2 border-l-transparent px-4 py-4 transition-colors hover:border-l-primary/50 hover:bg-muted/30 data-[selected=true]:border-l-primary data-[selected=true]:bg-primary/10"
                  >
                    <button
                      type="button"
                      onClick={() => selectRole(role.role)}
                      className="flex min-w-0 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span
                        data-selected={selectedRole.role === role.role}
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground data-[selected=true]:border-primary/50 data-[selected=true]:text-primary"
                      >
                        <role.Icon className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-foreground">{role.label}</span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">{role.description}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`选择 ${role.label} 模型`}
                      data-open={pickerOpen}
                      disabled={!boundConfig}
                      onClick={() => togglePicker(role.role)}
                      className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[open=true]:border-primary/60 data-[open=true]:bg-primary/10"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {boundConfig ? <AgentIcon sdk={boundConfig.sdk} /> : null}
                        <span className="truncate">
                          {configDisplayName(boundConfig)}
                          {" / "}
                          <span className="font-mono">{boundModel?.name ?? "未配置"}</span>
                        </span>
                      </span>
                      {pickerOpen
                        ? <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
                        : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
                    </button>
                    <Select
                      value={boundReasoningEffort}
                      disabled={!hasRoleBinding}
                      onValueChange={(value) => {
                        if (value) void updateRoleReasoningEffort(role.role, value);
                      }}
                    >
                      <SelectTrigger className="h-9 w-full px-2.5 text-xs" aria-label={`选择 ${role.label} Effort`}>
                        <SelectValue>
                          {reasoningEffortLabelForSdk(boundConfig?.sdk ?? "claudecode", boundReasoningEffort)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {effortOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex justify-end">
                      {role.fixedEnabled ? (
                        <Badge variant="secondary">固定启用</Badge>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {roleEnabled[role.role] ? "启用" : hasRoleBinding ? "关闭" : "需配置"}
                          </span>
                          <Switch
                            checked={roleEnabled[role.role]}
                            disabled={!roleEnabled[role.role] && !hasRoleBinding}
                            onCheckedChange={(checked) => void updateRoleEnabled(role.role, checked)}
                            aria-label={`${role.label} 状态`}
                            title={!hasRoleBinding ? "请先配置供应商和模型" : undefined}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {pickerOpen ? (
                    <RoleModelPicker
                      configs={savedRuntimeConfigs}
                      boundConfigId={boundConfig?.id ?? ""}
                      boundModelId={roleModels[role.role]}
                      previewConfigId={previewConfigId}
                      onPreview={setPreviewConfigId}
                      onSelect={(config, model) => void applyRoleSelection(role.role, config, model)}
                    />
                  ) : null}
                </div>
              );
            })}
          </section>

          <aside className="self-start rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
                  <SelectedRoleIcon className="size-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-foreground">{selectedRole.label}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">角色配置详情</p>
                </div>
              </div>
              <Badge variant={roleEnabled[selectedRole.role] ? "secondary" : "outline"}>
                {selectedRole.fixedEnabled ? "固定启用" : roleEnabled[selectedRole.role] ? "启用" : "关闭"}
              </Badge>
            </div>

            <div className="mt-5 space-y-4 text-sm">
              <div>
                <div className="text-xs font-medium text-muted-foreground">System Prompt</div>
                <div className="mt-2 rounded-lg border border-border bg-background/60 px-3 py-3 text-xs leading-5 text-foreground">
                  <p>{promptPreview(selectedRole.systemPrompt, false)}</p>
                  {selectedRole.systemPrompt.length > SYSTEM_PROMPT_PREVIEW_LENGTH ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 h-7 gap-1.5 px-2.5 text-xs"
                      onClick={() => setPromptDialogOpen(true)}
                    >
                      <FileText className="size-3.5" />
                      展开查看全文
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-t border-border pt-4">
                <span className="text-xs text-muted-foreground">Agent</span>
                <span className="flex items-center gap-1.5 text-xs text-foreground">
                  {selectedRoleConfig ? <AgentIcon sdk={selectedRoleConfig.sdk} /> : null}
                  {selectedRoleConfig ? runtimeSdkLabel(selectedRoleConfig.sdk) : "未配置"}
                </span>
                <span className="text-xs text-muted-foreground">供应商</span>
                <span className="truncate text-xs text-foreground">{configDisplayName(selectedRoleConfig)}</span>
                <span className="text-xs text-muted-foreground">默认模型</span>
                <span className="truncate font-mono text-xs text-foreground">{selectedRoleModel?.name ?? "未配置"}</span>
                <span className="text-xs text-muted-foreground">Effort</span>
                <span className="text-xs text-foreground">
                  {selectedRoleConfig && selectedRoleReasoningEffort
                    ? reasoningEffortLabelForSdk(selectedRoleConfig.sdk, selectedRoleReasoningEffort)
                    : "未配置"}
                </span>
                <span className="text-xs text-muted-foreground">配置文件</span>
                <span className="truncate font-mono text-xs text-foreground">{selectedRoleConfig?.fileName ?? "未配置"}</span>
              </div>
              <Button variant="outline" className="w-full justify-center" onClick={openSelectedRoleConfig} disabled={!selectedRoleConfig}>
                打开供应商配置
              </Button>
            </div>
          </aside>
          <Dialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen}>
            <DialogContent className="max-h-[min(760px,calc(100vh-3rem))] !max-w-4xl gap-0 overflow-hidden p-0">
              <DialogHeader className="border-b border-border px-5 py-4 pr-12">
                <DialogTitle className="flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" />
                  {selectedRole.label} · system-prompt.md
                </DialogTitle>
              </DialogHeader>
              <div className="max-h-[calc(min(760px,100vh-3rem)-64px)] overflow-auto bg-[var(--ui-surface-sunken)] px-6 py-5">
                <article className="mx-auto max-w-3xl rounded-xl border border-border bg-card px-6 py-5 shadow-sm">
                  <MessageResponse className="sf-markdown-document max-w-none text-sm leading-6">
                    {selectedRole.systemPrompt}
                  </MessageResponse>
                </article>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      ) : !isLoading ? (
        <div className="grid min-h-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section className="self-start overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">供应商</h3>
              <Button variant="outline" size="sm" onClick={startCreateProvider} disabled={isSaving}>
                新建
              </Button>
            </div>
            {AGENT_ORDER.map((sdk) => {
              const group = runtimeConfigs.filter((config) => config.sdk === sdk);
              if (group.length === 0) return null;
              return (
                <div key={sdk}>
                  <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2.5 text-[11px] font-medium text-muted-foreground">
                    <AgentIcon sdk={sdk} className="size-5" />
                    {AGENT_META[sdk].label}
                    <span className="text-muted-foreground/70">· {AGENT_META[sdk].format}</span>
                  </div>
                  {group.map((config) => (
                    <button
                      key={config.id}
                      type="button"
                      data-selected={!agentChoiceOpen && selectedRuntimeConfig?.id === config.id}
                      className="group flex w-full items-center gap-3 border-b border-l-2 border-b-border border-l-transparent px-4 py-3.5 text-left transition-colors last:border-b-0 hover:border-l-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[selected=true]:border-l-primary data-[selected=true]:bg-primary/10"
                      onClick={() => {
                        setSelectedConfigId(config.id);
                        setAgentChoiceOpen(false);
                        setDraftAgentSdk(null);
                        setApiKeyVisible(false);
                        setLocalAuthStatus(null);
                        setRuntimeFeedback(null);
                        setModelFeedback(null);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                        {configDisplayName(config)}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </section>

          {agentChoiceOpen ? (
            <section className="self-start rounded-lg border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">新建供应商</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {draftAgentSdk
                      ? draftAgentSdk === "claudecode"
                        ? "Claude Code 仅支持 API Key；创建后可在详情中调整连接信息。"
                        : "选择认证方式。创建后仍可在详情中调整连接信息。"
                      : "先选择 Agent 运行时。它决定供应商的接口格式，创建后不可更改。"}
                  </p>
                </div>
                {draftAgentSdk ? (
                  <Button variant="ghost" size="sm" onClick={() => setDraftAgentSdk(null)}>
                    <ChevronLeft className="size-4" />
                    返回
                  </Button>
                ) : null}
              </div>
              {!draftAgentSdk ? (
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {AGENT_ORDER.map((sdk) => (
                    <button
                      key={sdk}
                      type="button"
                      onClick={() => chooseDraftAgent(sdk)}
                      className="rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <AgentIcon sdk={sdk} />
                        {AGENT_META[sdk].label}
                      </span>
                      <span className="mt-2 block text-xs text-muted-foreground">{AGENT_META[sdk].format}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{AGENT_META[sdk].hint}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background/60 px-3 text-xs text-foreground">
                    <AgentIcon sdk={draftAgentSdk} />
                    {runtimeSdkLabel(draftAgentSdk)}
                    <span className="text-muted-foreground">· {AGENT_META[draftAgentSdk].format}</span>
                  </div>
                  <div className={`grid gap-3 ${draftAgentSdk === "codex" ? "md:grid-cols-2" : ""}`}>
                    {draftAgentSdk === "codex" ? (
                      <button
                        type="button"
                        onClick={() => createDraftAgent(draftAgentSdk, "inherited")}
                        className="rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
                      >
                        <span className="block text-sm font-semibold text-foreground">{localAuthModeLabel(draftAgentSdk)}</span>
                        <span className="mt-2 block text-xs text-muted-foreground">复用本机已登录的账号，不在此处填写 API Key。</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => createDraftAgent(draftAgentSdk, "apiKey")}
                      className="rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
                    >
                      <span className="block text-sm font-semibold text-foreground">自定义 API Key</span>
                      <span className="mt-2 block text-xs text-muted-foreground">填写 Base URL 与 API Key，可通过标准 GET /models 获取模型元数据。</span>
                    </button>
                  </div>
                </div>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="mt-4"
                onClick={() => {
                  setAgentChoiceOpen(false);
                  setDraftAgentSdk(null);
                }}
              >
                取消
              </Button>
            </section>
          ) : selectedRuntimeConfig ? (
            <>
              <section key={selectedRuntimeConfig.id} className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
                  <AgentIcon sdk={selectedRuntimeConfig.sdk} className="size-7" />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-foreground">{configDisplayName(selectedRuntimeConfig)}</h3>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {runtimeSdkLabel(selectedRuntimeConfig.sdk)} · {AGENT_META[selectedRuntimeConfig.sdk].format}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isSaving ? <span className="text-xs text-muted-foreground">自动保存中…</span> : null}
                {selectedRuntimeConfig.filePath ? (
                  <Button variant="outline" size="sm" onClick={() => void copySelectedConfigPath()}>
                    {copyConfigPathState === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copyConfigPathState === "copied" ? "已复制路径" : copyConfigPathState === "failed" ? "复制失败" : "复制配置路径"}
                  </Button>
                ) : null}
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfigPendingDelete(selectedRuntimeConfig)}
                  disabled={runtimeConfigs.length <= 1 || isSaving}
                  title={runtimeConfigs.length <= 1 ? "至少保留一个供应商配置" : "删除前会再次确认"}
                >
                  <Trash2 className="size-4" />
                  删除
                </Button>
              </div>
            </div>
            {runtimeFeedback ? (
              <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
                {runtimeFeedback}
              </div>
            ) : null}

            <div className="mt-5 grid gap-4">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">配置名称</span>
                <Input
                  value={selectedRuntimeConfig.name}
                  name="squadflow-runtime-config-name"
                  autoComplete="off"
                  onChange={(event) => {
                    updateSelectedRuntimeConfig({ name: sanitizeConfigNameInput(event.target.value) });
                    setRuntimeFeedback(null);
                  }}
                />
              </label>
              {selectedRuntimeConfig.sdk === "codex" && selectedRuntimeConfig.authMode === "inherited" ? (
                <div className="rounded-lg border border-border bg-background/60 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">本地登录态</div>
                      <div className="mt-1 text-xs text-muted-foreground">复用本机官方 runtime 登录态；不会把账号 token 写入 SquadFlow 配置。</div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void checkSelectedLocalAuth()}
                      disabled={isCheckingLocalAuth}
                    >
                      {isCheckingLocalAuth ? "检测中" : "检测登录态"}
                    </Button>
                  </div>
                  {localAuthStatus ? (
                    <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${localAuthStatusClass(localAuthStatus.status)}`} aria-live="polite">
                      <div>{localAuthStatus.accountHint ? `${localAuthStatus.message}（${localAuthStatus.accountHint}）` : localAuthStatus.message}</div>
                      {localAuthStatus.path ? (
                        <div className="mt-1 truncate font-mono opacity-80">{localAuthStatus.path}</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {selectedRuntimeConfig.sdk === "claudecode" || selectedRuntimeConfig.authMode !== "inherited" ? (
                <>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Base URL</span>
                    <Input
                      value={selectedRuntimeConfig.baseUrl}
                      placeholder={defaultApiBaseUrl(selectedRuntimeConfig.sdk)}
                      name="squadflow-runtime-base-url"
                      autoComplete="off"
                      inputMode="url"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      data-form-type="other"
                      onChange={(event) => updateSelectedRuntimeConfig({ baseUrl: event.target.value })}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">API Key</span>
                    <span className="relative block">
                      <Input
                        value={selectedRuntimeConfig.apiKey}
                        type="text"
                        name="squadflow-runtime-api-token"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-form-type="other"
                        style={apiKeyVisible ? undefined : maskedTextStyle}
                        onChange={(event) => updateSelectedRuntimeConfig({ apiKey: event.target.value })}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2"
                        onClick={() => setApiKeyVisible((visible) => !visible)}
                        aria-label={apiKeyVisible ? "隐藏 API Key" : "显示 API Key"}
                      >
                        {apiKeyVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </Button>
                    </span>
                  </label>
                </>
              ) : null}
            </div>

            <div className="mt-5 rounded-lg border border-border bg-background/60">
              <div className="flex items-center justify-between border-b border-border px-3 py-3">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">模型列表</div>
                </div>
                <div className="flex items-center gap-2">
                  {canRefreshAvailableModels(selectedRuntimeConfig) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void refreshSelectedRuntimeModels()}
                      disabled={isSaving || isRefreshingModels}
                      title={selectedRuntimeConfig.sdk === "codex" && selectedRuntimeConfig.authMode === "inherited"
                        ? "通过 Codex app-server 查询账号可用模型，可能发起网络请求"
                        : "请求 Base URL 的标准 GET /models 接口，可能发起网络请求"}
                    >
                      {isRefreshingModels ? "获取中" : "获取模型列表"}
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={addModel}>添加模型</Button>
                </div>
              </div>
              {modelFeedback ? (
                <div className={`mx-3 mt-3 rounded-md border px-3 py-2 text-xs ${modelFeedbackClass(modelFeedbackTone)}`} aria-live="polite">
                  {modelFeedback}
                </div>
              ) : null}
              <div className="space-y-2 p-3">
                {selectedRuntimeConfig.models.map((model) => {
                  const usedBy = rolesUsingModel(selectedRuntimeConfig.id, model.id);
                  return (
                    <div
                      key={model.id}
                      className="grid grid-cols-[minmax(0,40ch)_minmax(150px,180px)_72px_auto] items-end justify-start gap-3 rounded-lg border border-border bg-card px-3 py-3"
                    >
                      <label className="min-w-0 space-y-1.5">
                        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                          模型名称
                          {usedBy.length > 0 ? (
                            <span
                              className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-normal text-primary"
                              title={usedBy.map((role) => role.label).join("、")}
                            >
                              {usedBy.length === 1 ? `${usedBy[0].label} 在用` : `${usedBy.length} 个角色在用`}
                            </span>
                          ) : null}
                        </span>
                        <Input
                          value={model.name}
                          className="min-w-0 font-mono text-xs"
                          onChange={(event) => updateSelectedModel(model.id, { name: event.target.value })}
                        />
                      </label>
                      {selectedRuntimeConfig.sdk === "claudecode" ? (
                        <label className="min-w-0 space-y-1.5">
                          <span className="text-xs font-medium text-muted-foreground">上下文窗口</span>
                          <Select
                            value={String(model.contextWindowK ?? 1_000)}
                            onValueChange={(value) => updateSelectedModel(model.id, { contextWindowK: Number(value) })}
                          >
                            <SelectTrigger className="font-mono text-xs" aria-label={`模型 ${model.name || "未命名"} 上下文窗口`}>
                              <SelectValue>{model.contextWindowK === 1_000 ? "1M" : "200K"}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {CLAUDE_CONTEXT_WINDOW_K_OPTIONS.map((value) => (
                                <SelectItem key={value} value={String(value)}>{value === 1_000 ? "1M" : "200K"}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                      ) : selectedRuntimeConfig.authMode === "inherited" ? (
                        <label className="min-w-0 space-y-1.5">
                          <span className="text-xs font-medium text-muted-foreground">上下文窗口</span>
                          <span className="relative block">
                            <Input
                              type="number"
                              min={MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K}
                              step={0.001}
                              value={typeof model.contextWindowK === "number" ? model.contextWindowK : 256}
                              className="pr-7 font-mono text-xs"
                              aria-label={`模型 ${model.name || "未命名"} 上下文窗口（K）`}
                              onChange={(event) => {
                                const value = event.target.value;
                                updateSelectedModel(model.id, {
                                  contextWindowK: value === "" ? null : Number(value),
                                });
                              }}
                            />
                            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                              K
                            </span>
                          </span>
                        </label>
                      ) : (
                        <label className="min-w-0 space-y-1.5">
                          <span className="text-xs font-medium text-muted-foreground">上下文窗口</span>
                          <span className="relative block">
                            <Input
                              type="number"
                              min={MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K}
                              step={0.001}
                              value={typeof model.contextWindowK === "number" ? model.contextWindowK : ""}
                              className="pr-7 font-mono text-xs"
                              aria-label={`模型 ${model.name || "未命名"} 上下文窗口（K）`}
                              onChange={(event) => {
                                const value = event.target.value;
                                updateSelectedModel(model.id, {
                                  contextWindowK: value === "" ? null : Number(value),
                                });
                              }}
                            />
                            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                              K
                            </span>
                          </span>
                        </label>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void testSelectedRuntimeModel(model)}
                        disabled={
                          !canTestRuntimeModel(selectedRuntimeConfig)
                          || isSaving
                          || isRefreshingModels
                          || (testingModelId !== null && testingModelId !== model.id)
                        }
                        title={
                          canTestRuntimeModel(selectedRuntimeConfig)
                            ? selectedRuntimeConfig.authMode === "inherited"
                              ? "通过 Codex app-server 发起一次临时模型请求，可能联网"
                              : undefined
                            : "本地账号登录态只检测登录状态，不发起模型请求"
                        }
                      >
                        {testingModelId === model.id ? "测试中" : "测试"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除模型 ${model.name || "未命名"}`}
                        onClick={() => deleteModel(model.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
              <Dialog open={availableModelsDialogOpen} onOpenChange={(open) => {
                setAvailableModelsDialogOpen(open);
                if (!open) setAvailableModelChoices(null);
              }}>
                <DialogContent className="!left-1/2 !top-1/2 !w-[min(760px,calc(100vw-3rem))] !max-w-none !-translate-x-1/2 !-translate-y-1/2 gap-0 overflow-hidden p-0">
                  <DialogHeader className="border-b border-border px-5 py-4">
                    <DialogTitle className="text-center text-xl">获取可用模型</DialogTitle>
                    <div className="relative mx-auto w-full max-w-xl">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="search"
                        value={availableModelSearchQuery}
                        onChange={(event) => setAvailableModelSearchQuery(event.target.value)}
                        placeholder="搜索模型名称"
                        aria-label="搜索模型"
                        className="pl-9"
                      />
                    </div>
                  </DialogHeader>
                  {availableModelChoices ? (() => {
                    const normalizedQuery = availableModelSearchQuery.trim().toLocaleLowerCase();
                    const matchesSearch = (model: RuntimeModelChoice) => !normalizedQuery
                      || model.name.toLocaleLowerCase().includes(normalizedQuery);
                    const allNewModels = availableModelChoices.filter((model) => !model.existing);
                    const configuredModels = availableModelChoices.filter((model) => model.existing && matchesSearch(model));
                    const newModels = allNewModels.filter(matchesSearch);
                    const selectedCount = availableModelChoices.filter((model) => model.selected).length;
                    const allNewSelected = allNewModels.length > 0 && allNewModels.every((model) => model.selected);
                    const renderChoice = (model: RuntimeModelChoice) => (
                      <div key={model.id} className="grid grid-cols-[minmax(0,40ch)_160px] items-center justify-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40">
                        <button
                          type="button"
                          aria-pressed={model.selected}
                          onClick={() => toggleAvailableModel(model.id)}
                          className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-muted"
                        >
                          <span className={`flex size-4 shrink-0 items-center justify-center rounded border text-[11px] ${model.selected ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                            {model.selected ? "✓" : null}
                          </span>
                          <span className="truncate font-mono text-xs">{model.name}</span>
                        </button>
                        {selectedRuntimeConfig.sdk === "claudecode" ? (
                          <Select
                            value={String(model.contextWindowK ?? 1_000)}
                            onValueChange={(value) => updateAvailableModelContext(model.id, Number(value))}
                          >
                            <SelectTrigger className="w-full font-mono text-xs" aria-label={`${model.name} 上下文窗口`}>
                              <SelectValue>{model.contextWindowK === 1_000 ? "1M" : "200K"}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {CLAUDE_CONTEXT_WINDOW_K_OPTIONS.map((value) => (
                                <SelectItem key={value} value={String(value)}>{value === 1_000 ? "1M" : "200K"}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="relative block w-full">
                            <Input
                              type="number"
                              min={MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K}
                              step={0.001}
                              value={typeof model.contextWindowK === "number" ? model.contextWindowK : 256}
                              className="pr-7 font-mono text-xs"
                              aria-label={`${model.name} 上下文窗口（K）`}
                              onChange={(event) => updateAvailableModelContext(model.id, event.target.value === "" ? null : Number(event.target.value))}
                            />
                            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">K</span>
                          </span>
                        )}
                      </div>
                    );
                    return (
                      <>
                        <div className="max-h-[280px] overflow-y-auto px-3 py-2">
                          <section className="border-b border-border pb-2">
                            <button type="button" className="flex w-full items-center justify-between px-2 py-2 text-left text-xs font-semibold" onClick={() => setCollapsedModelGroups((current) => ({ ...current, configured: !current.configured }))}>
                              <span>{collapsedModelGroups.configured ? "▸" : "⌄"} 历史已配模型 <span className="font-normal text-muted-foreground">{configuredModels.length}</span></span>
                            </button>
                            {!collapsedModelGroups.configured
                              ? configuredModels.length > 0
                                ? configuredModels.map(renderChoice)
                                : <div className="px-2 py-3 text-center text-xs text-muted-foreground">没有匹配的历史模型</div>
                              : null}
                          </section>
                          <section className="pt-2">
                            <div className="flex items-center justify-between px-2 py-2">
                              <button type="button" className="text-left text-xs font-semibold" onClick={() => setCollapsedModelGroups((current) => ({ ...current, new: !current.new }))}>
                                {collapsedModelGroups.new ? "▸" : "⌄"} 新获取模型 <span className="font-normal text-muted-foreground">{newModels.length}</span>
                              </button>
                              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={toggleAllNewModels}>
                                {allNewSelected ? "取消全选" : "全选"}
                              </button>
                            </div>
                            {!collapsedModelGroups.new
                              ? newModels.length > 0
                                ? newModels.map(renderChoice)
                                : <div className="px-2 py-3 text-center text-xs text-muted-foreground">没有匹配的新模型</div>
                              : null}
                          </section>
                        </div>
                        <div className="flex items-center justify-between border-t border-border bg-muted/30 px-5 py-3">
                          <span className="text-xs text-muted-foreground">已选 {selectedCount} 个模型</span>
                          <div className="flex gap-2"><Button variant="outline" onClick={() => setAvailableModelsDialogOpen(false)}>取消</Button><Button onClick={applyAvailableModels}>加入配置</Button></div>
                        </div>
                      </>
                    );
                  })() : null}
                </DialogContent>
              </Dialog>
              </section>
              <Dialog open={Boolean(configPendingDelete)} onOpenChange={(open) => {
                if (!open) setConfigPendingDelete(null);
              }}>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>删除供应商配置</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3 text-sm text-muted-foreground">
                    <p>
                      确认删除 <span className="font-medium text-foreground">{configDisplayName(configPendingDelete)}</span>？
                    </p>
                    {configPendingDelete ? (
                      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
                        <div className="truncate font-mono text-foreground">{configPendingDelete.fileName}</div>
                        {rolesUsingConfig(configPendingDelete.id).length > 0 ? (
                          <div className="mt-2 text-amber-500">
                            当前被 {rolesUsingConfig(configPendingDelete.id).map((role) => role.label).join("、")} 使用，删除后会自动切换到可用配置。
                          </div>
                        ) : (
                          <div className="mt-2">该操作会移除配置文件，无法从设置页撤销。</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setConfigPendingDelete(null)}>取消</Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        if (configPendingDelete) void deleteRuntimeConfigWithConfirmation(configPendingDelete);
                      }}
                      disabled={!configPendingDelete || isSaving}
                    >
                      确认删除
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </>
          ) : (
            <section className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
              暂无供应商配置。
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function AppSettingsDialog({
  open,
  onOpenChange,
  initialSection = "general",
  initialAgentTab = "role_assignment",
}: AppSettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>("general");

  useEffect(() => {
    if (open) setSection(initialSection);
  }, [initialSection, open]);

  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="!left-4 !top-4 grid !h-[calc(100vh-2rem)] !w-[calc(100vw-2rem)] !max-w-none !translate-x-0 !translate-y-0 grid-cols-[180px_minmax(0,1fr)] gap-0 overflow-hidden rounded-xl border border-border bg-background p-0"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>
        <aside className="flex min-h-0 flex-col border-r border-sidebar-border bg-sidebar p-4 text-sidebar-foreground">
          <Button
            variant="ghost"
            className="mb-6 h-9 justify-start gap-2 text-muted-foreground hover:text-sidebar-foreground"
            onClick={() => onOpenChange(false)}
          >
            <ChevronLeft className="size-4" />
            返回工作区
          </Button>
          <nav className="space-y-1">
            <button type="button" className={sectionButtonClass(section === "general")} onClick={() => setSection("general")}>
              <SlidersHorizontal className="size-4" />
              常规
            </button>
            <button type="button" className={sectionButtonClass(section === "agents")} onClick={() => setSection("agents")}>
              <Bot className="size-4" />
              智能体设置
            </button>
          </nav>
        </aside>

        <main className="min-h-0 overflow-auto bg-background px-8 py-8">
          <div className="mx-auto max-w-6xl">
            <div className="mb-8">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Settings2 className="size-4" />
                设置
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-normal text-foreground">
                {section === "general" ? "常规" : "智能体设置"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {section === "general"
                  ? "管理应用外观、显示偏好和工作区操作。"
                  : section === "agents"
                    ? "为每个角色绑定「供应商 / 模型」，并按 Agent 管理供应商连接。"
                  : "为每个角色绑定「供应商 / 模型」，并按 Agent 管理供应商连接。"}
              </p>
            </div>
            {section === "general" ? <GeneralSettings /> : <AgentSettings initialTab={initialAgentTab} />}
          </div>
        </main>
      </DialogContent>
    </Dialog>
  );
}
