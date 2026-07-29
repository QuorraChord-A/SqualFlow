'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  Search,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useFlowStore } from '../stores/useFlowStore';
import { useProjectStore } from '../stores/useProjectStore';
import type { Project } from '../types';
import { wsClient } from '../lib/ws';
import LeaderModelSelector from './LeaderModelSelector';
import ComposerModeMenu, { type PlanApproval, type RiskMode } from './ComposerModeMenu';
import BrowserElementAttachments from './BrowserElementAttachments';
import MessageImageAttachments from './MessageImageAttachments';
import { PromptInput } from '@/components/ai-elements-official/prompt-input';
import {
  browserElementsToOutgoingAttachments,
  useBrowserSelectionStore,
} from '../stores/useBrowserSelectionStore';
import { useComposerImageStore } from '../stores/useComposerImageStore';
import {
  imageAttachmentFromFile,
  outgoingImageAttachment,
  type MessageImageAttachment,
} from '../types/messageAttachments';
import { useNativeContextSlashMenu } from '../hooks/useNativeContextSlashMenu';

interface NewTaskViewProps {
  onTaskCreated?: (
    flowId: string,
    initialMessage: UIMessage,
    initialPlanModeReturnRiskMode: RiskMode | null,
  ) => void;
  onOpenModelSettings?: () => void;
}

export const NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY = 'squadflow-new-task-leader-runtime-selection';
export const NEW_TASK_MODE_DEFAULTS_STORAGE_KEY = 'squadflow-new-task-mode-defaults';

type NewTaskLeaderRuntimeSelection = {
  configId: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
};

type NewTaskModeDefaults = {
  riskMode: RiskMode;
  planApproval: PlanApproval;
};

function readNewTaskModeDefaults(): NewTaskModeDefaults {
  if (typeof window === 'undefined') return { riskMode: 'auto_edit', planApproval: 'on' };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NEW_TASK_MODE_DEFAULTS_STORAGE_KEY) ?? 'null') as Partial<NewTaskModeDefaults> | null;
    return {
      riskMode: parsed?.riskMode === 'full_access' ? 'full_access' : 'auto_edit',
      planApproval: parsed?.planApproval === 'off' ? 'off' : 'on',
    };
  } catch {
    return { riskMode: 'auto_edit', planApproval: 'on' };
  }
}

function writeNewTaskModeDefaults(defaults: NewTaskModeDefaults) {
  try {
    window.localStorage.setItem(NEW_TASK_MODE_DEFAULTS_STORAGE_KEY, JSON.stringify(defaults));
  } catch {
    // Keep the in-memory defaults when browser storage is unavailable.
  }
}

function readNewTaskLeaderRuntimeSelection() {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY) ?? 'null') as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && 'configId' in parsed
      && 'modelId' in parsed
      && typeof parsed.configId === 'string'
      && typeof parsed.modelId === 'string'
    ) {
      return {
        configId: parsed.configId,
        modelId: parsed.modelId,
        reasoningEffort: 'reasoningEffort' in parsed && typeof parsed.reasoningEffort === 'string'
          ? parsed.reasoningEffort
          : null,
      };
    }
  } catch {
    // Ignore invalid stored selection and let the selector fall back to a usable model.
  }
  return null;
}

function writeNewTaskLeaderRuntimeSelection(selection: NewTaskLeaderRuntimeSelection) {
  try {
    window.localStorage.setItem(NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Keep the in-memory selection when browser storage is unavailable.
  }
}

function taskNameFromPrompt(prompt: string) {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() || '新任务';
  const segments = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(firstLine), (part) => part.segment)
    : Array.from(firstLine);
  return segments.slice(0, 10).join('');
}

function projectLabel(project: Project) {
  return project.is_default ? '默认项目' : project.name;
}

