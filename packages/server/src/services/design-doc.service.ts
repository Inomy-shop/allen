/**
 * Design Doc Service
 *
 * Owns the `design_docs` collection. One record per feature-plan run,
 * holding the PRD + Architecture + Technical Design sections with
 * per-section version history. Each new version of a section is ALSO
 * written as a standalone .md file to the public /api/files store so
 * the HIP card in chat and Slack can link to it with a clickable URL
 * that works without authentication.
 *
 * The service is intentionally thin — it doesn't produce docs, it
 * persists what the producer agents (requirements-analyst,
 * solution-architect, technical-designer) emit. Producers call
 * `upsertSection()` with their output; the plan approval gate calls
 * `markApproved()`; the coding phase calls `markHandedOff()`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Collection, Db, ObjectId } from 'mongodb';
import { getUploadsDir, ensureLocalDir } from './upload-storage.js';

// ── Types ────────────────────────────────────────────────────────────────

export type DesignDocSectionKind = 'requirements' | 'architecture' | 'technical_design';

export type DesignDocStatus =
  | 'clarifying'
  | 'producing_requirements'
  | 'producing_architecture'
  | 'producing_technical_design'
  | 'awaiting_approval'
  | 'approved'
  | 'handed_off'
  | 'abandoned';

/**
 * One section of a design doc (PRD / HLA / TDD). The current version
 * lives at the top of the `versions` array; previous versions are
 * retained for audit and comparison.
 */
export interface DesignDocSection {
  versions: DesignDocSectionVersion[];
}

export interface DesignDocSectionVersion {
  version: number;
  body: string;                      // full markdown content
  body_json?: Record<string, unknown>; // parsed JSON block the producer emits, if any
  producer_agent: string;            // which agent produced this version
  caused_by_intervention_id?: string;// intervention that triggered this revision
  upload_url: string;                // public /api/files URL for the .md mirror
  created_at: Date;
}

export interface DesignDocDoc {
  _id?: ObjectId;
  chatSessionId?: string;
  workflowRunId?: string;
  startedByUserId?: string;
  userRequest: string;
  status: DesignDocStatus;
  requirements: DesignDocSection;
  architecture: DesignDocSection;
  technicalDesign: DesignDocSection;
  approvedAt?: Date;
  approvedByUserId?: string;
  handedOffAt?: Date;
  linkedExecutionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Service ──────────────────────────────────────────────────────────────

export class DesignDocService {
  private col: Collection;

  constructor(db: Db) {
    this.col = db.collection('design_docs');
  }

