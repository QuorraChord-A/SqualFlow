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
  AlertDialogMedia,
} from '@/components/ui/alert-dialog';

interface ClearAllFlowsModalProps {
  open: boolean;
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}

export default function ClearAllFlowsModal({ open, count, onClose, onConfirm }: ClearAllFlowsModalProps) {
  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10">
            <svg className="text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </AlertDialogMedia>
          <AlertDialogTitle>清除所有 Flow</AlertDialogTitle>
          <AlertDialogDescription>
            确定要清除所有 <span className="font-medium text-destructive">{count}</span> 个 Flow 吗？
            此操作将永久删除所有 Flow 及其相关数据，包括阶段记录、消息历史和会话日志。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            确认清除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
