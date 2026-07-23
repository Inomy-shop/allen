import { create } from 'zustand';
import { artifacts as artifactsApi, type ArtifactDoc } from '../services/api';
import { mediaKindForPath, mimeTypeForMediaPath } from '../lib/resource-navigation';
import { useMediaViewerStore } from './mediaViewerStore';

export const DEFAULT_RESOURCE_SCOPE = 'surface:global';

export function resourceScopeKey(type: 'chat' | 'execution' | 'workflow' | 'agent' | 'workspace' | 'surface', id: string): string {
  return `${type}:${id}`;
}

export interface DocumentTab {
  artifact: ArtifactDoc;
  sourceLabel: string;
  scopeKey: string;
}

export interface FileTab {
  key: string;
  path: string;
  content: string;
  sourceKind: 'workspace' | 'repo' | 'upload';
  sourceId: string;
  sourceLabel: string;
  scopeKey: string;
  language?: string;
}

interface OpenDocumentOptions {
  sourceLabel?: string;
  scopeKey?: string;
}

export type OpenFileOptions = Omit<FileTab, 'key' | 'scopeKey'> & { scopeKey?: string };

type ScopeSelection = {
  activeArtifactId: string | null;
  activeFileKey: string | null;
};

interface DocumentTabState {
  tabs: DocumentTab[];
  activeArtifactId: string | null;
  fileTabs: FileTab[];
  activeFileKey: string | null;
  activeScopeKey: string;
  selections: Record<string, ScopeSelection>;
  setActiveScope: (scopeKey: string) => void;
  openDocument: (artifact: ArtifactDoc, options?: OpenDocumentOptions) => void;
  openFile: (file: OpenFileOptions) => void;
  selectBaseTab: (scopeKey?: string) => void;
  selectDocument: (artifactId: string, scopeKey?: string) => void;
  selectFile: (key: string, scopeKey?: string) => void;
  closeDocument: (artifactId: string, scopeKey?: string) => void;
  closeFile: (key: string, scopeKey?: string) => void;
  closeAllDocuments: (scopeKey?: string) => void;
  closeAllFiles: (scopeKey?: string) => void;
}

export function fileTabKey(file: Pick<OpenFileOptions, 'sourceKind' | 'sourceId' | 'path'>, scopeKey = DEFAULT_RESOURCE_SCOPE): string {
  return `${scopeKey}:${file.sourceKind}:${file.sourceId}:${file.path}`;
}

function selection(state: Pick<DocumentTabState, 'selections'>, scopeKey: string): ScopeSelection {
  return state.selections[scopeKey] ?? { activeArtifactId: null, activeFileKey: null };
}

function selectedScopePatch(
  state: Pick<DocumentTabState, 'activeScopeKey' | 'selections'>,
  scopeKey: string,
  next: ScopeSelection,
) {
  return {
    selections: { ...state.selections, [scopeKey]: next },
    ...(state.activeScopeKey === scopeKey ? next : {}),
  };
}

