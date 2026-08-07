"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, getViewportForBounds, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeTypes, type ReactFlowInstance } from "@xyflow/react";
import { Code2, FlaskConical, Search, ShieldCheck } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { OrchestrationNodeView } from "../../types/orchestration";

const expertMeta = {
  "exp-research": { label: "Research", icon: Search },
  "exp-coder": { label: "Coder", icon: Code2 },
  "exp-verify": { label: "Verify", icon: FlaskConical },
  "exp-codereview": { label: "CodeReview", icon: ShieldCheck },
} as const;

function role(node: OrchestrationNodeView) {
  return expertMeta[node.recommended_agent_definition_id as keyof typeof expertMeta]
    ?? { label: node.recommended_agent_definition_id, icon: Code2 };
}

function status(node: OrchestrationNodeView) {
  switch (node.task?.status) {
    case "in_progress":
      return { label: "执行中", dot: "animate-pulse bg-status-running" };
    case "completed":
      return { label: "已完成", dot: "bg-status-completed" };
    case "failed":
      return { label: "失败", dot: "bg-destructive" };
    case "cancelled":
      return { label: "已取消", dot: "bg-muted-foreground" };
    case "pending":
    case "queued_for_expert":
    case "recovery_pending":
      return { label: "等待依赖", dot: "bg-muted-foreground" };
    default:
      return { label: "计划中", dot: "bg-status-pending" };
  }
}

type GraphNodeData = Record<string, unknown> & {
  node: OrchestrationNodeView;
  compact: boolean;
  inspectOpen: boolean;
  onInspect: (nodeId: string) => void;
  onSelect?: (nodeId: string) => void;
};
type GraphNode = Node<GraphNodeData, "orchestrationNode">;

function OrchestrationNode({ data, selected }: NodeProps<GraphNode>) {
  const meta = role(data.node);
  const taskStatus = status(data.node);
  const Icon = meta.icon;
  const content = (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        if (data.compact) data.onInspect(data.node.orchestration_node_id);
        else data.onSelect?.(data.node.orchestration_node_id);
      }}
      className={`grid text-left border bg-card shadow-[var(--ui-shadow-elevated)] transition-colors ${data.compact ? "w-[172px] grid-cols-[26px_minmax(0,1fr)] gap-2 rounded-lg px-2.5 py-2" : "w-[194px] grid-cols-[30px_minmax(0,1fr)] gap-2.5 rounded-xl px-3 py-2.5"} ${selected ? "border-primary ring-2 ring-primary/15" : "border-ui-border-strong hover:border-foreground/35"}`}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-border !bg-card" />
      <span className="flex size-7 items-center justify-center rounded-lg bg-secondary"><Icon className="size-3.5" /></span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
          <span>{meta.label}</span>
          <span className={`size-1.5 rounded-full ${taskStatus.dot}`} />
          {!data.compact ? <span className="truncate font-medium">{taskStatus.label}</span> : null}
        </span>
        <span className={`mt-1 block font-semibold leading-snug text-foreground ${data.compact ? "text-[11px]" : "text-xs"}`}>{data.node.title}</span>
      </span>
      <Handle type="source" position={Position.Right} className="!size-2 !border-border !bg-card" />
    </button>
  );
  if (!data.compact) return content;
  return (
    <Popover open={data.inspectOpen} onOpenChange={(open) => { if (open) data.onInspect(data.node.orchestration_node_id); else data.onInspect(""); }}>
      <PopoverTrigger render={content} />
      <PopoverContent side="top" align="center" className="w-80 gap-2.5 p-4">
        <div className="text-[11px] font-semibold text-muted-foreground">{meta.label}</div>
        <div className="text-sm font-semibold text-foreground">{data.node.title}</div>
        <p className="text-sm leading-6 text-muted-foreground">{data.node.description}</p>
      </PopoverContent>
    </Popover>
  );
}

const nodeTypes: NodeTypes = { orchestrationNode: OrchestrationNode };

function layout(nodes: OrchestrationNodeView[], compact: boolean) {
  const depthMemo = new Map<string, number>();
  const byId = new Map(nodes.map((node) => [node.orchestration_node_id, node]));
  const depth = (node: OrchestrationNodeView, visiting = new Set<string>()): number => {
    const cached = depthMemo.get(node.orchestration_node_id);
    if (cached !== undefined) return cached;
    if (visiting.has(node.orchestration_node_id)) return 0;
    visiting.add(node.orchestration_node_id);
    const value = node.depends_on_node_ids.length === 0 ? 0 : 1 + Math.max(...node.depends_on_node_ids.map((id) => byId.get(id)).filter(Boolean).map((parent) => depth(parent!, visiting)));
    depthMemo.set(node.orchestration_node_id, value);
    return value;
  };
  const groups = new Map<number, OrchestrationNodeView[]>();
  nodes.forEach((node) => groups.set(depth(node), [...(groups.get(depth(node)) ?? []), node]));
  const xStep = compact ? 205 : 242;
  const yStep = compact ? 92 : 112;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, group] of groups) {
    const offset = -((group.length - 1) * yStep) / 2;
    group.forEach((node, index) => positions.set(node.orchestration_node_id, { x: level * xStep, y: 120 + offset + index * yStep }));
  }
  return positions;
}

