/**
 * persist-design-docs built-in
 *
 * Used by the feature-plan-and-implement workflow's `persist_docs` node to
 * write the three approved design sections (PRD, HLA, TDD) into the
 * `design_docs` Mongo collection AND mirror each as a public .md file in
 * the uploads directory so intervention cards, Slack messages, and the
 * workflow summary can link to them with URLs that work without auth.
 *
 * The engine package intentionally doesn't depend on the server's
 * DesignDocService — we inline the minimum logic here to keep the
 * packages decoupled. The collection shape must match
 * `packages/server/src/services/design-doc.service.ts`.
 *
 * Config (from YAML):
 *   chat_session_id   — originating chat session (optional)
 *   workflow_run_id   — execution ID this design belongs to
 *   user_request      — the user's original feature ask
 *   prd               — Requirements Document as markdown
 *   hla               — High-Level Architecture as markdown
 *   tdd               — Technical Design Document as markdown
 *
 * Returns:
 *   design_doc_id, prd_url, hla_url, tdd_url
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BuiltInFunction } from '../types.js';

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(process.cwd(), '..', '..', 'uploads');

function ensureUploadsDir(): void {
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
}

function writePublicMarkdown(slug: string, body: string): string {
  ensureUploadsDir();
  const id = randomUUID();
  const storedName = `${id}-${slug}.md`.replace(/[^a-zA-Z0-9._-]/g, '-');
  writeFileSync(join(UPLOADS_DIR, storedName), body, 'utf-8');
  return `/api/files/${storedName}`;
}

function renderSection(title: string, userRequest: string, body: string): string {
  return `# ${title}

**Original user request:**

> ${userRequest}

---

${body}
`;
}

export const persistDesignDocs: BuiltInFunction = async (config, _state, ctx) => {
  if (!ctx.db) throw new Error('persist-design-docs requires a database connection');

  const userRequest = String(config.user_request ?? '');
  const prd = String(config.prd ?? '');
  const hla = String(config.hla ?? '');
  const tdd = String(config.tdd ?? '');
  const chatSessionId = config.chat_session_id as string | undefined;
  // Pull the execution ID from the built-in context — it's not in
  // workflow state, so a `{{execution_id}}` template in the YAML
  // wouldn't resolve. The engine passes ctx.executionId into every
  // built-in invocation, so we use that directly.
  const workflowRunId = (config.workflow_run_id as string | undefined) ?? ctx.executionId;

  if (!prd || !hla || !tdd) {
    throw new Error('persist-design-docs: prd, hla, and tdd are all required');
  }

  const col = ctx.db.collection('design_docs');
  const now = new Date();

  // Write the three markdown mirrors to the public uploads dir first.
  const prdUrl = writePublicMarkdown('prd-v1', renderSection('Requirements Document — v1', userRequest, prd));
  const hlaUrl = writePublicMarkdown('hla-v1', renderSection('High-Level Architecture — v1', userRequest, hla));
  const tddUrl = writePublicMarkdown('tdd-v1', renderSection('Technical Design Document — v1', userRequest, tdd));

  // Build the design_docs record matching DesignDocDoc shape exactly.
  const doc = {
    chatSessionId,
    workflowRunId,
    userRequest,
    status: 'awaiting_approval' as const,
    requirements: {
      versions: [
        {
          version: 1,
          body: prd,
          producer_agent: 'requirements-analyst',
          upload_url: prdUrl,
          created_at: now,
        },
      ],
    },
    architecture: {
      versions: [
        {
          version: 1,
          body: hla,
          producer_agent: 'solution-architect',
          upload_url: hlaUrl,
          created_at: now,
        },
      ],
    },
    technicalDesign: {
      versions: [
        {
          version: 1,
          body: tdd,
          producer_agent: 'technical-designer',
          upload_url: tddUrl,
          created_at: now,
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  };

  const result = await col.insertOne(doc);

  return {
    design_doc_id: String(result.insertedId),
    prd_url: prdUrl,
    hla_url: hlaUrl,
    tdd_url: tddUrl,
  };
};
