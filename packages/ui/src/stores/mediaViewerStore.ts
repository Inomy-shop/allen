import { create } from 'zustand';
import type { MediaKind } from '../lib/resource-navigation';

export interface MediaViewerItem {
  src: string;
  title: string;
  kind: MediaKind;
  mimeType?: string;
  downloadUrl?: string;
}

interface MediaViewerState {
  item: MediaViewerItem | null;
  openMedia: (item: MediaViewerItem) => void;
  closeMedia: () => void;
}

export const useMediaViewerStore = create<MediaViewerState>((set) => ({
  item: null,
  openMedia: (item) => set({ item }),
  closeMedia: () => set({ item: null }),
}));
