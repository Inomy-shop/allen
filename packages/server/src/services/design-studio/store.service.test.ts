/**
 * DesignStudioStore — version-graph rules.
 *
 * Validates the requirements that are pure data logic:
 *  - R17/R18: versions are appended; restore preserves later versions
 *  - R18.1: variants are grouped siblings; one selected; branch from a rejected one
 *  - R18.2: unlimited history (100+ versions all retained)
 *  - R22: per-repo workspace dedupe; profile stored on the workspace
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DesignStudioStore } from './store.service.js';
import type { Screen } from './types.js';

function screens(tag: string): Screen[] {
  return [{ id: tag, name: 'Home', fileName: 'index.html', html: `<!DOCTYPE html><html><body>${tag}</body></html>` }];
}

describe('DesignStudioStore', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let store: DesignStudioStore;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('dstudio-store-test');
    store = new DesignStudioStore(db);
  });

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    for (const c of ['dstudio_workspaces', 'dstudio_sessions', 'dstudio_versions', 'dstudio_messages']) {
      await db.collection(c).deleteMany({});
    }
  });

  it('R22: dedupes a repo workspace by sourceRepoId', async () => {
    const ws = await store.createWorkspace({ kind: 'repo', name: 'Repo', sourceRepoId: 'r1', sourceRepoPath: '/x' });
    const found = await store.findRepoWorkspace('r1');
    expect(found?._id?.toString()).toBe(ws._id?.toString());
    expect(await store.findRepoWorkspace('r2')).toBeNull();
  });

  it('R22.1: profile is stored on the workspace and reused', async () => {
    const ws = await store.createWorkspace({ kind: 'repo', name: 'Repo', sourceRepoId: 'r1' });
    const profile = {
      summaryMarkdown: 's', colors: [], typography: 't', spacing: 'sp', components: [],
      iconography: 'i', layoutPatterns: 'l', consistency: { consistent: true, issues: [] },
    };
    const updated = await store.setProfile(String(ws._id), profile, 'confirmed', 'fp1');
    expect(updated?.profileStatus).toBe('confirmed');
    expect(updated?.profile?.typography).toBe('t');
    expect(updated?.repoFingerprint).toBe('fp1');
  });

  it('R17/R18: restoring an old version preserves later versions', async () => {
    const ws = await store.createWorkspace({ kind: 'greenfield', name: 'Idea' });
    const session = await store.createSession({ workspaceId: String(ws._id) });
    const sid = String(session._id);
    const v1 = await store.addVersion({ sessionId: sid, workspaceId: String(ws._id), kind: 'generation', label: 'v1', screens: screens('v1') });
    for (let i = 2; i <= 5; i++) {
      await store.addVersion({ sessionId: sid, workspaceId: String(ws._id), kind: 'iteration', label: `v${i}`, screens: screens(`v${i}`) });
    }
    const restored = await store.restoreVersion(String(v1._id), 'restore');

    const all = await store.listVersions(sid);
    expect(all).toHaveLength(6); // 5 originals + 1 restore copy — nothing destroyed
    expect(restored.screens[0].html).toContain('v1');
    const current = await store.getCurrentVersion(sid);
    expect(current?._id?.toString()).toBe(restored._id?.toString());
  });

  it('R18.1: variant group has one selected; can branch from a rejected sibling', async () => {
    const ws = await store.createWorkspace({ kind: 'greenfield', name: 'Idea' });
    const session = await store.createSession({ workspaceId: String(ws._id) });
    const sid = String(session._id);
    const group = await store.addVariantGroup({
      sessionId: sid, workspaceId: String(ws._id), label: 'landing',
      variants: [{ screens: screens('A') }, { screens: screens('B') }, { screens: screens('C') }],
    });
    expect(group).toHaveLength(3);
    expect(group.filter((v) => v.selected)).toHaveLength(1);
    expect(group[0].selected).toBe(true);
    expect(group.every((v) => v.groupId === group[0].groupId)).toBe(true);

    // Select a different variant → exactly one selected, current updated.
    const picked = await store.selectVariant(String(group[2]._id));
    expect(picked?.selected).toBe(true);
    const reloaded = await store.listVersions(sid);
    expect(reloaded.filter((v) => v.groupId && v.selected)).toHaveLength(1);

    // Branch from the rejected variant B — history intact.
    const branched = await store.restoreVersion(String(group[1]._id), 'branch');
    expect(branched.kind).toBe('branch');
    expect(branched.screens[0].html).toContain('B');
    expect(await store.listVersions(sid)).toHaveLength(4); // 3 variants + branch
  });

  it('R18.2: history is unlimited (120 versions all retained, ordered)', async () => {
    const ws = await store.createWorkspace({ kind: 'greenfield', name: 'Idea' });
    const session = await store.createSession({ workspaceId: String(ws._id) });
    const sid = String(session._id);
    for (let i = 1; i <= 120; i++) {
      await store.addVersion({ sessionId: sid, workspaceId: String(ws._id), kind: 'iteration', label: `v${i}`, screens: screens(`v${i}`) });
    }
    const all = await store.listVersions(sid);
    expect(all).toHaveLength(120);
    expect(all[0].seq).toBe(1);
    expect(all[119].seq).toBe(120);
  });

  it('cascades deletes from workspace → sessions → versions/messages', async () => {
    const ws = await store.createWorkspace({ kind: 'greenfield', name: 'Idea' });
    const session = await store.createSession({ workspaceId: String(ws._id) });
    const sid = String(session._id);
    await store.addVersion({ sessionId: sid, workspaceId: String(ws._id), kind: 'generation', label: 'v1', screens: screens('v1') });
    await store.addMessage({ sessionId: sid, role: 'user', content: 'hi' });
    await store.deleteWorkspace(String(ws._id));
    expect(await store.listSessions(String(ws._id))).toHaveLength(0);
    expect(await store.listVersions(sid)).toHaveLength(0);
    expect(await store.listMessages(sid)).toHaveLength(0);
  });
});
