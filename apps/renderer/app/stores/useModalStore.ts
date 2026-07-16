'use client';

import { create } from 'zustand';
import type { SquadFlow } from '../types';

interface ModalState {
  showNewFlowModal: boolean;
  editingFlow: SquadFlow | null;
  deleteModalFlow: SquadFlow | null;
  showClearAllModal: boolean;
  abortModalFlow: SquadFlow | null;

  openNewFlowModal: () => void;
  closeNewFlowModal: () => void;
  openEditModal: (flow: SquadFlow) => void;
  closeEditModal: () => void;
  openDeleteModal: (flow: SquadFlow) => void;
  closeDeleteModal: () => void;
  openClearAllModal: () => void;
  closeClearAllModal: () => void;
  openAbortModal: (flow: SquadFlow) => void;
  closeAbortModal: () => void;
}

export const useModalStore = create<ModalState>((set) => ({
  showNewFlowModal: false,
  editingFlow: null,
  deleteModalFlow: null,
  showClearAllModal: false,
  abortModalFlow: null,

  openNewFlowModal: () => set({ showNewFlowModal: true }),
  closeNewFlowModal: () => set({ showNewFlowModal: false }),
  openEditModal: (flow: SquadFlow) => set({ editingFlow: flow }),
  closeEditModal: () => set({ editingFlow: null }),
  openDeleteModal: (flow: SquadFlow) => set({ deleteModalFlow: flow }),
  closeDeleteModal: () => set({ deleteModalFlow: null }),
  openClearAllModal: () => set({ showClearAllModal: true }),
  closeClearAllModal: () => set({ showClearAllModal: false }),
  openAbortModal: (flow: SquadFlow) => set({ abortModalFlow: flow }),
  closeAbortModal: () => set({ abortModalFlow: null }),
}));