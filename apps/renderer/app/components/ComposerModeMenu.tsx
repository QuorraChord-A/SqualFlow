"use client";

import { Check, ClipboardList, ImagePlus, PencilLine, Plus, Settings2, ShieldAlert } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type RiskMode = "auto_edit" | "full_access";
export type PlanApproval = "on" | "off";

const modeOptions = [
  {
    value: "auto_edit" as const,
    label: "自动编辑",
    description: "自动写文件和运行命令，风险操作先确认",
    icon: PencilLine,
  },
  {
    value: "plan" as const,
    label: "计划模式",
    description: "本条消息先生成 Spec，批准前不执行",
    icon: ClipboardList,
  },
  {
    value: "full_access" as const,
    label: "完全访问",
    description: "风险操作也不确认，硬边界仍然有效",
    icon: ShieldAlert,
  },
];

const planApprovalOptions: Array<{ value: PlanApproval; label: string; description: string }> = [
  { value: "on", label: "需要批准", description: "Leader 提交编排计划后暂停，等待你批准。" },
  { value: "off", label: "自动执行", description: "编排计划通过校验后立即调度。" },
];

interface ComposerModeMenuProps {
  specRequested: boolean;
  riskMode?: RiskMode;
  planApproval?: PlanApproval;
  /** Once a Spec/Plan turn has been sent, only approval (or an explicit stop) may leave plan mode. */
  planModeLocked?: boolean;
  disabled?: boolean;
  onSpecChange: (requested: boolean) => void;
  onRiskModeChange?: (mode: RiskMode) => void;
  onPlanApprovalChange?: (approval: PlanApproval) => void;
  onAddImages?: (files: File[]) => void | Promise<void>;
}