export const useDocumentTabStore = create<DocumentTabState>((set) => ({
  tabs: [],
  activeArtifactId: null,
  fileTabs: [],
  activeFileKey: null,
  activeScopeKey: DEFAULT_RESOURCE_SCOPE,
  selections: {},
  setActiveScope: (scopeKey) => set((state) => {
    const normalized = scopeKey || DEFAULT_RESOURCE_SCOPE;
    const current = selection(state, normalized);
    return { activeScopeKey: normalized, ...current };
  }),
  openDocument: (artifact, options) => {
    const mediaKind = mediaKindForPath(artifact.filename);
    if (mediaKind) {
      const src = artifactsApi.contentUrl(artifact.artifactId);
      useMediaViewerStore.getState().openMedia({
        kind: mediaKind,
        src,
        downloadUrl: src,
        title: artifact.filename,
        mimeType: mimeTypeForMediaPath(artifact.filename, mediaKind) ?? undefined,
      });
      return;
    }
    set((state) => {
      const scopeKey = options?.scopeKey || state.activeScopeKey || DEFAULT_RESOURCE_SCOPE;
      const existing = state.tabs.find(tab => tab.scopeKey === scopeKey && tab.artifact.artifactId === artifact.artifactId);
      const sourceLabel = options?.sourceLabel?.trim() || existing?.sourceLabel || 'Back';
      const nextSelection = { activeArtifactId: artifact.artifactId, activeFileKey: null };
      const isActiveScope = state.activeScopeKey === scopeKey;
      return {
        tabs: existing
          ? state.tabs.map(tab => tab.scopeKey === scopeKey && tab.artifact.artifactId === artifact.artifactId
            ? { artifact, sourceLabel, scopeKey }
            : tab)
          : [...state.tabs, { artifact, sourceLabel, scopeKey }],
        ...(isActiveScope ? nextSelection : {}),
        selections: { ...state.selections, [scopeKey]: nextSelection },
      };
    });
  },
  openFile: (file) => set((state) => {
    const scopeKey = file.scopeKey || state.activeScopeKey || DEFAULT_RESOURCE_SCOPE;
    const key = fileTabKey(file, scopeKey);
    const nextFile = { ...file, scopeKey, key };
    const exists = state.fileTabs.some(tab => tab.key === key);
    const nextSelection = { activeFileKey: key, activeArtifactId: null };
    const isActiveScope = state.activeScopeKey === scopeKey;
    return {
      fileTabs: exists
        ? state.fileTabs.map(tab => tab.key === key ? nextFile : tab)
        : [...state.fileTabs, nextFile],
      ...(isActiveScope ? nextSelection : {}),
      selections: { ...state.selections, [scopeKey]: nextSelection },
    };
  }),
  selectBaseTab: (requestedScope) => set((state) => {
    const scopeKey = requestedScope || state.activeScopeKey;
    return selectedScopePatch(state, scopeKey, { activeArtifactId: null, activeFileKey: null });
  }),
  selectDocument: (artifactId, requestedScope) => set((state) => {
    const tab = state.tabs.find(item => item.artifact.artifactId === artifactId && (!requestedScope || item.scopeKey === requestedScope));
    if (!tab) return state;
    const next = { activeArtifactId: artifactId, activeFileKey: null };
    return { activeScopeKey: tab.scopeKey, ...next, selections: { ...state.selections, [tab.scopeKey]: next } };
  }),
  selectFile: (key, requestedScope) => set((state) => {
    const tab = state.fileTabs.find(item => item.key === key && (!requestedScope || item.scopeKey === requestedScope));
    if (!tab) return state;
    const next = { activeFileKey: key, activeArtifactId: null };
    return { activeScopeKey: tab.scopeKey, ...next, selections: { ...state.selections, [tab.scopeKey]: next } };
  }),
  closeDocument: (artifactId, requestedScope) => set((state) => {
    const scopeKey = requestedScope || state.activeScopeKey;
    const scopedTabs = state.tabs.filter(tab => tab.scopeKey === scopeKey);
    const closingIndex = scopedTabs.findIndex(tab => tab.artifact.artifactId === artifactId);
    if (closingIndex < 0) return state;
    const tabs = state.tabs.filter(tab => !(tab.scopeKey === scopeKey && tab.artifact.artifactId === artifactId));
    const current = selection(state, scopeKey);
    if (current.activeArtifactId !== artifactId) return { tabs };
    const remaining = tabs.filter(tab => tab.scopeKey === scopeKey);
    const fallback = remaining[Math.min(closingIndex, remaining.length - 1)] ?? remaining[remaining.length - 1];
    const scopedFiles = state.fileTabs.filter(tab => tab.scopeKey === scopeKey);
    const next = {
      activeArtifactId: fallback?.artifact.artifactId ?? null,
      activeFileKey: fallback ? null : scopedFiles[scopedFiles.length - 1]?.key ?? null,
    };
    return { tabs, ...selectedScopePatch(state, scopeKey, next) };
  }),
  closeFile: (key, requestedScope) => set((state) => {
    const tabToClose = state.fileTabs.find(tab => tab.key === key && (!requestedScope || tab.scopeKey === requestedScope));
    if (!tabToClose) return state;
    const scopeKey = tabToClose.scopeKey;
    const scopedFiles = state.fileTabs.filter(tab => tab.scopeKey === scopeKey);
    const closingIndex = scopedFiles.findIndex(tab => tab.key === key);
    const fileTabs = state.fileTabs.filter(tab => tab.key !== key);
    const current = selection(state, scopeKey);
    if (current.activeFileKey !== key) return { fileTabs };
    const remaining = fileTabs.filter(tab => tab.scopeKey === scopeKey);
    const fallback = remaining[Math.min(closingIndex, remaining.length - 1)] ?? remaining[remaining.length - 1];
    const scopedDocs = state.tabs.filter(tab => tab.scopeKey === scopeKey);
    const next = {
      activeFileKey: fallback?.key ?? null,
      activeArtifactId: fallback ? null : scopedDocs[scopedDocs.length - 1]?.artifact.artifactId ?? null,
    };
    return { fileTabs, ...selectedScopePatch(state, scopeKey, next) };
  }),
  closeAllDocuments: (requestedScope) => set((state) => {
    if (!requestedScope) {
      const selections = Object.fromEntries(Object.entries(state.selections).map(([scopeKey, current]) => [
        scopeKey,
        { ...current, activeArtifactId: null },
      ]));
      return { tabs: [], activeArtifactId: null, selections };
    }
    const tabs = state.tabs.filter(tab => tab.scopeKey !== requestedScope);
    const next = { ...selection(state, requestedScope), activeArtifactId: null };
    return { tabs, ...selectedScopePatch(state, requestedScope, next) };
  }),
  closeAllFiles: (requestedScope) => set((state) => {
    if (!requestedScope) {
      const selections = Object.fromEntries(Object.entries(state.selections).map(([scopeKey, current]) => [
        scopeKey,
        { ...current, activeFileKey: null },
      ]));
      return { fileTabs: [], activeFileKey: null, selections };
    }
    const fileTabs = state.fileTabs.filter(tab => tab.scopeKey !== requestedScope);
    const next = { ...selection(state, requestedScope), activeFileKey: null };
    return { fileTabs, ...selectedScopePatch(state, requestedScope, next) };
  }),
}));