  /**
   * Create a new design doc at the start of a feature-plan run.
   * All three sections start empty; producers fill them in over time.
   */
  async create(input: {
    userRequest: string;
    chatSessionId?: string;
    workflowRunId?: string;
    startedByUserId?: string;
  }): Promise<DesignDocDoc> {
    const now = new Date();
    const doc: DesignDocDoc = {
      userRequest: input.userRequest,
      chatSessionId: input.chatSessionId,
      workflowRunId: input.workflowRunId,
      startedByUserId: input.startedByUserId,
      status: 'clarifying',
      requirements: { versions: [] },
      architecture: { versions: [] },
      technicalDesign: { versions: [] },
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  /**
   * Find the design doc for a given workflow run. Returns null if the
   * workflow isn't tied to a design doc (e.g., bug-fix runs) or if
   * the caller passes an empty string.
   */
  async findByWorkflowRun(workflowRunId: string): Promise<DesignDocDoc | null> {
    if (!workflowRunId) return null;
    return this.col.findOne({ workflowRunId }) as Promise<DesignDocDoc | null>;
  }

  async findById(id: string): Promise<DesignDocDoc | null> {
    const { ObjectId } = await import('mongodb');
    return this.col.findOne({ _id: new ObjectId(id) }) as Promise<DesignDocDoc | null>;
  }

  /**
   * List design docs with optional filters. Powers the Design Docs page.
   */
  async list(filter: { status?: DesignDocStatus; chatSessionId?: string } = {}): Promise<DesignDocDoc[]> {
    const query: Record<string, unknown> = {};
    if (filter.status) query.status = filter.status;
    if (filter.chatSessionId) query.chatSessionId = filter.chatSessionId;
    return this.col
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray() as Promise<DesignDocDoc[]>;
  }

  /**
   * Upsert a new version of a section. Called by each producer agent
   * (requirements-analyst, solution-architect, technical-designer)
   * when they emit output. Each call appends to the section's
   * `versions` array and writes a public .md mirror.
   */
  async upsertSection(input: {
    designDocId: string;
    section: DesignDocSectionKind;
    body: string;
    bodyJson?: Record<string, unknown>;
    producerAgent: string;
    causedByInterventionId?: string;
  }): Promise<DesignDocSectionVersion> {
    const { ObjectId } = await import('mongodb');
    const oid = new ObjectId(input.designDocId);
    const existing = await this.col.findOne({ _id: oid }) as DesignDocDoc | null;
    if (!existing) throw new Error(`Design doc ${input.designDocId} not found`);

    const sectionKey = this.sectionKey(input.section);
    const prevVersions = existing[sectionKey].versions ?? [];
    const nextVersion = prevVersions.length + 1;

    const uploadUrl = await this.writePublicMarkdown(
      `${existing._id}-${input.section}-v${nextVersion}`,
      this.renderSectionMarkdown(existing, input.section, nextVersion, input.body),
    );

    const newVersion: DesignDocSectionVersion = {
      version: nextVersion,
      body: input.body,
      body_json: input.bodyJson,
      producer_agent: input.producerAgent,
      caused_by_intervention_id: input.causedByInterventionId,
      upload_url: uploadUrl,
      created_at: new Date(),
    };

    // `$push` with a dynamic path is typed tighter than Mongo's runtime
    // allows — cast through `any` only for the literal update doc.
    const update: any = {
      $push: { [`${sectionKey}.versions`]: newVersion },
      $set: {
        status: this.statusForSection(input.section),
        updatedAt: new Date(),
      },
    };
    await this.col.updateOne({ _id: oid }, update);

    return newVersion;
  }

  /**
   * Mark the design as approved by a user (plan approval gate).
   */
  async markApproved(designDocId: string, userId: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(designDocId) },
      {
        $set: {
          status: 'approved',
          approvedAt: new Date(),
          approvedByUserId: userId,
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * Mark the design as handed off to the coding phase.
   */
  async markHandedOff(designDocId: string, executionId: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(designDocId) },
      {
        $set: {
          status: 'handed_off',
          handedOffAt: new Date(),
          linkedExecutionId: executionId,
          updatedAt: new Date(),
        },
      },
    );
  }

  async markAbandoned(designDocId: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(designDocId) },
      { $set: { status: 'abandoned', updatedAt: new Date() } },
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private sectionKey(section: DesignDocSectionKind): 'requirements' | 'architecture' | 'technicalDesign' {
    switch (section) {
      case 'requirements': return 'requirements';
      case 'architecture': return 'architecture';
      case 'technical_design': return 'technicalDesign';
    }
  }

  private statusForSection(section: DesignDocSectionKind): DesignDocStatus {
    switch (section) {
      case 'requirements': return 'producing_requirements';
      case 'architecture': return 'producing_architecture';
      case 'technical_design': return 'awaiting_approval';
    }
  }

  /**
   * Write a .md file to the public uploads dir and return the
   * /api/files/<name> URL. Mirrors the pattern used by
   * file.routes.ts::POST /from-content.
   */
  private async writePublicMarkdown(slug: string, body: string): Promise<string> {
    const id = randomUUID();
    const ext = '.md';
    const storedName = `${id}-${slug}${ext}`.replace(/[^a-zA-Z0-9._-]/g, '-');
    const uploadsDir = getUploadsDir();
    ensureLocalDir(uploadsDir);
    const fullPath = join(uploadsDir, storedName);
    writeFileSync(fullPath, body, 'utf-8');
    return `/api/files/${storedName}`;
  }

  /**
   * Render a single section as a standalone .md document with a
   * header and metadata block. The body is the producer's raw output.
   */
  private renderSectionMarkdown(
    doc: DesignDocDoc,
    section: DesignDocSectionKind,
    version: number,
    body: string,
  ): string {
    const title = {
      requirements: 'Requirements Document',
      architecture: 'Architecture Design',
      technical_design: 'Technical Design Document',
    }[section];
    return `# ${title} — v${version}

**Design doc ID:** \`${doc._id}\`
**Workflow run:** \`${doc.workflowRunId ?? 'n/a'}\`
**Version:** ${version}

---

**Original user request:**

> ${doc.userRequest}

---

${body}
`;
  }
}