export default function ComposerModeMenu({
  specRequested,
  riskMode = "auto_edit",
  planApproval = "on",
  planModeLocked = false,
  disabled = false,
  onSpecChange,
  onRiskModeChange,
  onPlanApprovalChange,
  onAddImages,
}: ComposerModeMenuProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [planApprovalDialogOpen, setPlanApprovalDialogOpen] = useState(false);
  const [rollDirection, setRollDirection] = useState(1);
  const openPlanApprovalDialogAfterMenuCloseRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const previousModeRef = useRef<(typeof modeOptions)[number]["value"] | null>(null);
  const reduceMotion = useReducedMotion();
  const selectedMode = specRequested ? "plan" : riskMode;
  const selectedOption = modeOptions.find((option) => option.value === selectedMode) ?? modeOptions[0];
  const selectedPlanApproval = planApprovalOptions.find((option) => option.value === planApproval) ?? planApprovalOptions[0];
  const isFullAccess = selectedMode === "full_access";

  useEffect(() => {
    const previousMode = previousModeRef.current;
    if (previousMode && previousMode !== selectedMode) {
      const previousIndex = modeOptions.findIndex((option) => option.value === previousMode);
      const nextIndex = modeOptions.findIndex((option) => option.value === selectedMode);
      setRollDirection(nextIndex >= previousIndex ? 1 : -1);
    }
    previousModeRef.current = selectedMode;
  }, [selectedMode]);

  const selectMode = (value: (typeof modeOptions)[number]["value"]) => {
    if (planModeLocked && value !== "plan") return;
    const currentIndex = modeOptions.findIndex((option) => option.value === selectedMode);
    const nextIndex = modeOptions.findIndex((option) => option.value === value);
    setRollDirection(nextIndex >= currentIndex ? 1 : -1);
    if (value === "plan") {
      onSpecChange(true);
    } else {
      onSpecChange(false);
      onRiskModeChange?.(value);
    }
    setModeMenuOpen(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) void onAddImages?.(files);
        }}
      />
      <Popover
        open={addMenuOpen}
        onOpenChange={setAddMenuOpen}
        onOpenChangeComplete={(open) => {
          if (open || !openPlanApprovalDialogAfterMenuCloseRef.current) return;
          openPlanApprovalDialogAfterMenuCloseRef.current = false;
          setPlanApprovalDialogOpen(true);
        }}
      >
        <PopoverTrigger
          type="button"
          aria-label="添加消息选项"
          disabled={disabled}
          className={`flex size-7 shrink-0 items-center justify-center rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
            addMenuOpen
              ? "rotate-45 bg-foreground text-background"
              : "bg-ui-control text-muted-foreground hover:bg-ui-control-hover hover:text-foreground"
          }`}
        >
          <Plus className="size-[15px]" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className="w-[min(360px,calc(100vw-40px))] gap-0 rounded-2xl border border-ui-border-strong bg-[color-mix(in_srgb,var(--ui-surface-raised)_94%,var(--background))] p-1.5 shadow-[var(--ui-shadow-dialog)] ring-0"
        >
          {onAddImages ? (
            <>
              <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">添加</div>
              <button
                type="button"
                aria-label="添加图片"
                onClick={() => {
                  setAddMenuOpen(false);
                  window.setTimeout(() => imageInputRef.current?.click(), 0);
                }}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-ui-control-hover"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ui-control text-muted-foreground">
                  <ImagePlus className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-foreground">图片</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">PNG、JPEG、WebP 或 GIF</span>
                </span>
              </button>
              <div className="mx-2 my-1 h-px bg-ui-border-subtle" />
            </>
          ) : null}
          <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">Flow 设置</div>
          <button
            type="button"
            aria-label={`编排审批设置，当前：${selectedPlanApproval.label}`}
            onClick={() => {
              openPlanApprovalDialogAfterMenuCloseRef.current = true;
              setAddMenuOpen(false);
            }}
            className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-ui-control-hover"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ui-control text-muted-foreground">
              <Settings2 className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-foreground">编排审批设置</span>
                <span className="rounded-md bg-ui-control px-1.5 py-0.5 text-[10px] font-semibold leading-none text-foreground">
                  {selectedPlanApproval.label}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                {selectedPlanApproval.description}
              </span>
            </span>
          </button>
        </PopoverContent>
      </Popover>

      <Popover open={modeMenuOpen} onOpenChange={setModeMenuOpen}>
        <PopoverTrigger
          type="button"
          aria-label={`执行模式：${selectedOption.label}`}
          data-mode={selectedMode}
          disabled={disabled}
          className={`inline-flex h-7 max-w-[132px] items-center overflow-hidden rounded-lg px-2 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
            isFullAccess
              ? "text-orange-700 hover:bg-orange-500/10 hover:text-orange-700 dark:text-orange-500 dark:hover:text-orange-500"
              : "text-muted-foreground hover:bg-ui-control hover:text-foreground"
          }`}
        >
          <AnimatePresence initial={false} mode="popLayout" custom={rollDirection}>
            <motion.span
              key={selectedMode}
              custom={rollDirection}
              initial={reduceMotion ? false : { opacity: 0, y: rollDirection * 11 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: rollDirection * -11 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="inline-flex min-w-0 items-center gap-1.5"
            >
              <selectedOption.icon className="size-3.5 shrink-0" />
              <span className="truncate">{selectedOption.label}</span>
            </motion.span>
          </AnimatePresence>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className="w-[min(340px,calc(100vw-40px))] gap-0 rounded-2xl border border-ui-border-strong bg-[color-mix(in_srgb,var(--ui-surface-raised)_92%,var(--background))] p-1.5 shadow-[var(--ui-shadow-overlay)] ring-0"
        >
          {modeOptions.map((option) => {
            const Icon = option.icon;
            const optionLocked = planModeLocked && option.value !== "plan";
            return (
              <button
                key={option.value}
                type="button"
                aria-label={`${option.label}：${option.description}`}
                aria-pressed={selectedMode === option.value}
                disabled={disabled || optionLocked}
                onClick={() => selectMode(option.value)}
                className={`flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-ui-control-hover disabled:cursor-not-allowed disabled:opacity-45 ${
                  selectedMode === option.value ? "bg-ui-control" : ""
                }`}
              >
                <Icon className={`size-4 shrink-0 ${option.value === "full_access" && selectedMode === option.value ? "text-orange-700 dark:text-orange-500" : "text-muted-foreground"}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] font-semibold ${option.value === "full_access" && selectedMode === option.value ? "text-orange-700 dark:text-orange-500" : "text-foreground"}`}>{option.label}</span>
                  <span className="block text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                </span>
                {selectedMode === option.value ? <Check className={`size-4 shrink-0 ${option.value === "full_access" ? "text-orange-700 dark:text-orange-500" : "text-foreground"}`} /> : null}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      <Dialog open={planApprovalDialogOpen} onOpenChange={setPlanApprovalDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>编排审批设置</DialogTitle>
            <DialogDescription>只控制编排计划是否需要批准，与 Agent 执行权限无关。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-1">
            {planApprovalOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={option.label}
                aria-pressed={planApproval === option.value}
                onClick={() => {
                  onPlanApprovalChange?.(option.value);
                  setPlanApprovalDialogOpen(false);
                }}
                className="flex min-h-16 items-center gap-3 rounded-xl border border-border px-3 py-2 text-left transition-colors hover:bg-ui-control-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{option.description}</span>
                </span>
                {planApproval === option.value ? <Check className="size-4 shrink-0" /> : null}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
