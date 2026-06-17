/**
 * Allen Design Studio — Store service
 *
 * All persistence for workspaces, sessions, versions, and messages.
 * Pure data access + the version-graph rules (variants as grouped siblings,
 * branching, restore-without-destroying-history). No LLM concerns here.
 */

import { ObjectId, type Collection, type Db } from 'mongodb';
import type {
  DesignWorkspace,
  DesignSession,
  DesignVersion,
  DesignMessage,
  DesignProfile,
  GreenfieldBrief,
  Screen,
  VersionKind,
  WorkspaceKind,
  ProfileStatus,
} from './types.js';

function oid(id: string): ObjectId {
  return new ObjectId(id);
}

export class DesignStudioStore {
  private workspaces: Collection<DesignWorkspace>;
  private sessions: Collection<DesignSession>;
  private versions: Collection<DesignVersion>;
  private messages: Collection<DesignMessage>;

  constructor(db: Db) {
    this.workspaces = db.collection<DesignWorkspace>('dstudio_workspaces');
    this.sessions = db.collection<DesignSession>('dstudio_sessions');
    this.versions = db.collection<DesignVersion>('dstudio_versions');
    this.messages = db.collection<DesignMessage>('dstudio_messages');
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  async createWorkspace(data: {
    kind: WorkspaceKind;
    name: string;
    sourceRepoId?: string;
    sourceRepoPath?: string;
    ownerUserId?: string | null;
  }): Promise<DesignWorkspace> {
    const now = new Date();
    const doc: DesignWorkspace = {
      kind: data.kind,
      name: data.name,
      sourceRepoId: data.sourceRepoId,
      sourceRepoPath: data.sourceRepoPath,
      ownerUserId: data.ownerUserId ?? null,
      profileStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    const res = await this.workspaces.insertOne(doc);
    return { ...doc, _id: res.insertedId };
  }

  async listWorkspaces(ownerUserId?: string): Promise<DesignWorkspace[]> {
    const filter = ownerUserId ? { ownerUserId } : {};
    return this.workspaces.find(filter).sort({ updatedAt: -1 }).toArray();
  }

  async getWorkspace(id: string): Promise<DesignWorkspace | null> {
    return this.workspaces.findOne({ _id: oid(id) });
  }

  /** Find an existing repo workspace so we don't re-create one per design (R22). */
  async findRepoWorkspace(sourceRepoId: string, ownerUserId?: string): Promise<DesignWorkspace | null> {
    return this.workspaces.findOne({
      kind: 'repo',
      sourceRepoId,
      ...(ownerUserId ? { ownerUserId } : {}),
    });
  }

  async updateWorkspace(id: string, patch: Partial<DesignWorkspace>): Promise<DesignWorkspace | null> {
    const _id = oid(id);
    await this.workspaces.updateOne({ _id }, { $set: { ...patch, updatedAt: new Date() } });
    return this.workspaces.findOne({ _id });
  }

  async setProfileStatus(id: string, status: ProfileStatus): Promise<void> {
    await this.workspaces.updateOne({ _id: oid(id) }, { $set: { profileStatus: status, updatedAt: new Date() } });
  }

  async setProfile(id: string, profile: DesignProfile, status: ProfileStatus, repoFingerprint?: string): Promise<DesignWorkspace | null> {
    const _id = oid(id);
    const set: Partial<DesignWorkspace> = { profile, profileStatus: status, updatedAt: new Date() };
    if (repoFingerprint !== undefined) set.repoFingerprint = repoFingerprint;
    await this.workspaces.updateOne({ _id }, { $set: set });
    return this.workspaces.findOne({ _id });
  }

  async setGreenfieldBrief(id: string, brief: GreenfieldBrief, status: ProfileStatus): Promise<DesignWorkspace | null> {
    const _id = oid(id);
    await this.workspaces.updateOne({ _id }, { $set: { greenfieldBrief: brief, profileStatus: status, updatedAt: new Date() } });
    return this.workspaces.findOne({ _id });
  }

  async deleteWorkspace(id: string): Promise<void> {
    const _id = oid(id);
    const sessions = await this.sessions.find({ workspaceId: id }).toArray();
    const sessionIds = sessions.map((s) => String(s._id));
    await this.versions.deleteMany({ workspaceId: id });
    if (sessionIds.length > 0) await this.messages.deleteMany({ sessionId: { $in: sessionIds } });
    await this.sessions.deleteMany({ workspaceId: id });
    await this.workspaces.deleteOne({ _id });
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(data: { workspaceId: string; title?: string; ownerUserId?: string | null }): Promise<DesignSession> {
    const now = new Date();
    const doc: DesignSession = {
      workspaceId: data.workspaceId,
      ownerUserId: data.ownerUserId ?? null,
      title: data.title?.trim() || 'Untitled design',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    };
    const res = await this.sessions.insertOne(doc);
    return { ...doc, _id: res.insertedId };
  }

  async listSessions(workspaceId: string): Promise<DesignSession[]> {
    return this.sessions.find({ workspaceId }).sort({ lastMessageAt: -1 }).toArray();
  }

  async getSession(id: string): Promise<DesignSession | null> {
    return this.sessions.findOne({ _id: oid(id) });
  }

  async updateSession(id: string, patch: Partial<DesignSession>): Promise<DesignSession | null> {
    const _id = oid(id);
    await this.sessions.updateOne({ _id }, { $set: { ...patch, updatedAt: new Date() } });
    return this.sessions.findOne({ _id });
  }

  async touchSession(id: string, currentVersionId?: string): Promise<void> {
    const set: Partial<DesignSession> = { updatedAt: new Date(), lastMessageAt: new Date() };
    if (currentVersionId) set.currentVersionId = currentVersionId;
    await this.sessions.updateOne({ _id: oid(id) }, { $set: set });
  }

  async deleteSession(id: string): Promise<void> {
    await this.versions.deleteMany({ sessionId: id });
    await this.messages.deleteMany({ sessionId: id });
    await this.sessions.deleteOne({ _id: oid(id) });
  }

  // ── Versions ────────────────────────────────────────────────────────────────

  private async nextSeq(sessionId: string): Promise<number> {
    const last = await this.versions.find({ sessionId }).sort({ seq: -1 }).limit(1).next();
    return (last?.seq ?? 0) + 1;
  }

  /**
   * Append a single version (generation / iteration / restore / branch) and make
   * it the session's current version. History is never truncated (R18, R18.2).
   */
  async addVersion(data: {
    sessionId: string;
    workspaceId: string;
    kind: VersionKind;
    label: string;
    prompt?: string;
    screens: Screen[];
    parentVersionId?: string;
    inventedElements?: string[];
  }): Promise<DesignVersion> {
    const seq = await this.nextSeq(data.sessionId);
    const doc: DesignVersion = {
      sessionId: data.sessionId,
      workspaceId: data.workspaceId,
      seq,
      kind: data.kind,
      label: data.label,
      prompt: data.prompt,
      screens: data.screens,
      parentVersionId: data.parentVersionId,
      inventedElements: data.inventedElements,
      createdAt: new Date(),
    };
    const res = await this.versions.insertOne(doc);
    const created = { ...doc, _id: res.insertedId };
    await this.touchSession(data.sessionId, String(res.insertedId));
    return created;
  }

  /**
   * Append a set of variant siblings for one brief (R10, R18.1). They share a
   * groupId; the first is auto-selected as the continued line until the user
   * picks one.
   */
  async addVariantGroup(data: {
    sessionId: string;
    workspaceId: string;
    label: string;
    prompt?: string;
    parentVersionId?: string;
    variants: { screens: Screen[]; inventedElements?: string[] }[];
  }): Promise<DesignVersion[]> {
    const groupId = new ObjectId().toString();
    const labels = ['A', 'B', 'C', 'D', 'E'];
    const out: DesignVersion[] = [];
    let seq = await this.nextSeq(data.sessionId);
    for (let i = 0; i < data.variants.length; i++) {
      const v = data.variants[i];
      const doc: DesignVersion = {
        sessionId: data.sessionId,
        workspaceId: data.workspaceId,
        seq: seq++,
        kind: 'variant',
        label: `${data.label} — Direction ${labels[i] ?? i + 1}`,
        prompt: data.prompt,
        groupId,
        variantLabel: labels[i] ?? String(i + 1),
        selected: i === 0,
        parentVersionId: data.parentVersionId,
        screens: v.screens,
        inventedElements: v.inventedElements,
        createdAt: new Date(),
      };
      const res = await this.versions.insertOne(doc);
      out.push({ ...doc, _id: res.insertedId });
    }
    // The selected variant becomes the session's current version.
    if (out[0]?._id) await this.touchSession(data.sessionId, String(out[0]._id));
    return out;
  }

  /** Pick a variant from a group as the active line of work (R10, R18.1). */
  async selectVariant(versionId: string): Promise<DesignVersion | null> {
    const version = await this.versions.findOne({ _id: oid(versionId) });
    if (!version?.groupId) return version;
    await this.versions.updateMany({ groupId: version.groupId }, { $set: { selected: false } });
    await this.versions.updateOne({ _id: oid(versionId) }, { $set: { selected: true } });
    await this.touchSession(version.sessionId, versionId);
    return this.versions.findOne({ _id: oid(versionId) });
  }

  async listVersions(sessionId: string): Promise<DesignVersion[]> {
    return this.versions.find({ sessionId }).sort({ seq: 1 }).toArray();
  }

  async getVersion(id: string): Promise<DesignVersion | null> {
    return this.versions.findOne({ _id: oid(id) });
  }

  /** The session's current version (latest if none explicitly set). */
  async getCurrentVersion(sessionId: string): Promise<DesignVersion | null> {
    const session = await this.getSession(sessionId);
    if (session?.currentVersionId) {
      const v = await this.getVersion(session.currentVersionId);
      if (v) return v;
    }
    return this.versions.find({ sessionId }).sort({ seq: -1 }).limit(1).next();
  }

  /**
   * Restore a past version as the new current state by appending a copy — the
   * later versions are preserved, not destroyed (R18). Works for branching from
   * a rejected variant too (R18.1).
   */
  async restoreVersion(versionId: string, kind: 'restore' | 'branch' = 'restore'): Promise<DesignVersion> {
    const src = await this.getVersion(versionId);
    if (!src) throw new Error('version not found');
    return this.addVersion({
      sessionId: src.sessionId,
      workspaceId: src.workspaceId,
      kind,
      label: kind === 'branch' ? `Branched from “${src.label}”` : `Restored “${src.label}”`,
      prompt: src.prompt,
      screens: src.screens,
      parentVersionId: versionId,
      inventedElements: src.inventedElements,
    });
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async addMessage(data: Omit<DesignMessage, '_id' | 'createdAt'>): Promise<DesignMessage> {
    const doc: DesignMessage = { ...data, createdAt: new Date() };
    const res = await this.messages.insertOne(doc);
    await this.sessions.updateOne({ _id: oid(data.sessionId) }, { $set: { lastMessageAt: new Date() } });
    return { ...doc, _id: res.insertedId };
  }

  async listMessages(sessionId: string): Promise<DesignMessage[]> {
    return this.messages.find({ sessionId }).sort({ createdAt: 1 }).toArray();
  }
}