export function buildPlanEdges(orchestrationNodes: OrchestrationNodeView[]): Edge[] {
  return orchestrationNodes.flatMap((node) => node.depends_on_node_ids.map((dependency) => ({
    id: `${dependency}-${node.orchestration_node_id}`,
    source: dependency,
    target: node.orchestration_node_id,
    type: "smoothstep",
    animated: !node.task || ["in_progress", "queued_for_expert", "recovery_pending"].includes(node.task.status),
  })));
}

export default function OrchestrationPlanGraph({
  orchestrationNodes,
  compact = false,
  selectedNodeId,
  onSelectNode,
}: {
  orchestrationNodes: OrchestrationNodeView[];
  compact?: boolean;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
}) {
  const [inspectNodeId, setInspectNodeId] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance<GraphNode, Edge> | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  useEffect(() => setInspectNodeId(""), [orchestrationNodes]);
  const positions = useMemo(() => layout(orchestrationNodes, compact), [compact, orchestrationNodes]);
  const planBounds = useMemo(() => {
    const nodeWidth = compact ? 172 : 194;
    const nodeHeight = compact ? 56 : 68;
    const points = orchestrationNodes.map((node) => positions.get(node.orchestration_node_id) ?? { x: 0, y: 0 });
    if (points.length === 0) return { x: 0, y: 0, width: nodeWidth, height: nodeHeight };
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x)) + nodeWidth;
    const maxY = Math.max(...points.map((point) => point.y)) + nodeHeight;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [compact, orchestrationNodes, positions]);
  const nodes = useMemo<GraphNode[]>(() => orchestrationNodes.map((node) => ({
    id: node.orchestration_node_id,
    type: "orchestrationNode",
    position: positions.get(node.orchestration_node_id) ?? { x: 0, y: 0 },
    initialWidth: compact ? 172 : 194,
    initialHeight: compact ? 56 : 68,
    selected: node.orchestration_node_id === selectedNodeId,
    data: { node, compact, inspectOpen: inspectNodeId === node.orchestration_node_id, onInspect: setInspectNodeId, onSelect: onSelectNode },
  })), [compact, inspectNodeId, onSelectNode, orchestrationNodes, positions, selectedNodeId]);
  const edges = useMemo<Edge[]>(() => buildPlanEdges(orchestrationNodes), [orchestrationNodes]);
  const fitPlan = useCallback((instance = instanceRef.current) => {
    if (!instance) return;
    if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = window.requestAnimationFrame(() => {
        fitFrameRef.current = null;
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const viewport = getViewportForBounds(
          planBounds,
          rect.width,
          rect.height,
          compact ? 0.32 : 0.22,
          compact ? 0.72 : 0.68,
          compact ? 0.04 : 0.08,
        );
        void instance.setViewport(viewport);
      });
    });
  }, [compact, planBounds]);
  const handleInit = useCallback((instance: ReactFlowInstance<GraphNode, Edge>) => {
    instanceRef.current = instance;
    fitPlan(instance);
  }, [fitPlan]);
  useEffect(() => {
    if (orchestrationNodes.length > 0) fitPlan();
  }, [fitPlan, orchestrationNodes]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitPlan());
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);
    };
  }, [fitPlan]);
  return (
    <div ref={containerRef} className={`orchestration-plan-graph h-full w-full ${compact ? "is-compact" : ""}`} data-testid={compact ? "chat-orchestration-graph" : "workbench-orchestration-graph"}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ includeHiddenNodes: true, padding: compact ? 0.04 : 0.08, minZoom: compact ? 0.38 : 0.28, maxZoom: compact ? 0.72 : 0.68 }}
        minZoom={compact ? 0.32 : 0.22}
        maxZoom={compact ? 0.9 : 1.4}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        preventScrolling
        elementsSelectable={false}
        onInit={handleInit}
      >
        <Background gap={22} size={1} />
        <Controls
          showInteractive={false}
          fitViewOptions={{ includeHiddenNodes: true, padding: compact ? 0.04 : 0.08, minZoom: compact ? 0.38 : 0.28, maxZoom: compact ? 0.72 : 0.68 }}
          onFitView={() => fitPlan()}
        />
      </ReactFlow>
    </div>
  );
}
