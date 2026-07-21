'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { FlowType } from '../types';

interface NewFlowModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: { name: string; type: FlowType; mode: 'create' | 'edit' }) => void;
  mode?: 'create' | 'edit';
  initialData?: { name: string; type: FlowType };
  nameLocked?: boolean;
}

export default function NewFlowModal({ open, onClose, onSubmit, mode = 'create', initialData, nameLocked = false }: NewFlowModalProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<FlowType>('full');

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setType(initialData.type);
    } else {
      setName('');
      setType('full');
    }
  }, [initialData]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), type, mode });
    setName('');
    setType('full');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b border-border">
          <DialogTitle>{mode === 'create' ? '新建流程' : '修改流程'}</DialogTitle>
          <DialogDescription className="sr-only">
            {mode === 'create' ? '创建一个新流程' : '修改现有流程的信息'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={nameLocked}
              placeholder="输入流程名称"
              className="w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm bg-background text-foreground"
              autoFocus
            />
          </div>

        </form>

        <DialogFooter className="px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!name.trim() || nameLocked}
            onClick={handleSubmit}
          >
            {mode === 'create' ? '创建' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
