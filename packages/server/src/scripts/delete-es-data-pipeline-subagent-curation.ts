import dotenv from 'dotenv';
import type { Db, Filter } from 'mongodb';
import { connectDB, disconnectDB } from '../database/mongo.js';

dotenv.config();

const COLLECTION = 'repo_context_curation_entries';
const DEFAULT_REPO_NAME = 'es-data-pipeline';
const MEMORY_OR_LEARNING_PATH = /(^|\/)(memory|memories)(\/|$)|(^|\/)[^/]*(learning|learnings|memory|memories)[^/]*\.md$/i;
const SUBAGENT_PATH_QUERIES = [
  { path: /^\.claude\/agents\/[^/]+\.md$/i },
  { path: /^\.claude\/agents\/[^/]+\/[^/]+\.md$/i },
  { path: /^\.claude\/agents\/[^/]+\/agents\/[^/]+\.md$/i },
  { path: /^\.agents\/.+\.md$/i },
];

type Options = {
  apply: boolean;
  repoName: string;
};

type PreviewEntry = {
  path?: string;
  title?: string;
  category?: string;
  inclusion?: string;
  injectionPolicy?: string;
  updatedAt?: Date;
};

type CleanupReport = {
  mode: 'dry-run' | 'apply';
  collection: string;
  repo: {
    id: string;
    name: string;
    path?: string;
  };
  broadSubagentEntryCount: number;
  skippedMemoryOrLearningCount: number;
  deleteCandidateCount: number;
  deleteCandidates: PreviewEntry[];
  deletedCount?: number;
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const db = await connectDB();
  try {
    const report = await deleteSubagentCurationEntries(db, options);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await disconnectDB();
  }
}

async function deleteSubagentCurationEntries(db: Db, options: Options): Promise<CleanupReport> {
  const repo = await db.collection('repos').findOne({
    $or: [
      { name: options.repoName },
      { path: new RegExp(`/${escapeRegExp(options.repoName)}$`) },
    ],
  });
  if (!repo) throw new Error(`Repo not found: ${options.repoName}`);

  const repoId = String(repo._id);
  const collection = db.collection<PreviewEntry>(COLLECTION);
  const broadQuery: Filter<PreviewEntry> = { repoId, $or: SUBAGENT_PATH_QUERIES };
  const deleteQuery: Filter<PreviewEntry> = {
    repoId,
    $and: [
      { $or: SUBAGENT_PATH_QUERIES },
      { path: { $not: MEMORY_OR_LEARNING_PATH } },
    ],
  };

  const [broadSubagentEntryCount, deleteCandidates] = await Promise.all([
    collection.countDocuments(broadQuery),
    collection
      .find(deleteQuery, {
        projection: { _id: 0, path: 1, title: 1, category: 1, inclusion: 1, injectionPolicy: 1, updatedAt: 1 },
        sort: { path: 1 },
      })
      .toArray(),
  ]);

  const report: CleanupReport = {
    mode: options.apply ? 'apply' : 'dry-run',
    collection: COLLECTION,
    repo: {
      id: repoId,
      name: String(repo.name ?? options.repoName),
      path: typeof repo.path === 'string' ? repo.path : undefined,
    },
    broadSubagentEntryCount,
    skippedMemoryOrLearningCount: broadSubagentEntryCount - deleteCandidates.length,
    deleteCandidateCount: deleteCandidates.length,
    deleteCandidates,
  };

  if (options.apply && deleteCandidates.length > 0) {
    const result = await collection.deleteMany(deleteQuery);
    report.deletedCount = result.deletedCount;
  }

  return report;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    apply: false,
    repoName: DEFAULT_REPO_NAME,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--repo-name') {
      const value = args[index + 1];
      if (!value) throw new Error('--repo-name requires a value');
      options.repoName = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch(async (err) => {
  console.error(JSON.stringify({ error: (err as Error).message }, null, 2));
  await disconnectDB().catch(() => undefined);
  process.exitCode = 1;
});
