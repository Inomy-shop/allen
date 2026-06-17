/**
 * Allen Design Studio — Shared types
 *
 * A fresh, self-contained design surface (PRD: "Allen Design"). It is
 * intentionally independent of the legacy `design_*` collections/services —
 * nothing here reuses or extends them.
 *
 * Persistence tiers (all stored in local, Allen-managed Mongo):
 *   Workspace  (one per repo / per greenfield idea)  — holds the confirmed profile
 *     └─ Session    (a design conversation)
 *          └─ Version  (every generation / iteration; variant siblings grouped)
 *
 * Collections: dstudio_workspaces, dstudio_sessions, dstudio_versions, dstudio_messages
 */

import type { ObjectId } from 'mongodb';

// ── Design profile (Mode A: inferred; Mode B: synthesized from discovery) ────

export interface ColorToken {
  name: string;
  value: string; // hex / rgb / css value
  role?: string; // e.g. "primary", "background", "accent"
}

export interface DesignProfileThemeOption {
  name: string;
  description: string; // plain-language visual description (R4.2)
  location: string; // where in the repo it is used (R4.2)
}

export interface DesignProfile {
  /**
   * The primary, human-readable profile a non-developer can read (R3, AC-R3).
   * Markdown — this is what the model is best at and carries the rich detail.
   */
  summaryMarkdown: string;
  /** Machine-readable signals used by the editor + generation context. */
  colors: ColorToken[];
  /** Optional structured extras — present when the model emits them. */
  typography?: string;
  spacing?: string;
  components?: { name: string; description: string }[];
  iconography?: string;
  layoutPatterns?: string;
  /** Consistency assessment (R4.1). */
  consistency: {
    consistent: boolean;
    issues: string[];
    /** Chosen strategy when the repo is inconsistent. Required before generation. */
    strategy?: 'mimic' | 'normalize';
  };
  /** Detected themes when more than one exists (R4.2). */
  themes?: DesignProfileThemeOption[];
  /** The theme the user picked to drive the profile (R4.2). */
  selectedTheme?: string;
}

// ── Greenfield discovery brief (Mode B, R6/R7, stored on workspace R22.3) ────

export interface GreenfieldBrief {
  product: string;
  audience: string;
  feel: string; // brand personality / desired feel
  references: string; // products/styles liked or disliked
  screens: string; // key screens / flows needed
  /** Direction + assumptions the system chose when the user said "you decide" (R7). */
  direction?: string;
  assumptions?: string[];
}

// ── Workspace ────────────────────────────────────────────────────────────────

export type WorkspaceKind = 'repo' | 'greenfield';

/**
 * profileStatus lifecycle:
 *  - pending:       created, no analysis/discovery yet
 *  - analyzing:     repo analysis in flight
 *  - needs_review:  profile produced, awaiting user confirm/correction (R4)
 *  - needs_choice:  inconsistent repo or multi-theme — user must choose (R4.1/R4.2)
 *  - confirmed:     profile confirmed; generation may proceed
 */
export type ProfileStatus = 'pending' | 'analyzing' | 'needs_review' | 'needs_choice' | 'confirmed';

export interface DesignWorkspace {
  _id?: ObjectId;
  ownerUserId?: string | null;
  kind: WorkspaceKind;
  name: string;
  /** Repo mode only. */
  sourceRepoId?: string;
  sourceRepoPath?: string;
  /** Fingerprint of the repo state when the profile was built — drives R22.2. */
  repoFingerprint?: string;
  profile?: DesignProfile;
  profileStatus: ProfileStatus;
  /** Provider/model used for analysis (user-selectable), persisted for reuse. */
  analysisProvider?: string;
  analysisModel?: string;
  /** Greenfield mode only (R22.3). */
  greenfieldBrief?: GreenfieldBrief;
  createdAt: Date;
  updatedAt: Date;
}

// ── Session ──────────────────────────────────────────────────────────────────

export interface DesignSession {
  _id?: ObjectId;
  workspaceId: string;
  ownerUserId?: string | null;
  title: string;
  currentVersionId?: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
}

// ── Version ──────────────────────────────────────────────────────────────────

export interface Screen {
  id: string;
  name: string;
  /** File name used for navigation + export (e.g. "index.html", "pricing.html"). */
  fileName: string;
  html: string; // full, self-contained HTML document (inline CSS + JS)
}

export type VersionKind = 'generation' | 'iteration' | 'variant' | 'restore' | 'branch';

export interface DesignVersion {
  _id?: ObjectId;
  sessionId: string;
  workspaceId: string;
  /** Monotonic per-session ordering. */
  seq: number;
  /** Lineage: the version this one was derived from. */
  parentVersionId?: string;
  /** Variant group id — siblings generated for one brief share this (R18.1). */
  groupId?: string;
  variantLabel?: string; // "A" | "B" | "C"
  /** The selected variant continues the active line of work (R18.1). */
  selected?: boolean;
  kind: VersionKind;
  /** Human change summary shown in history (R17). */
  label: string;
  /** The user instruction that produced this version. */
  prompt?: string;
  screens: Screen[];
  /** Elements the system invented that were not in the profile (R5). */
  inventedElements?: string[];
  createdAt: Date;
}

// ── Conversation message ─────────────────────────────────────────────────────

export interface DesignMessage {
  _id?: ObjectId;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  versionId?: string;
  /** Variant group id when a message announces a set of variants. */
  groupId?: string;
  createdAt: Date;
}
