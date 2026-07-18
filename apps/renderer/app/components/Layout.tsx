"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import type { UIMessage } from 'ai';
import { useSearchParams, useRouter } from 'next/navigation';
import TopBar from './TopBar';
import Sidebar from './Sidebar';
import NewFlowModal from './NewFlowModal';
import NewTaskView from './NewTaskView';
import DeleteFlowModal from './DeleteFlowModal';
import ClearAllFlowsModal from './ClearAllFlowsModal';
import AbortFlowModal from './AbortFlowModal';
import AppSettingsDialog, { type AgentSettingsTab, type SettingsSection } from './AppSettingsDialog';
import LeaderChatPanel from './workbench/LeaderChatPanel';
import FlowSidePanel from './workbench/FlowSidePanel';
import {
  createInitialRightPanelState,
  deriveLeaderAgentSessionId,
  dynamicWorkbenchTabId,
  expertChatTabFromDispatchEvent,
  openDynamicWorkbenchTab,
  openOrchestrationPlanWorkbenchTab,
  openWorkspaceFileWorkbenchTab,
  parseRightPanelState,
  rightPanelStorageKey,
  serializeRightPanelState,
  syncOrchestrationPlanWorkbenchTab,
} from './workbench/workbenchState';
import { useFlowStore } from '../stores/useFlowStore';
import { useProjectStore } from '../stores/useProjectStore';
import { useModalStore } from '../stores/useModalStore';
import { initTheme, useThemeStore } from '../stores/useThemeStore';
import { initAppPreferences } from '../stores/useAppPreferencesStore';
import { useDashboardData } from '../hooks/useDashboardData';
import type { DecisionAnswers } from '../hooks/useDashboardData';
import { useFlowWorkbench } from '../hooks/useFlowWorkbench';
import { useAgentSessions } from '../hooks/useFlowExperts';
import { wsClient } from '../lib/ws';
import { API_BASE } from '../lib/api';
import { installDesktopBrowserSelectionListener, useBrowserSelectionStore } from '../stores/useBrowserSelectionStore';
import { useComposerImageStore } from '../stores/useComposerImageStore';
import { usePlanFeedbackStore } from '../stores/usePlanFeedbackStore';
import type { OrchestrationPlanView } from '../types/orchestration';
import type { SquadFlow } from '../types';
import { recordFlowNavigationVisit, type FlowNavigationState } from './flowNavigation';
import {
  collapseLeftPanelWidths,
  clampRightPanelWidth,
  DEFAULT_RIGHT_PANEL_WIDTH,
  MIN_LEFT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  normalizePanelWidths,
  resizeLeftPanelWithRightCompensation,
  shouldCollapsePanelDrag,
} from './panelSizing';

const LEFT_PANEL_STORAGE_KEY = 'squadflow-left-panel-width';
const RIGHT_PANEL_STORAGE_KEY = 'squadflow-right-panel-width';
const RIGHT_PANEL_MAXIMIZED_STORAGE_KEY = 'squadflow-right-panel-maximized';
const LEFT_PANEL_PREVIEW_TRIGGER_RATIO = 0.05;

