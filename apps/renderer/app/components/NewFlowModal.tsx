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
  onSubmit: (data: { name: string; description: string; type: FlowType; mode: 'create' | 'edit' }) => void;
  mode?: 'create' | 'edit';
  initialData?: { name: string; description: string; type: FlowType };
}

export default function NewFlowModal({ open, onClose, onSubmit, mode = 'create', initialData }: NewFlowModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<FlowType>('full');

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setDescription(initialData.description);
      setType(initialData.type);
    } else {
      setName('');
      setDescription('');
      setType('full');
    }
  }, [initialData]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), description: (description ?? '').trim(), type, mode });
    setName('');
    setDescription('');
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
              placeholder="输入流程名称"
              className="w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm bg-background text-foreground"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述这个流程的目标"
              rows={3}
              className="w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm resize-none bg-background text-foreground"
            />
          </div>

        </form>

        <DialogFooter className="px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={handleSubmit}
          >
            {mode === 'create' ? '创建' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
