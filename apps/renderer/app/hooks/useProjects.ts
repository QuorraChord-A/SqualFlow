'use client';

import { useProjectStore } from '../stores/useProjectStore';

export function useProjects() {
  const projects = useProjectStore((state) => state.projects);
  const isLoading = useProjectStore((state) => state.isLoading);
  return { projects, isLoading };
}
