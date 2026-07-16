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
          <DialogTitle>{mode === 'create' ? '新建任务' : '修改任务'}</DialogTitle>
          <DialogDescription className="sr-only">
            {mode === 'create' ? '创建一个新任务' : '修改现有任务的信息'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入任务名称"
              className="w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm bg-background text-foreground"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述这个任务的目标"
              rows={3}
              className="w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm resize-none bg-background text-foreground"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">类型</label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setType('full')}
                disabled={mode === 'edit'}
                className={`flex-1 py-2.5 px-4 rounded-lg border-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  type === 'full'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-muted'
                }`}
              >
                <div className="flex flex-col items-center gap-1">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  full
                  <span className="text-xs font-normal text-muted-foreground">full iteration</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setType('quick')}
                disabled={mode === 'edit'}
                className={`flex-1 py-2.5 px-4 rounded-lg border-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  type === 'quick'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-muted'
                }`}
              >
                <div className="flex flex-col items-center gap-1">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  quick
                  <span className="text-xs font-normal text-muted-foreground">quick iteration</span>
                </div>
              </button>
            </div>
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
