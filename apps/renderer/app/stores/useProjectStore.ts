'use client';

import { create } from 'zustand';
import type { Project } from '../types';
import { API_BASE } from '../lib/api';

const SELECTED_PROJECT_STORAGE_KEY = 'squadflow-selected-project-id';

interface DirectorySelection {
  local_path: string;
  name: string;
}

interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;
  isLoading: boolean;
  refreshProjects: () => Promise<void>;
  selectProject: (projectId: string | null) => void;
  openProjectDirectory: () => Promise<Project | null>;
  createProject: (name: string) => Promise<{ project: Project | null; error?: string }>;
  deleteProject: (projectId: string) => Promise<boolean>;
  init: () => Promise<void>;
}

function readStoredProjectId() {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistProjectId(projectId: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (projectId) localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
    else localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
  } catch {
    // Keep the in-memory selection when browser storage is unavailable.
  }
}

function logProjectRequestFailure(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[project-store] ${scope}: ${message}`);
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectId: null,
  isLoading: false,

  refreshProjects: async () => {
    set({ isLoading: true });
    try {
      const response = await fetch(`${API_BASE}/api/projects`);
      if (!response.ok) return;
      const projects = await response.json() as Project[];
      const currentId = get().selectedProjectId;
      const storedId = readStoredProjectId();
      const selectedProjectId = projects.some((project) => project.id === currentId)
        ? currentId
        : projects.some((project) => project.id === storedId)
          ? storedId
          : projects[0]?.id ?? null;
      set({ projects, selectedProjectId });
      persistProjectId(selectedProjectId);
    } catch (error) {
      logProjectRequestFailure('failed to refresh projects', error);
    } finally {
      set({ isLoading: false });
    }
  },

  selectProject: (projectId) => {
    set({ selectedProjectId: projectId });
    persistProjectId(projectId);
  },

  openProjectDirectory: async () => {
    try {
      const pickerResponse = await fetch(`${API_BASE}/api/system/select-directory`, { method: 'POST' });
      if (pickerResponse.status === 204) return null;
      if (!pickerResponse.ok) throw new Error(`directory picker failed: ${pickerResponse.status}`);
      const selection = await pickerResponse.json() as DirectorySelection;

      const existing = get().projects.find((project) => project.local_path === selection.local_path);
      if (existing) {
        get().selectProject(existing.id);
        return existing;
      }

      const createResponse = await fetch(`${API_BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: selection.name,
          local_path: selection.local_path,
          description: '',
        }),
      });
      if (!createResponse.ok) throw new Error(`project creation failed: ${createResponse.status}`);
      const project = await createResponse.json() as Project;
      await get().refreshProjects();
      get().selectProject(project.id);
      return project;
    } catch (error) {
      logProjectRequestFailure('failed to open project directory', error);
      return null;
    }
  },

  createProject: async (name) => {
    try {
      const response = await fetch(`${API_BASE}/api/projects/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { detail?: string };
        return { project: null, error: body.detail || '创建项目失败' };
      }
      const project = await response.json() as Project;
      await get().refreshProjects();
      get().selectProject(project.id);
      return { project };
    } catch (error) {
      logProjectRequestFailure('failed to create project', error);
      return { project: null, error: '创建项目失败' };
    }
  },

  deleteProject: async (projectId) => {
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE' });
      if (!response.ok) return false;
      if (get().selectedProjectId === projectId) {
        set({ selectedProjectId: null });
        persistProjectId(null);
      }
      await get().refreshProjects();
      return true;
    } catch (error) {
      logProjectRequestFailure('failed to delete project', error);
      return false;
    }
  },

  init: async () => {
    await get().refreshProjects();
  },
}));
