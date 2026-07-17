'use client';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

interface AbortFlowModalProps {
  open: boolean;
  flowName: string;
  onClose: () => void;
  onConfirm: () => void;
}

export default function AbortFlowModal({ open, flowName, onClose, onConfirm }: AbortFlowModalProps) {
  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>终止流程</AlertDialogTitle>
          <AlertDialogDescription>
            确定要终止 <span className="text-foreground font-medium">&quot;{flowName}&quot;</span> 吗？此操作将停止当前运行的流程，且不可恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            确认终止
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