export default function Layout() {
  const shellRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const { flows, selectedFlow, selectedFlowId, hydrateSelectedFlowId, clearSelectedFlow, refreshFlows, handleSaveEdit, handleConfirmDelete, confirmClearAllFlows, handleSelectFlow, handleAbort } = useFlowStore();
  const { projects, init: initProjects, refreshProjects } = useProjectStore();
  const { editingFlow, deleteModalFlow, showClearAllModal, abortModalFlow, closeEditModal, closeDeleteModal, closeClearAllModal, openDeleteModal, openEditModal, openAbortModal, closeAbortModal } = useModalStore();
  const selectedFlowSummary = selectedFlow || flows.find((flow) => flow.id === selectedFlowId) || null;
  const selectedProject = projects.find((project) => project.id === selectedFlowSummary?.project_id) ?? null;
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('general');
  const [settingsInitialAgentTab, setSettingsInitialAgentTab] = useState<AgentSettingsTab>('role_assignment');
  const [initialMessagesByFlow, setInitialMessagesByFlow] = useState<Record<string, UIMessage[]>>({});
  const [leaderComposerDraftByFlow, setLeaderComposerDraftByFlow] = useState<Record<string, string>>({});
  const setBrowserSelectionActiveFlowId = useBrowserSelectionStore((state) => state.setActiveFlowId);
  const setComposerImageActiveFlowId = useComposerImageStore((state) => state.setActiveFlowId);
  const setPlanFeedbackActiveFlowId = usePlanFeedbackStore((state) => state.setActiveFlowId);
  const themePreference = useThemeStore((state) => state.theme);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);

  // Dashboard data follows the active flow; during a switch, the previous flow stays mounted under the overlay.
  // selectedFlow is populated later by flow:state WS event
  const dashboard = useDashboardData(selectedFlowId ?? null);
  const { workbench } = useFlowWorkbench(selectedFlowId ?? null);
  const workspaceRootPath = workbench.files.root_path ?? selectedProject?.local_path ?? null;

  const [rightPanelState, setRightPanelState] = useState(createInitialRightPanelState);
  const [rightPanelFlowId, setRightPanelFlowId] = useState<string | null>(null);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(260);
  const [leftPanelPreviewOpen, setLeftPanelPreviewOpen] = useState(false);
  const [leftPanelPreviewWidth, setLeftPanelPreviewWidth] = useState(260);
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [resizingPanel, setResizingPanel] = useState<'left' | 'right' | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const openSettings = (section: SettingsSection = 'general', agentTab: AgentSettingsTab = 'role_assignment') => {
    setSettingsInitialSection(section);
    setSettingsInitialAgentTab(agentTab);
    setIsSettingsOpen(true);
  };
  const [rightPanelWidthAnimationDisabled, setRightPanelWidthAnimationDisabled] = useState(false);
  const [isRightPanelMaximized, setIsRightPanelMaximized] = useState(false);
  const [leftPanelDrawerAnimation, setLeftPanelDrawerAnimation] = useState<'enter' | 'exit' | null>(null);
  const [rightPanelDrawerAnimation, setRightPanelDrawerAnimation] = useState<'enter' | 'exit' | null>(null);
  const [flowNavigation, setFlowNavigation] = useState<FlowNavigationState>({ entries: [], index: -1 });
  const [flowSwitchOverlay, setFlowSwitchOverlay] = useState<{ flowId: string; startedAt: number } | null>(null);
  const leftPanelWidthRef = useRef(leftPanelWidth);
  const leftPanelPreviewWidthRef = useRef(leftPanelPreviewWidth);
  const rightPanelWidthRef = useRef(rightPanelWidth);
  const isRightPanelOpenRef = useRef(isRightPanelOpen);
  const rightPanelDrawerTimerRef = useRef<number | null>(null);
  const autoFollowAgentDispatchRef = useRef(true);
  const handledDispatchSessionIdsRef = useRef<Set<string>>(new Set());
  const skipNextRightPanelPersistRef = useRef(false);
  const reportedFlowSwitchReadyRef = useRef<string | null>(null);
  const reportedFlowSwitchFailureRef = useRef<string | null>(null);

  const disableRightPanelWidthAnimationOnce = useCallback(() => {
    setRightPanelWidthAnimationDisabled(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setRightPanelWidthAnimationDisabled(false));
    });
  }, []);

  const clearRightPanelDrawerTimer = useCallback(() => {
    if (rightPanelDrawerTimerRef.current === null) return;
    window.clearTimeout(rightPanelDrawerTimerRef.current);
    rightPanelDrawerTimerRef.current = null;
  }, []);

  const playRightPanelDrawerAnimation = useCallback((animation: 'enter' | 'exit') => {
    clearRightPanelDrawerTimer();
    setRightPanelDrawerAnimation(animation);
    rightPanelDrawerTimerRef.current = window.setTimeout(() => {
      setRightPanelDrawerAnimation(null);
      rightPanelDrawerTimerRef.current = null;
    }, animation === 'enter' ? 220 : 180);
  }, [clearRightPanelDrawerTimer]);

  const persistRightPanelSession = (flowId: string | null, isOpen: boolean, state: ReturnType<typeof createInitialRightPanelState>) => {
    if (!flowId) return;
    localStorage.setItem(
      rightPanelStorageKey(flowId),
      serializeRightPanelState({
        isOpen,
        autoFollowAgentDispatch: autoFollowAgentDispatchRef.current,
        state,
      }),
    );
  };

  const handleRightPanelStateChange = (nextState: ReturnType<typeof createInitialRightPanelState>) => {
    setRightPanelState(nextState);
    persistRightPanelSession(selectedFlowId, isRightPanelOpen, nextState);
  };

  // Reset right-panel selection after switching flows.
  const prevFlowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if ((selectedFlowId ?? null) !== prevFlowIdRef.current) {
      prevFlowIdRef.current = selectedFlowId ?? null;
      skipNextRightPanelPersistRef.current = true;
      if (!selectedFlowId) {
        setRightPanelFlowId(null);
        setRightPanelState(createInitialRightPanelState());
        setIsRightPanelOpen(false);
        autoFollowAgentDispatchRef.current = true;
        handledDispatchSessionIdsRef.current = new Set();
        return;
      }

      const persisted = parseRightPanelState(localStorage.getItem(rightPanelStorageKey(selectedFlowId)));
      if (persisted) {
        setRightPanelState(persisted.state);
        setIsRightPanelOpen(persisted.isOpen);
        autoFollowAgentDispatchRef.current = persisted.autoFollowAgentDispatch;
      } else {
        setRightPanelState(createInitialRightPanelState());
        setIsRightPanelOpen(false);
        autoFollowAgentDispatchRef.current = true;
      }
      setRightPanelFlowId(selectedFlowId);
      handledDispatchSessionIdsRef.current = new Set();
    }
  }, [selectedFlowId]);

  useEffect(() => {
    if (!selectedFlowId || rightPanelFlowId !== selectedFlowId) return;
    if (skipNextRightPanelPersistRef.current) {
      skipNextRightPanelPersistRef.current = false;
      return;
    }
    localStorage.setItem(
      rightPanelStorageKey(selectedFlowId),
      serializeRightPanelState({
        isOpen: isRightPanelOpen,
        autoFollowAgentDispatch: autoFollowAgentDispatchRef.current,
        state: rightPanelState,
      }),
    );
  }, [isRightPanelOpen, rightPanelFlowId, rightPanelState, selectedFlowId]);

  const { agentSessions } = useAgentSessions(selectedFlowId ?? null);
  const leaderAgentSessionId = deriveLeaderAgentSessionId(dashboard.leaderAgentSessionId, agentSessions);

  useEffect(() => {
    if (!selectedFlowId) return;

    const unsubscribe = wsClient.onEvent('flow_expert:event', (message) => {
      if (message.flow_id !== selectedFlowId) return;
      const tab = expertChatTabFromDispatchEvent(message);
      if (!tab) return;
      if (handledDispatchSessionIdsRef.current.has(tab.flow_expert_id)) return;
      handledDispatchSessionIdsRef.current.add(tab.flow_expert_id);
      if (!autoFollowAgentDispatchRef.current) return;

      if (!isRightPanelOpenRef.current) {
        disableRightPanelWidthAnimationOnce();
        playRightPanelDrawerAnimation('enter');
      }
      setIsRightPanelOpen(true);
      setRightPanelState((state) => openDynamicWorkbenchTab(state, tab));
    });

    return unsubscribe;
  }, [disableRightPanelWidthAnimationOnce, playRightPanelDrawerAnimation, selectedFlowId]);

  // Connect WebSocket on mount
  useEffect(() => {
    wsClient.connect();
  }, []);

  useEffect(() => () => clearRightPanelDrawerTimer(), [clearRightPanelDrawerTimer]);

  useEffect(() => {
    const storedLeftRaw = localStorage.getItem(LEFT_PANEL_STORAGE_KEY);
    const storedRightRaw = localStorage.getItem(RIGHT_PANEL_STORAGE_KEY);
    const storedRightMaximized = localStorage.getItem(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY);
    const storedLeft = Number(storedLeftRaw) || 260;
    const parsedStoredRight = Number(storedRightRaw);
    const storedRight = !storedRightRaw || parsedStoredRight === 432
      ? DEFAULT_RIGHT_PANEL_WIDTH
      : parsedStoredRight || DEFAULT_RIGHT_PANEL_WIDTH;
    const normalized = normalizePanelWidths(window.innerWidth, storedLeft, storedRight);
    setLeftPanelWidth(normalized.left);
    setLeftPanelPreviewWidth(normalized.left);
    setRightPanelWidth(normalized.right);
    setIsRightPanelMaximized(storedRightMaximized === 'true');

    const handleResize = () => {
      const next = normalizePanelWidths(
        window.innerWidth,
        leftPanelWidthRef.current,
        rightPanelWidthRef.current,
      );
      setLeftPanelWidth(next.left);
      setRightPanelWidth(next.right);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    leftPanelWidthRef.current = leftPanelWidth;
    localStorage.setItem(LEFT_PANEL_STORAGE_KEY, String(leftPanelWidth));
  }, [leftPanelWidth]);

  useEffect(() => {
    leftPanelPreviewWidthRef.current = leftPanelPreviewWidth;
  }, [leftPanelPreviewWidth]);

  useEffect(() => {
    isRightPanelOpenRef.current = isRightPanelOpen;
  }, [isRightPanelOpen]);

  useEffect(() => {
    const plan = workbench.orchestration_plan;
    if (!plan || !selectedFlowId || rightPanelFlowId !== selectedFlowId || plan.flow_id !== selectedFlowId) return;
    setRightPanelState((state) => syncOrchestrationPlanWorkbenchTab(state, plan));
  }, [rightPanelFlowId, selectedFlowId, workbench.orchestration_plan]);

  useEffect(() => {
    void window.squadflowDesktopShell?.setTheme?.(themePreference, resolvedTheme);
  }, [resolvedTheme, themePreference]);

  useEffect(() => {
    if (isLeftPanelOpen && leftPanelPreviewOpen) setLeftPanelPreviewOpen(false);
  }, [isLeftPanelOpen, leftPanelPreviewOpen]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (isLeftPanelOpen) return;
      const triggerWidth = window.innerWidth * LEFT_PANEL_PREVIEW_TRIGGER_RATIO;
      if (event.clientX <= triggerWidth) {
        setLeftPanelPreviewOpen(true);
        return;
      }
      if (leftPanelPreviewOpen && event.clientX > leftPanelPreviewWidthRef.current) {
        setLeftPanelPreviewOpen(false);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, [isLeftPanelOpen, leftPanelPreviewOpen]);

  useEffect(() => {
    rightPanelWidthRef.current = rightPanelWidth;
    localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY, String(isRightPanelMaximized));
  }, [isRightPanelMaximized]);

  // Decision card tracking
  const decisionCardStatuses: Record<string, "pending" | "resolved" | "cancelled"> = {};
  const decisionCardAnswers: Record<string, DecisionAnswers> = {};
  dashboard.decisionCards.forEach((card) => {
    decisionCardStatuses[card.card_id] = card.status;
    if (card.answers) decisionCardAnswers[card.card_id] = card.answers;
  });

  const autoNavRunRef = useRef(false);
  const autoNavGenerationRef = useRef(0);
  const launchViewRunRef = useRef(false);

  // Sequential init: preferences first, then projects and tasks.
  useEffect(() => {
    const init = async () => {
      initTheme();
      initAppPreferences();
      installDesktopBrowserSelectionListener();
      hydrateSelectedFlowId();
      await initProjects();
      await refreshFlows();
      if (!useFlowStore.getState().selectedFlowId) setIsCreatingTask(true);
    };
    void init();
  }, [hydrateSelectedFlowId, initProjects, refreshFlows]);

  useEffect(() => {
    if (launchViewRunRef.current) return;
    if (searchParams.get('view') !== 'new-flow') return;
    launchViewRunRef.current = true;
    autoNavGenerationRef.current += 1;
    clearSelectedFlow();
    setIsCreatingTask(true);
    router.replace('/', { scroll: false });
  }, [clearSelectedFlow, router, searchParams]);

  useEffect(() => {
    setBrowserSelectionActiveFlowId(!isCreatingTask ? selectedFlowId ?? null : null);
    setComposerImageActiveFlowId(!isCreatingTask ? selectedFlowId ?? null : null);
    setPlanFeedbackActiveFlowId(!isCreatingTask ? selectedFlowId ?? null : null);
  }, [isCreatingTask, selectedFlowId, setBrowserSelectionActiveFlowId, setComposerImageActiveFlowId, setPlanFeedbackActiveFlowId]);

  useEffect(() => {
    if (!flowSwitchOverlay) return;
    if (selectedFlowId !== flowSwitchOverlay.flowId) return;
    if (dashboard.flowStateLoadedFlowId !== flowSwitchOverlay.flowId) return;
    if (
      dashboard.leaderAgentSessionId
      && (
        dashboard.leaderTranscriptReadyFlowId !== flowSwitchOverlay.flowId
        || dashboard.leaderTranscriptReadyAgentSessionId !== dashboard.leaderAgentSessionId
      )
    ) return;

    const diagnosticKey = `${flowSwitchOverlay.flowId}:${flowSwitchOverlay.startedAt}`;
    if (reportedFlowSwitchReadyRef.current !== diagnosticKey) {
      reportedFlowSwitchReadyRef.current = diagnosticKey;
      wsClient.sendClientDiagnostic({
        flowId: flowSwitchOverlay.flowId,
        event: "flow_switch_ready",
        durationMs: Date.now() - flowSwitchOverlay.startedAt,
        leaderAgentSessionId: dashboard.leaderAgentSessionId ?? undefined,
      });
    }
    const frame = window.requestAnimationFrame(() => {
      setFlowSwitchOverlay((current) =>
        current?.flowId === flowSwitchOverlay.flowId ? null : current
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    dashboard.flowStateLoadedFlowId,
    dashboard.leaderAgentSessionId,
    dashboard.leaderTranscriptReadyFlowId,
    dashboard.leaderTranscriptReadyAgentSessionId,
    flowSwitchOverlay,
    selectedFlowId,
  ]);

  useEffect(() => wsClient.onEvent('system:error', (message) => {
    if (!flowSwitchOverlay || message.flow_id !== flowSwitchOverlay.flowId) return;
    const errorCode = typeof message.data?.code === 'string' ? message.data.code : '';
    if (!errorCode.startsWith('SESSION_HISTORY_')) return;
    const diagnosticKey = `${flowSwitchOverlay.flowId}:${flowSwitchOverlay.startedAt}`;
    if (reportedFlowSwitchFailureRef.current === diagnosticKey) return;
    reportedFlowSwitchFailureRef.current = diagnosticKey;
    wsClient.sendClientDiagnostic({
      flowId: flowSwitchOverlay.flowId,
      event: "flow_switch_failed",
      durationMs: Date.now() - flowSwitchOverlay.startedAt,
      errorCode,
      leaderAgentSessionId: dashboard.leaderAgentSessionId ?? undefined,
    });
  }), [dashboard.leaderAgentSessionId, flowSwitchOverlay]);


  // Auto-navigate: ?flow=xxx&stage=yyy → select flow after init
  useEffect(() => {
    if (autoNavRunRef.current) return;
    const flowId = searchParams.get('flow');
    if (!flowId) return;
    const generation = autoNavGenerationRef.current + 1;
    autoNavGenerationRef.current = generation;
    const isCurrent = () => autoNavGenerationRef.current === generation;

    const autoNavigate = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/flows/${flowId}`);
        if (!isCurrent()) return;
        if (!res.ok) {
          router.replace('/404');
          return;
        }
        const detail = await res.json();
        if (!isCurrent()) return;

        if (useProjectStore.getState().projects.length === 0) {
          await useProjectStore.getState().init();
          if (!isCurrent()) return;
        }

        // Ensure the flow exists in the flows list for sidebar tracking
        const flowsState = useFlowStore.getState();
        const existsInList = flowsState.flows.some(f => f.id === detail.id);
        if (!existsInList) {
          // Add to flows list so sidebar can highlight it
          const summary: SquadFlow = {
            id: detail.id,
            name: detail.name,
            description: detail.description || '',
            type: detail.flow_type || detail.type,
            status: detail.status,
            current_stage: detail.current_stage,
            project_id: detail.project_id ?? null,
            // Project is the top-level local directory.
            created_at: detail.created_at,
            updated_at: detail.updated_at,
            is_pinned: detail.is_pinned,
            has_pending_decision: detail.has_pending_decision,
          };
          useFlowStore.setState(s => ({ flows: [...s.flows, summary] }));
        }

        // Select the flow
        const existingFlow = useFlowStore.getState().flows.find(f => f.id === detail.id);
        if (existingFlow && isCurrent()) {
          setIsCreatingTask(false);
          handleSelectFlow(existingFlow);
        }
      } catch {
        if (isCurrent()) router.replace('/404');
      }
    };

    autoNavRunRef.current = true;
    void autoNavigate();
  }, [searchParams]);

  const startNewTask = () => {
    autoNavGenerationRef.current += 1;
    setFlowSwitchOverlay(null);
    clearSelectedFlow();
    setIsCreatingTask(true);
    setIsRightPanelOpen(false);
    router.replace('/', { scroll: false });
  };

  const recordFlowVisit = (flowId: string) => {
    setFlowNavigation((current) => recordFlowNavigationVisit(current, flowId, selectedFlowId));
  };

  const selectTask = (flow: SquadFlow, options: { recordVisit?: boolean } = {}) => {
    autoNavGenerationRef.current += 1;
    setIsCreatingTask(false);
    if (flow.id === selectedFlowId) return;

    const startedAt = Date.now();
    reportedFlowSwitchReadyRef.current = null;
    reportedFlowSwitchFailureRef.current = null;
    setFlowSwitchOverlay({ flowId: flow.id, startedAt });
    wsClient.sendClientDiagnostic({ flowId: flow.id, event: "flow_switch_started" });
    handleSelectFlow(flow);
    if (options.recordVisit ?? true) recordFlowVisit(flow.id);
  };

  const previousFlowId = flowNavigation.index > 0
    ? flowNavigation.entries[flowNavigation.index - 1]
    : null;
  const nextFlowId = flowNavigation.index >= 0 && flowNavigation.index < flowNavigation.entries.length - 1
    ? flowNavigation.entries[flowNavigation.index + 1]
    : null;
  const previousFlow = previousFlowId ? flows.find((flow) => flow.id === previousFlowId) ?? null : null;
  const nextFlow = nextFlowId ? flows.find((flow) => flow.id === nextFlowId) ?? null : null;
  const navigateFlowByOffset = (offset: -1 | 1) => {
    const target = offset === -1 ? previousFlow : nextFlow;
    if (!target) return;
    setFlowNavigation((current) => ({ ...current, index: current.index + offset }));
    void selectTask(target, { recordVisit: false });
  };

  const startPanelResize = (side: 'left' | 'right') => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const shellRect = shellRef.current?.getBoundingClientRect();
    if (!shellRect) return;

    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    resizeHandle.setPointerCapture(pointerId);
    setResizingPanel(side);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    let pendingClientX = event.clientX;
    let animationFrame: number | null = null;
    let resizeFinished = false;
    const initialLeftWidth = leftPanelWidthRef.current;
    const initialRightWidth = rightPanelWidthRef.current;
    const rightPanelWasOpen = isRightPanelOpen;

    const desiredPanelWidth = () => side === 'left'
      ? pendingClientX - shellRect.left
      : shellRect.right - pendingClientX;

    const cleanupResize = () => {
      if (resizeFinished) return;
      resizeFinished = true;
      setResizingPanel(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      window.removeEventListener('blur', handleWindowBlur);
    };

    const collapseResizedPanel = () => {
      if (resizeFinished) return;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      if (side === 'left') {
        setLeftPanelWidth(MIN_LEFT_PANEL_WIDTH);
        setLeftPanelPreviewWidth(MIN_LEFT_PANEL_WIDTH);
        setLeftPanelPreviewOpen(false);
        setIsLeftPanelOpen(false);
      } else {
        autoFollowAgentDispatchRef.current = false;
        setIsRightPanelMaximized(false);
        setIsRightPanelOpen(false);
      }
      cleanupResize();
    };

    const collapseIfPastThreshold = () => {
      const shouldCollapse = shouldCollapsePanelDrag(
        desiredPanelWidth(),
        side === 'left' ? MIN_LEFT_PANEL_WIDTH : MIN_RIGHT_PANEL_WIDTH,
      );
      if (!shouldCollapse) return false;
      collapseResizedPanel();
      return true;
    };

    const applyPendingWidth = () => {
      if (resizeFinished) return;
      animationFrame = null;
      const desired = desiredPanelWidth();
      if (side === 'left') {
        const next = resizeLeftPanelWithRightCompensation(
          desired,
          shellRect.width,
          initialLeftWidth,
          rightPanelWasOpen ? initialRightWidth : 0,
          rightPanelWasOpen,
        );
        setLeftPanelWidth(next.left);
        if (rightPanelWasOpen) setRightPanelWidth(next.right);
      } else {
        setRightPanelWidth(clampRightPanelWidth(
          desired,
          shellRect.width,
          isLeftPanelOpen ? leftPanelWidthRef.current : 0,
        ));
      }
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (resizeFinished) return;
      pendingClientX = moveEvent.clientX;
      if (collapseIfPastThreshold()) return;
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(applyPendingWidth);
    };

    const finishResize = (finishEvent?: PointerEvent) => {
      if (resizeFinished) return;
      if (finishEvent) pendingClientX = finishEvent.clientX;
      if (collapseIfPastThreshold()) return;
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      applyPendingWidth();
      cleanupResize();
    };
    const handleWindowBlur = () => finishResize();

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    window.addEventListener('blur', handleWindowBlur);
  };

  const playLeftPanelDrawerAnimation = (animation: 'enter' | 'exit') => {
    setLeftPanelDrawerAnimation(animation);
    window.setTimeout(() => setLeftPanelDrawerAnimation(null), 240);
  };

  const toggleLeftPanel = () => {
    setIsLeftPanelOpen((open) => {
      setLeftPanelPreviewOpen(false);
      if (open) {
        setLeftPanelPreviewWidth(leftPanelWidthRef.current);
        playLeftPanelDrawerAnimation('exit');
        if (isRightPanelOpen) {
          disableRightPanelWidthAnimationOnce();
          const next = collapseLeftPanelWidths(shellRef.current?.clientWidth ?? window.innerWidth);
          setRightPanelWidth(next.right);
        }
      } else {
        playLeftPanelDrawerAnimation('enter');
        if (isRightPanelOpen) disableRightPanelWidthAnimationOnce();
        const next = resizeLeftPanelWithRightCompensation(
          leftPanelWidthRef.current,
          shellRef.current?.clientWidth ?? window.innerWidth,
          0,
          isRightPanelOpen ? rightPanelWidthRef.current : 0,
          isRightPanelOpen,
        );
        setLeftPanelWidth(next.left);
        if (isRightPanelOpen) setRightPanelWidth(next.right);
      }
      return !open;
    });
  };

  const toggleRightPanel = () => {
    disableRightPanelWidthAnimationOnce();
    if (isRightPanelOpen) {
      autoFollowAgentDispatchRef.current = false;
      setIsRightPanelMaximized(false);
      setIsRightPanelOpen(false);
      playRightPanelDrawerAnimation('exit');
      return;
    }

    autoFollowAgentDispatchRef.current = true;
    const normalized = normalizePanelWidths(
      shellRef.current?.clientWidth ?? window.innerWidth,
      isLeftPanelOpen ? leftPanelWidthRef.current : 0,
      rightPanelWidthRef.current,
    );
    setLeftPanelWidth(normalized.left);
    setRightPanelWidth(normalized.right);
    playRightPanelDrawerAnimation('enter');
    setIsRightPanelOpen(true);
  };

  const toggleRightPanelMaximize = () => {
    setIsRightPanelMaximized((current) => !current);
  };

  const openSpecPreview = (specRevisionId: string, title: string) => {
    if (!isRightPanelOpen) {
      disableRightPanelWidthAnimationOnce();
      playRightPanelDrawerAnimation('enter');
    }
    setIsRightPanelOpen(true);
    setRightPanelState((state) => openDynamicWorkbenchTab(state, {
      type: "spec_preview",
      spec_revision_id: specRevisionId,
      title,
    }));
  };
  const openWorkspaceFile = (filePath: string) => {
    if (!isRightPanelOpen) {
      disableRightPanelWidthAnimationOnce();
      playRightPanelDrawerAnimation('enter');
    }
    setIsRightPanelOpen(true);
    setRightPanelState((state) => openWorkspaceFileWorkbenchTab(state, filePath));
  };
  const openReviewPanel = () => {
    if (!isRightPanelOpen) {
      disableRightPanelWidthAnimationOnce();
      playRightPanelDrawerAnimation('enter');
    }
    setIsRightPanelOpen(true);
    setRightPanelState((state) => ({
      ...state,
      tab: "review",
      activeDynamicTabId: null,
    }));
  };
  const openOrchestrationPlan = (plan: OrchestrationPlanView) => {
    if (!isRightPanelOpen) {
      disableRightPanelWidthAnimationOnce();
      playRightPanelDrawerAnimation('enter');
    }
    setIsRightPanelOpen(true);
    setRightPanelState((state) => openOrchestrationPlanWorkbenchTab(state, plan));
  };
  const leaderComposerDraft = selectedFlowId ? leaderComposerDraftByFlow[selectedFlowId] ?? '' : '';
  const handleLeaderComposerDraftChange = (value: string) => {
    if (!selectedFlowId) return;
    setLeaderComposerDraftByFlow((current) => ({ ...current, [selectedFlowId]: value }));
  };

  const isRightPanelStateCurrent = Boolean(selectedFlowId && rightPanelFlowId === selectedFlowId);
  const activeRightPanelTab = rightPanelState.dynamicTabs.find((tab) =>
    rightPanelState.tab === 'dynamic' && rightPanelState.activeDynamicTabId === dynamicWorkbenchTabId(tab)
  );
  const isRightWorkbenchMaximized = Boolean(
    selectedFlowId
    && !isCreatingTask
    && isRightPanelStateCurrent
    && isRightPanelOpen
    && isRightPanelMaximized,
  );
  const isFileWorkspaceFullscreen = Boolean(
    isRightWorkbenchMaximized
    && (rightPanelState.tab === 'files' || activeRightPanelTab?.type === 'workspace_file_preview'),
  );
  const rightWorkbenchMaximizedLeftOffset = isRightWorkbenchMaximized && isLeftPanelOpen ? leftPanelWidth : 0;
  return (
    <div
      ref={shellRef}
      data-testid="layout-shell"
      data-file-workspace-fullscreen={isFileWorkspaceFullscreen ? 'true' : 'false'}
      data-right-workbench-maximized={isRightWorkbenchMaximized ? 'true' : 'false'}
      className="relative flex h-screen overflow-hidden bg-background text-foreground"
    >
      <Sidebar
        width={leftPanelWidth}
        isOpen={isLeftPanelOpen}
        isPreviewOpen={!isLeftPanelOpen && leftPanelPreviewOpen}
        previewWidth={leftPanelPreviewWidth}
        drawerAnimation={leftPanelDrawerAnimation}
        onToggle={toggleLeftPanel}
        onNavigatePreviousFlow={() => navigateFlowByOffset(-1)}
        onNavigateNextFlow={() => navigateFlowByOffset(1)}
        canNavigatePreviousFlow={Boolean(previousFlow)}
        canNavigateNextFlow={Boolean(nextFlow)}
        onResizeStart={startPanelResize('left')}
        onNewTask={startNewTask}
        onRefresh={() => {
          void Promise.all([refreshProjects(), refreshFlows()]);
        }}
        onSelectTask={selectTask}
        onAbortFlow={openAbortModal}
        onEditFlow={openEditModal}
        onDeleteFlow={openDeleteModal}
        onOpenSettings={() => openSettings()}
      />

      <div data-testid="layout-content-column" className="flex min-w-0 flex-1 flex-col">
        {!isRightWorkbenchMaximized ? (
          <TopBar
            activeTitle={isCreatingTask ? '新建流程' : selectedFlowSummary?.name ?? '选择一个流程'}
            activeSubtitle={isCreatingTask ? undefined : selectedProject?.name}
            isLeftPanelOpen={isLeftPanelOpen}
          />
        ) : null}

        <main data-testid="layout-main" className="flex-1 overflow-hidden">
              {selectedFlowId && !isCreatingTask ? (
                <div
                  data-testid="workbench-shell"
                  data-file-workspace-fullscreen={isFileWorkspaceFullscreen ? 'true' : 'false'}
                  data-right-workbench-maximized={isRightWorkbenchMaximized ? 'true' : 'false'}
                  className="relative h-full flex overflow-hidden"
                >
                  {!isRightWorkbenchMaximized ? (
                    <div data-testid="leader-chat-region" className="flex-1 flex flex-col min-w-0">
                      <LeaderChatPanel
                        flowId={selectedFlowId}
                        leaderAgentSessionId={leaderAgentSessionId}
                        initialOptimisticMessages={initialMessagesByFlow[selectedFlowId] ?? []}
                        flowStatus={dashboard.flowStatus || selectedFlowSummary?.status}
                        decisionCardStatuses={decisionCardStatuses}
                        decisionCardAnswers={decisionCardAnswers}
                        decisionCards={dashboard.decisionCards}
                        specCards={dashboard.specCards}
                        orchestrationPlans={dashboard.orchestrationPlans}
                        riskMode={dashboard.riskMode}
                        planApproval={dashboard.planApproval}
                        userTurns={dashboard.userTurns}
                        onOpenSpecPreview={openSpecPreview}
                        onOpenPlan={openOrchestrationPlan}
                        review={workbench.review}
                        onOpenReview={openReviewPanel}
                        onOpenWorkspaceFile={openWorkspaceFile}
                        composerValue={leaderComposerDraft}
                        onComposerValueChange={handleLeaderComposerDraftChange}
                        workspaceRootPath={workspaceRootPath}
                        onOpenModelSettings={() => openSettings('agents', 'runtime_configs')}
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                <NewTaskView
                  onOpenModelSettings={() => openSettings('agents', 'runtime_configs')}
                  onTaskCreated={(flowId, initialMessage) => {
                    setInitialMessagesByFlow((current) => ({
                      ...current,
                      [flowId]: [initialMessage],
                    }));
                    setIsCreatingTask(false);
                  }}
                />
              )}
        </main>

      </div>

      {selectedFlowId && !isCreatingTask && isRightPanelStateCurrent ? <FlowSidePanel
        width={rightPanelWidth}
        isOpen={isRightPanelOpen}
        isResizing={resizingPanel === 'right'}
        disableWidthAnimation={rightPanelWidthAnimationDisabled || resizingPanel === 'left'}
        drawerAnimation={rightPanelDrawerAnimation}
        onResizeStart={startPanelResize('right')}
        flowId={selectedFlowId}
        workbench={workbench}
        state={rightPanelState}
        onStateChange={handleRightPanelStateChange}
        isMaximized={isRightPanelOpen && isRightPanelMaximized}
        maximizedLeftOffset={rightWorkbenchMaximizedLeftOffset}
        onToggleMaximize={toggleRightPanelMaximize}
        onToggle={toggleRightPanel}
        browserBlocked={isSettingsOpen}
        workspaceRootPath={workspaceRootPath}
      /> : null}

      {isRightWorkbenchMaximized ? (
        <div
          data-testid="right-workbench-compact-composer"
          className="pointer-events-none absolute bottom-4 z-50 w-[min(780px,calc(100vw-128px))] max-w-[calc(100vw-32px)] -translate-x-1/2"
          style={{ left: `calc(${rightWorkbenchMaximizedLeftOffset}px + (100vw - ${rightWorkbenchMaximizedLeftOffset}px) / 2 - 24px)` }}
        >
          <LeaderChatPanel
            flowId={selectedFlowId}
            leaderAgentSessionId={leaderAgentSessionId}
            initialOptimisticMessages={selectedFlowId ? initialMessagesByFlow[selectedFlowId] ?? [] : []}
            flowStatus={dashboard.flowStatus || selectedFlowSummary?.status}
            decisionCardStatuses={decisionCardStatuses}
            decisionCardAnswers={decisionCardAnswers}
            decisionCards={dashboard.decisionCards}
            specCards={dashboard.specCards}
            orchestrationPlans={dashboard.orchestrationPlans}
            riskMode={dashboard.riskMode}
            planApproval={dashboard.planApproval}
            userTurns={dashboard.userTurns}
            onOpenSpecPreview={openSpecPreview}
            onOpenPlan={openOrchestrationPlan}
            review={workbench.review}
            onOpenReview={openReviewPanel}
            composerOnly
            composerVariant="compactFloating"
            composerValue={leaderComposerDraft}
            onComposerValueChange={handleLeaderComposerDraftChange}
            workspaceRootPath={workspaceRootPath}
            onOpenWorkspaceFile={openWorkspaceFile}
          />
        </div>
      ) : null}

      {flowSwitchOverlay ? (
        <div
          data-testid="flow-switch-loading-overlay"
          aria-hidden="true"
          className="absolute inset-y-0 right-0 z-[70] bg-background/92 backdrop-blur-[2px]"
          style={{ left: isLeftPanelOpen ? leftPanelWidth : 0 }}
        />
      ) : null}

      <NewFlowModal
        open={!!editingFlow}
        onClose={closeEditModal}
        onSubmit={(data) => handleSaveEdit(data, editingFlow?.id)}
        mode="edit"
        initialData={editingFlow ? { name: editingFlow.name, description: editingFlow.description, type: editingFlow.type } : undefined}
      />
      <DeleteFlowModal
        open={deleteModalFlow !== null}
        flowName={deleteModalFlow?.name ?? ''}
        onClose={closeDeleteModal}
        onConfirm={() => {
          const flowId = deleteModalFlow?.id;
          closeDeleteModal();
          if (flowId) void handleConfirmDelete(flowId);
        }}
      />
      <ClearAllFlowsModal
        open={showClearAllModal}
        count={flows.length}
        onClose={closeClearAllModal}
        onConfirm={() => {
          void confirmClearAllFlows();
          closeClearAllModal();
          setIsCreatingTask(true);
        }}
      />
      <AbortFlowModal
        open={abortModalFlow !== null}
        flowName={abortModalFlow?.name ?? ''}
        onClose={closeAbortModal}
        onConfirm={() => { handleAbort(abortModalFlow!.id); closeAbortModal(); }}
      />
      <AppSettingsDialog
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        initialSection={settingsInitialSection}
        initialAgentTab={settingsInitialAgentTab}
      />
    </div>
  );
}
