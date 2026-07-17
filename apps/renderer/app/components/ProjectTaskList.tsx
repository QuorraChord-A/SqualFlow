'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  FolderPlus,
  ListTree,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import FlowItem from './FlowItem';
import { useFlowStore } from '../stores/useFlowStore';
import { useProjectStore } from '../stores/useProjectStore';
import type { Project, SquadFlow } from '../types';

interface ProjectTaskListProps {
  onNewTask: () => void;
  onRefresh: () => void;
  onSelectTask: (flow: SquadFlow) => void;
  onAbortFlow?: (flow: SquadFlow) => void;
  onEditFlow?: (flow: SquadFlow) => void;
  onDeleteFlow?: (flow: SquadFlow) => void;
}

type SidebarOrganization = 'project' | 'recent-projects' | 'chronological';
type SidebarSort = 'created' | 'updated';

const ORGANIZATION_STORAGE_KEY = 'squadflow-sidebar-organization';
const SORT_STORAGE_KEY = 'squadflow-sidebar-sort';

function projectDisplayName(project: Project) {
  return project.is_default ? '默认项目' : project.name;
}

function flowTimestamp(flow: SquadFlow, sort: SidebarSort) {
  return Date.parse(sort === 'created' ? flow.created_at : flow.updated_at);
}

function sortTasks(flows: SquadFlow[], sort: SidebarSort) {
  return [...flows].sort((a, b) => flowTimestamp(b, sort) - flowTimestamp(a, sort));
}

function readStoredPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key) as T | null;
    return stored && allowed.includes(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export default function ProjectTaskList({
  onNewTask,
  onRefresh,
  onSelectTask,
  onAbortFlow,
  onEditFlow,
  onDeleteFlow,
}: ProjectTaskListProps) {
  const { projects, openProjectDirectory, deleteProject } = useProjectStore();
  const { flows, selectedFlowId, setFlowPinned } = useFlowStore();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [organization, setOrganization] = useState<SidebarOrganization>('project');
  const [sort, setSort] = useState<SidebarSort>('updated');
  const [preferencesHydrated, setPreferencesHydrated] = useState(false);
  const previousExpandedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setOrganization(readStoredPreference(
      ORGANIZATION_STORAGE_KEY,
      ['project', 'recent-projects', 'chronological'] as const,
      'project',
    ));
    setSort(readStoredPreference(SORT_STORAGE_KEY, ['created', 'updated'] as const, 'updated'));
    setPreferencesHydrated(true);
  }, []);

  useEffect(() => {
    if (!preferencesHydrated) return;
    try {
      localStorage.setItem(ORGANIZATION_STORAGE_KEY, organization);
      localStorage.setItem(SORT_STORAGE_KEY, sort);
    } catch {
      // Keep the current session preference when storage is unavailable.
    }
  }, [organization, preferencesHydrated, sort]);

  const defaultProject = useMemo(
    () => projects.find((project) => project.is_default) ?? null,
    [projects],
  );

  useEffect(() => {
    setCollapsedIds((current) => {
      const next = new Set([...current].filter((id) => projects.some((project) => project.id === id)));
      return next.size === current.size ? current : next;
    });
  }, [projects]);

  const pinnedFlows = useMemo(
    () => sortTasks(flows.filter((flow) => Boolean(flow.is_pinned)), sort),
    [flows, sort],
  );
  const regularFlows = useMemo(
    () => flows.filter((flow) => !flow.is_pinned),
    [flows],
  );

  const flowsByProject = useMemo(() => {
    const grouped = new Map<string, SquadFlow[]>();
    for (const flow of regularFlows) {
      const key = flow.project_id || defaultProject?.id || '__default__';
      grouped.set(key, [...(grouped.get(key) ?? []), flow]);
    }
    for (const [key, items] of grouped) grouped.set(key, sortTasks(items, sort));
    return grouped;
  }, [defaultProject?.id, regularFlows, sort]);

  const orderedProjects = useMemo(() => {
    const projectLatestTime = (project: Project) => {
      const projectFlows = flows.filter((flow) => (flow.project_id || defaultProject?.id) === project.id);
      return projectFlows.reduce((latest, flow) => Math.max(latest, flowTimestamp(flow, sort)), 0);
    };

    return [...projects].sort((a, b) => {
      if (organization === 'recent-projects') {
        const recencyDifference = projectLatestTime(b) - projectLatestTime(a);
        if (recencyDifference !== 0) return recencyDifference;
      }
      if (Boolean(a.is_default) !== Boolean(b.is_default)) return a.is_default ? -1 : 1;
      return projectDisplayName(a).localeCompare(projectDisplayName(b), 'zh-CN');
    });
  }, [defaultProject?.id, flows, organization, projects, sort]);

  const allProjectsCollapsed = orderedProjects.length > 0
    && orderedProjects.every((project) => collapsedIds.has(project.id));

  const toggleProject = (projectId: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const collapseOrRestoreProjects = () => {
    if (organization === 'chronological' || orderedProjects.length === 0) return;

    if (allProjectsCollapsed) {
      const previousExpandedIds = previousExpandedIdsRef.current;
      if (previousExpandedIds.size === 0) {
        setCollapsedIds(new Set());
        return;
      }
      setCollapsedIds(new Set(
        orderedProjects
          .filter((project) => !previousExpandedIds.has(project.id))
          .map((project) => project.id),
      ));
      return;
    }

    previousExpandedIdsRef.current = new Set(
      orderedProjects
        .filter((project) => !collapsedIds.has(project.id))
        .map((project) => project.id),
    );
    setCollapsedIds(new Set(orderedProjects.map((project) => project.id)));
  };

  const handleAddProject = async () => {
    const project = await openProjectDirectory();
    if (project) onRefresh();
  };

  const handleDeleteProject = async (project: Project) => {
    if (project.is_default) return;
    const deleted = await deleteProject(project.id);
    if (deleted) onRefresh();
  };

  const renderTask = (flow: SquadFlow) => (
    <FlowItem
      key={flow.id}
      flow={flow}
      projectName={projects.find((project) => project.id === flow.project_id)?.name ?? (flow.project_id ? null : '默认项目')}
      projectPath={projects.find((project) => project.id === flow.project_id)?.local_path ?? (flow.project_id ? null : defaultProject?.local_path)}
      selected={selectedFlowId === flow.id}
      onClick={() => onSelectTask(flow)}
      onAbortFlow={onAbortFlow}
      onEditFlow={onEditFlow}
      onDeleteFlow={onDeleteFlow}
      onTogglePinned={(target) => void setFlowPinned(target.id, !target.is_pinned)}
      displayTimestamp={sort === 'created' ? flow.created_at : flow.updated_at}
    />
  );

  const projectControls = (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              onClick={collapseOrRestoreProjects}
              disabled={organization === 'chronological' || orderedProjects.length === 0}
              aria-label={allProjectsCollapsed ? '恢复之前展开的分组' : '全部收起'}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-35"
            />
          )}
        >
          {allProjectsCollapsed ? <Maximize2 className="size-3.5" /> : <Minimize2 className="size-3.5" />}
        </TooltipTrigger>
        <TooltipContent side="top">
          {organization === 'chronological'
            ? '按项目整理时可收起分组'
            : allProjectsCollapsed
              ? '恢复之前展开的分组'
              : '全部收起'}
        </TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="项目列表选项"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground data-popup-open:bg-sidebar-accent"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" sideOffset={6} className="w-40 p-1">
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
            整理
          </div>
          <DropdownMenuRadioGroup
            value={organization}
            onValueChange={(value) => setOrganization(value as SidebarOrganization)}
          >
            <DropdownMenuRadioItem value="project" className="px-2 py-1.5 text-[12px]">
              <Folder className="size-4 text-muted-foreground" />
              按项目
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="recent-projects" className="px-2 py-1.5 text-[12px]">
              <ListTree className="size-4 text-muted-foreground" />
              近期项目
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="chronological" className="px-2 py-1.5 text-[12px]">
              <Clock3 className="size-4 text-muted-foreground" />
              按时间顺序
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator className="my-1" />
          <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
            排序
          </div>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(value) => setSort(value as SidebarSort)}
          >
            <DropdownMenuRadioItem value="created" className="px-2 py-1.5 text-[12px]">
              <CalendarPlus className="size-4 text-muted-foreground" />
              创建时间
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="updated" className="px-2 py-1.5 text-[12px]">
              <RefreshCw className="size-4 text-muted-foreground" />
              更新时间
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              onClick={() => void handleAddProject()}
              aria-label="添加项目"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            />
          )}
        >
          <FolderPlus className="size-4" />
        </TooltipTrigger>
        <TooltipContent side="top">添加项目</TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-3 pt-16">
        <button
          type="button"
          onClick={onNewTask}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-sidebar-foreground/35 bg-sidebar px-3 text-sm font-semibold text-sidebar-foreground shadow-sm ring-1 ring-inset ring-sidebar-foreground/5 transition-[background-color,border-color,transform,box-shadow] hover:-translate-y-px hover:border-sidebar-foreground/55 hover:bg-sidebar-accent hover:shadow-md active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          新建流程
        </button>
      </div>

      <div className="sf-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-28">
        <div className="flex min-h-full flex-col gap-4">
          <section aria-labelledby="pinned-heading">
            <div className="flex items-center px-2 pb-1.5 pt-1">
              <h2 id="pinned-heading" className="text-[12px] font-semibold text-muted-foreground">置顶</h2>
            </div>
            <div>
              {pinnedFlows.length === 0
                ? <div className="px-2.5 py-1 text-xs text-muted-foreground/70">暂无置顶流程</div>
                : pinnedFlows.map(renderTask)}
            </div>
          </section>

          <section aria-labelledby="projects-heading">
            <div className="flex items-center justify-between px-2 pb-1.5">
              <h2 id="projects-heading" className="text-[12px] font-semibold text-muted-foreground">项目</h2>
              {projectControls}
            </div>

            {projects.length === 0 ? (
              <div className="px-2.5 py-8 text-center text-sm text-muted-foreground">暂无项目</div>
            ) : organization === 'chronological' ? (
              <div data-testid="chronological-task-list">
                {sortTasks(regularFlows, sort).length === 0
                  ? <div className="px-2.5 py-2 text-xs text-muted-foreground">暂无流程</div>
                  : sortTasks(regularFlows, sort).map(renderTask)}
              </div>
            ) : (
              <div className="space-y-1.5">
                {orderedProjects.map((project) => {
                  const projectFlows = flowsByProject.get(project.id) ?? [];
                  const allProjectFlows = flows.filter((flow) => (flow.project_id || defaultProject?.id) === project.id);
                  const collapsed = collapsedIds.has(project.id);
                  return (
                    <section key={project.id} data-testid={`project-group-${project.id}`}>
                      <div
                        className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70"
                        title={project.local_path}
                      >
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left"
                          aria-expanded={!collapsed}
                        >
                          <Folder className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{projectDisplayName(project)}</span>
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`${projectDisplayName(project)} 项目选项`}
                            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground data-popup-open:bg-sidebar-accent"
                          >
                            <MoreHorizontal className="size-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" side="right" sideOffset={6} className="w-36 p-1">
                            <DropdownMenuItem
                              disabled={Boolean(project.is_default)}
                              onClick={() => void handleDeleteProject(project)}
                              className="px-2 py-1.5 text-[12px] text-destructive focus:text-destructive disabled:text-muted-foreground"
                            >
                              <Trash2 className="size-3.5" />
                              删除项目
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          aria-label={collapsed ? `展开 ${projectDisplayName(project)}` : `折叠 ${projectDisplayName(project)}`}
                          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                        >
                          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                        </button>
                      </div>
                      <div
                        data-testid={`project-group-drawer-${project.id}`}
                        data-state={collapsed ? 'closed' : 'open'}
                        aria-hidden={collapsed}
                        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                          collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
                        }`}
                      >
                        <div
                          className={`min-h-0 overflow-hidden transition-[transform] duration-200 ease-out ${
                            collapsed ? '-translate-y-1' : 'translate-y-0'
                          }`}
                        >
                          <div className="ml-3 border-l border-sidebar-border pl-1.5">
                          {projectFlows.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-muted-foreground">
                              {allProjectFlows.length > 0 ? '流程已置顶' : '暂无流程'}
                            </div>
                          ) : (
                            projectFlows.map(renderTask)
                          )}
                          </div>
                        </div>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