export default function NewTaskView({ onTaskCreated, onOpenModelSettings }: NewTaskViewProps) {
  const {
    projects,
    selectedProjectId,
    selectProject,
    openProjectDirectory,
    createProject,
    isLoading,
  } = useProjectStore();
  const handleCreateFlow = useFlowStore((state) => state.handleCreateFlow);
  const browserElementAttachments = useBrowserSelectionStore((state) => state.elements);
  const clearBrowserElementAttachments = useBrowserSelectionStore((state) => state.clearElements);
  const imageAttachments = useComposerImageStore((state) => state.images);
  const addImageAttachments = useComposerImageStore((state) => state.addImages);
  const clearImageAttachments = useComposerImageStore((state) => state.clearImages);
  const [prompt, setPrompt] = useState('');
  const [specRequested, setSpecRequested] = useState(false);
  const [riskMode, setRiskMode] = useState<RiskMode>('auto_edit');
  const [planApproval, setPlanApproval] = useState<PlanApproval>('on');
  const [newTaskPreferencesHydrated, setNewTaskPreferencesHydrated] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState('New project');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [leaderRuntimeSelection, setLeaderRuntimeSelection] = useState<NewTaskLeaderRuntimeSelection | null>(null);
  const [leaderModelConfigured, setLeaderModelConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const addMenuHideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setLeaderRuntimeSelection(readNewTaskLeaderRuntimeSelection());
    const modeDefaults = readNewTaskModeDefaults();
    setRiskMode(modeDefaults.riskMode);
    setPlanApproval(modeDefaults.planApproval);
    setNewTaskPreferencesHydrated(true);
  }, []);

  useEffect(() => {
    return () => {
      if (addMenuHideTimerRef.current !== null) {
        window.clearTimeout(addMenuHideTimerRef.current);
      }
    };
  }, []);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const nativeContextSlashMenu = useNativeContextSlashMenu({
    configId: leaderRuntimeSelection?.configId ?? null,
  });

  const handleLeaderRuntimeSelectionChange = useCallback((selection: { configId: string; modelId: string }) => {
    setLeaderRuntimeSelection((current) => {
      const next = {
        ...selection,
        reasoningEffort: current?.configId === selection.configId && current.modelId === selection.modelId
          ? current.reasoningEffort
          : null,
      };
      writeNewTaskLeaderRuntimeSelection(next);
      return next;
    });
  }, []);

  const handleLeaderReasoningEffortChange = useCallback((reasoningEffort: string | null) => {
    setLeaderRuntimeSelection((current) => {
      if (!current) return current;
      const next = { ...current, reasoningEffort };
      writeNewTaskLeaderRuntimeSelection(next);
      return next;
    });
  }, []);

  const handleNewTaskRiskModeChange = useCallback((next: RiskMode) => {
    setRiskMode(next);
    writeNewTaskModeDefaults({ riskMode: next, planApproval });
  }, [planApproval]);

  const handleNewTaskPlanApprovalChange = useCallback((next: PlanApproval) => {
    setPlanApproval(next);
    writeNewTaskModeDefaults({ riskMode, planApproval: next });
  }, [riskMode]);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const ordered = [...projects].sort((a, b) => Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)));
    if (!query) return ordered;
    return ordered.filter((project) => project.local_path.toLocaleLowerCase().includes(query));
  }, [projects, searchQuery]);

  const selectAndClose = (project: Project) => {
    selectProject(project.id);
    setPickerOpen(false);
    setSearchQuery('');
    setShowAddMenu(false);
  };

  const handleOpenFolder = async () => {
    setError(null);
    const project = await openProjectDirectory();
    if (!project) return;
    selectAndClose(project);
  };

  const openCreateDialog = () => {
    setProjectName('New project');
    setError(null);
    setCreateDialogOpen(true);
    setPickerOpen(false);
    setShowAddMenu(false);
    window.setTimeout(() => nameInputRef.current?.select(), 50);
  };

  const showAddProjectMenu = () => {
    if (addMenuHideTimerRef.current !== null) {
      window.clearTimeout(addMenuHideTimerRef.current);
      addMenuHideTimerRef.current = null;
    }
    setShowAddMenu(true);
  };

  const scheduleHideAddProjectMenu = () => {
    if (addMenuHideTimerRef.current !== null) {
      window.clearTimeout(addMenuHideTimerRef.current);
    }
    addMenuHideTimerRef.current = window.setTimeout(() => {
      setShowAddMenu(false);
      addMenuHideTimerRef.current = null;
    }, 80);
  };

  const handleCreateProject = async () => {
    const name = projectName.trim();
    if (!name || isCreatingProject) return;
    setIsCreatingProject(true);
    setError(null);
    try {
      const result = await createProject(name);
      if (!result.project) {
        setError(result.error || '创建项目失败');
        return;
      }
      setCreateDialogOpen(false);
      selectProject(result.project.id);
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleSend = async (rawPrompt: string = prompt): Promise<boolean> => {
    const userPrompt = rawPrompt.trim();
    const hasLeaderRuntimeSelection = Boolean(
      leaderRuntimeSelection?.configId && leaderRuntimeSelection.modelId,
    );
    if (!userPrompt || !selectedProjectId || isCreatingTask || !newTaskPreferencesHydrated || !leaderModelConfigured || !hasLeaderRuntimeSelection) return false;
    const content = userPrompt;
    const outgoingAttachments = [
      ...imageAttachments.flatMap((attachment) => {
        const outgoing = outgoingImageAttachment(attachment);
        return outgoing ? [outgoing] : [];
      }),
      ...browserElementsToOutgoingAttachments(browserElementAttachments),
    ];

    setIsCreatingTask(true);
    setError(null);
    try {
      const flow = await handleCreateFlow({
        name: taskNameFromPrompt(userPrompt),
        type: 'full',
        mode: 'create',
        leader_runtime_config_id: leaderRuntimeSelection?.configId ?? null,
        leader_runtime_model_id: leaderRuntimeSelection?.modelId ?? null,
        leader_runtime_reasoning_effort: leaderRuntimeSelection?.reasoningEffort ?? undefined,
        risk_mode: riskMode,
        plan_approval: planApproval,
      }, selectedProjectId);
      if (!flow) {
        setError('创建任务失败，请稍后重试');
        return false;
      }
      const clientMessageId = `msg-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const initialMessage = {
        id: clientMessageId,
        role: 'user',
        parts: [{ type: 'text', text: content }],
        content,
        createdAt: new Date(),
        metadata: browserElementAttachments.length > 0 || imageAttachments.length > 0
          ? {
            ...(browserElementAttachments.length > 0 ? { browserElementAttachments } : {}),
            ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
          }
          : undefined,
      } as UIMessage;
      wsClient.send({
        type: 'flow:message',
        flow_id: flow.id,
        content,
        spec_requested: specRequested,
        ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
        client_message_id: clientMessageId,
      });
      setPrompt('');
      if (browserElementAttachments.length > 0) clearBrowserElementAttachments();
      if (imageAttachments.length > 0) clearImageAttachments();
      onTaskCreated?.(flow.id, initialMessage, specRequested ? riskMode : null);
      return true;
    } finally {
      setIsCreatingTask(false);
    }
  };

  const handlePasteImages = async (files: File[], textOffset: number) => {
    const images = (await Promise.all(
      files.map((file) => imageAttachmentFromFile(file, textOffset)),
    )).filter((attachment): attachment is MessageImageAttachment => attachment !== null);
    if (images.length > 0) addImageAttachments(images);
  };

  const titleProject = selectedProject ? projectLabel(selectedProject) : '项目';

  return (
    <div data-testid="new-task-view" className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-12">
      <div className="w-full max-w-[700px] -translate-y-16">
        <h1 className="mb-8 text-center text-[30px] font-medium tracking-[-0.025em] text-foreground">
          我们应该在&nbsp;&nbsp;{titleProject}&nbsp;&nbsp;中做些什么？
        </h1>

        <div className="overflow-visible rounded-xl border border-ui-border-subtle bg-[color-mix(in_srgb,var(--ui-surface-sunken)_44%,transparent)] shadow-[var(--ui-shadow-elevated)] backdrop-blur-xl">
          <PromptInput
            onSend={handleSend}
            disabled={!selectedProject || isCreatingTask}
            sendDisabled={!newTaskPreferencesHydrated || !leaderModelConfigured || !leaderRuntimeSelection?.configId || !leaderRuntimeSelection?.modelId}
            placeholder={selectedProject ? '随心输入' : '请先选择项目'}
            value={prompt}
            onValueChange={setPrompt}
            onPasteImages={handlePasteImages}
            slashMenu={nativeContextSlashMenu}
            attachmentSlot={(
              <>
                <MessageImageAttachments />
                <BrowserElementAttachments />
              </>
            )}
            toolbarSlot={(
              newTaskPreferencesHydrated ? (
                <ComposerModeMenu
                  specRequested={specRequested}
                  riskMode={riskMode}
                  planApproval={planApproval}
                  disabled={isCreatingTask}
                  onSpecChange={setSpecRequested}
                  onRiskModeChange={handleNewTaskRiskModeChange}
                  onPlanApprovalChange={handleNewTaskPlanApprovalChange}
                  onAddImages={(files) => handlePasteImages(files, prompt.length)}
                />
              ) : (
                <div
                  aria-label="正在加载新建流程默认设置"
                  className="h-7 w-[112px] rounded-lg bg-ui-control/45"
                />
              )
            )}
            actionSlot={(
              <LeaderModelSelector
                defaultSelection
                selection={leaderRuntimeSelection}
                onSelectionChange={handleLeaderRuntimeSelectionChange}
                selectionReasoningEffort={leaderRuntimeSelection?.reasoningEffort ?? null}
                onSelectionReasoningEffortChange={handleLeaderReasoningEffortChange}
                onConfiguredChange={setLeaderModelConfigured}
                onOpenModelSettings={onOpenModelSettings}
                className="max-w-[330px]"
              />
            )}
            className="rounded-xl border-ui-border-strong shadow-[var(--ui-shadow-inset)]"
          />

          <div className="relative flex items-center px-1.5 py-0.5">
            <Popover
              open={pickerOpen}
              onOpenChange={(open) => {
                setPickerOpen(open);
                if (!open) {
                  setSearchQuery('');
                  setShowAddMenu(false);
                }
              }}
            >
              <PopoverTrigger
                type="button"
                className="inline-flex max-w-[300px] items-center gap-1.5 rounded-lg bg-ui-control px-3 py-1 text-[13px] font-medium text-foreground ring-1 ring-ui-border-subtle transition-colors hover:bg-ui-control-hover"
                aria-label="选择项目"
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{selectedProject ? projectLabel(selectedProject) : (isLoading ? '加载中...' : '选择项目')}</span>
                <ChevronDown className="size-[15px] shrink-0 text-muted-foreground" />
              </PopoverTrigger>

              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                collisionAvoidance={{ side: 'none', align: 'shift', fallbackAxisSide: 'none' }}
                className="relative w-[360px] gap-0 overflow-visible rounded-xl border border-ui-border-subtle bg-ui-overlay p-1.5 shadow-[var(--ui-shadow-overlay)] ring-0"
              >
                <div className="flex items-center gap-2 border-b border-ui-border-subtle px-2 pb-1.5">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="搜索项目路径"
                    aria-label="搜索项目路径"
                    className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>

                <div className="max-h-[220px] overflow-y-auto py-1">
                  {filteredProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => selectAndClose(project)}
                      className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-ui-control-hover"
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-foreground">{projectLabel(project)}</div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{project.local_path}</div>
                      </div>
                      {project.id === selectedProjectId && <Check className="size-4 shrink-0 text-foreground" />}
                    </button>
                  ))}
                  {filteredProjects.length === 0 && (
                    <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的项目路径</div>
                  )}
                </div>

                <div
                  data-testid="add-project-menu-zone"
                  className="relative border-t border-ui-border-subtle pt-1"
                  onMouseEnter={showAddProjectMenu}
                  onMouseLeave={(event) => {
                    const nextTarget = event.relatedTarget;
                    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                      scheduleHideAddProjectMenu();
                    }
                  }}
                  onFocus={showAddProjectMenu}
                  onBlur={(event) => {
                    const nextTarget = event.relatedTarget;
                    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                      scheduleHideAddProjectMenu();
                    }
                  }}
                >
                  <button
                    type="button"
                    onClick={showAddProjectMenu}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors ${showAddMenu ? 'bg-ui-control-hover text-foreground' : 'text-foreground hover:bg-ui-control-hover'}`}
                  >
                    <FolderOpen className="size-4 text-muted-foreground" />
                    <span className="flex-1">添加新项目</span>
                    <ChevronRight className="size-[15px] text-muted-foreground" />
                  </button>

                  {showAddMenu && (
                    <div className="absolute bottom-0 left-[calc(100%+8px)] w-[220px] rounded-xl border border-ui-border-subtle bg-ui-overlay p-1.5 shadow-[var(--ui-shadow-overlay)]">
                      <button
                        type="button"
                        onClick={openCreateDialog}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-ui-control-hover"
                      >
                        <Plus className="size-[15px] text-muted-foreground" />
                        新建项目
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleOpenFolder()}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-ui-control-hover"
                      >
                        <FolderOpen className="size-[15px] text-muted-foreground" />
                        使用现有文件夹
                      </button>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {error && !createDialogOpen && <p className="mt-4 text-center text-sm text-destructive">{error}</p>}
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[min(760px,calc(100vw-40px))] max-w-none gap-0 rounded-[30px] border border-ui-border-subtle bg-ui-overlay p-10 shadow-[var(--ui-shadow-dialog)] ring-0"
        >
          <button
            type="button"
            onClick={() => setCreateDialogOpen(false)}
            aria-label="关闭"
            className="absolute right-7 top-7 flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-ui-control-hover hover:text-foreground"
          >
            <X className="size-5" />
          </button>

          <DialogHeader className="gap-2 pr-12 text-left">
            <DialogTitle className="text-[30px] font-semibold leading-tight tracking-[-0.02em] text-foreground">为项目命名</DialogTitle>
            <DialogDescription className="text-[17px] font-medium text-muted-foreground">保持简短且易识别</DialogDescription>
          </DialogHeader>

          <Input
            ref={nameInputRef}
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleCreateProject();
            }}
            aria-label="项目名称"
            className="mt-8 h-16 rounded-2xl border-ui-border-strong bg-transparent px-5 text-[20px] shadow-none focus-visible:border-ring focus-visible:ring-0"
          />

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

          <div className="mt-7 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setCreateDialogOpen(false)}
              className="h-14 rounded-2xl border border-ui-border-strong bg-ui-control px-8 text-[17px] font-semibold text-foreground transition-colors hover:bg-ui-control-hover"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleCreateProject()}
              disabled={!projectName.trim() || isCreatingProject}
              className="h-14 rounded-2xl bg-foreground px-8 text-[17px] font-semibold text-background transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isCreatingProject ? '保存中...' : '保存'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
