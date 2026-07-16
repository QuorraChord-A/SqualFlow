'use client';

import { CheckIcon, FolderIcon, FolderXIcon } from 'lucide-react';
import { useState } from 'react';
import type { Project } from '../types';

interface FlowProjectPickerProps {
  projects: Project[];
  value: string | null;
  disabled?: boolean;
  isLoading?: boolean;
  onChange: (projectId: string | null) => void;
}

export default function FlowProjectPicker({
  projects,
  value,
  disabled = false,
  isLoading = false,
  onChange,
}: FlowProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = projects.find((p) => p.id === value);
  const label = selected?.name || '不使用项目';

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {selected ? <FolderIcon className="h-3.5 w-3.5" /> : <FolderXIcon className="h-3.5 w-3.5" />}
        <span className="max-w-48 truncate">{isLoading ? '加载项目...' : label}</span>
      </button>

      {open && !disabled && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-lg border border-border bg-popover p-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
          >
            <FolderXIcon className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">不使用项目</span>
            {value === null && <CheckIcon className="h-4 w-4" />}
          </button>

          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => {
                onChange(project.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
            >
              <FolderIcon className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 truncate">{project.name}</span>
              {value === project.id && <CheckIcon className="h-4 w-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
