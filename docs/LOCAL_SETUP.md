# Allen — Local Setup

## 1. Clone

```bash
git clone git@github.com:Kalpai-poc/allen.git ~/allen
cd ~/allen
```

## 2. Install packages

```bash
npm install
```

You also need:

- **Node 20+** — `node -v` to check
- **MongoDB 7** — either:
  - **Docker (recommended)** — `docker compose up -d mongodb` runs Mongo on `localhost:27017` using the repo's `docker-compose.yml`
  - **Homebrew** — `brew tap mongodb/brew && brew install mongodb-community@7.0 && brew services start mongodb-community@7.0`
- **Claude Code CLI** — `npm i -g @anthropic-ai/claude-code` then run `claude` once to log in. This is the default agent provider.

## 3. Add the `.env` file

Drop the `.env` file (sent to you separately) into the repo root. It has all the secrets, master key, admin credentials, JWT secrets, and Mongo URI pre-filled.

Do NOT commit `.env` — it's already in `.gitignore`.

## 4. Run the dev servers once

```bash
npm run dev
```

First boot creates the admin user + seeds the built-in teams/agents/workflows. Open `http://localhost:5173`, sign in with the admin credentials from your `.env`, and complete the forced password reset.

Then **stop the server** (`Ctrl-C`) so it's not holding connections during the next step.

## 5. Sync shared data (agents, learnings, secrets)

Pulls the team's teams, agents, users, learnings, and encrypted secrets from the shared DocumentDB so you don't have to configure everything by hand.

**One-time setup:**

```bash
# Download the RDS CA bundle
curl -o ~/rds-combined-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

**Open an SSM tunnel in a separate terminal and leave it running:**

```bash
aws ssm start-session \
  --target <ec2-instance-id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host="<docdb-endpoint>",portNumber="27027",localPortNumber="27027"
```

(The `<ec2-instance-id>` and `<docdb-endpoint>` were sent to you with the `.env`.)

**Edit the URIs** at the top of `scripts/sync-teams-and-agents.ts`:

```ts
const SOURCE_URI = 'mongodb://...@localhost:27027/allen?tls=true&...';   // tunnel → prod DocDB
const DEST_URI   = 'mongodb://localhost:27017/allen';                    // your local Mongo
```

**Run the sync (dry-run first):**

```bash
DRY_RUN=1 SYNC_SECRETS=1 npx tsx scripts/sync-teams-and-agents.ts
```

Review what would sync, then run live:

```bash
SYNC_SECRETS=1 npx tsx scripts/sync-teams-and-agents.ts
```

This pulls `teams`, `agents`, `users`, `learnings`, and `secrets` — additive only, so re-running is safe. Because everyone uses the same `.env` (same `ALLEN_MASTER_KEY`), the encrypted secrets decrypt correctly on your machine.

## 6. Upload MCP tool bundles

Some MCP bundles (custom packages, pipeline integrations) are specific to each developer's machine and aren't synced. Upload them in the UI:

```bash
npm run dev
```

Open `http://localhost:5173` → **Settings → MCP Servers**. For each bundle you need:

1. Click **Upload Bundle**
2. Select the `.zip` for the MCP server package
3. Fill in the entry command (e.g., `dist/server.js`)
4. Add any required credentials as secrets
5. Toggle **Enabled**

Restart `npm run dev` so the new MCP servers register with Claude + Codex on boot.

---

## That's it

Open `/chat` and start a conversation. Main pages:

- `/chat` — talk to Claude/Codex, `@mention` agents
- `/repos` — register a git repo (clones into `~/.allen/repositories/`)
- `/workflows` — run bug-fix, feature, or CodeRabbit-resolve workflows
- `/executions` — live logs with expandable tool calls
- `/pull-requests` — sync PRs, trigger CodeRabbit resolution
- `/crons` — toggle scheduled jobs

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| `MongoDB connection refused` | `docker compose up -d mongodb`, or make sure `brew services` lists `mongodb-community` as started |
| Sync script hangs / `ENOTFOUND localhost` | SSM tunnel isn't running — start it in step 5 |
| `gh: command not found` (only affects PR-creation workflows) | `brew install gh && gh auth login` |
| Port 5173 or 4000 in use | `lsof -ti :<port> \| xargs kill -9`, or change `PORT` / `UI_PORT` in `.env` |
| Nuclear reset | `docker compose down && rm -rf data/mongodb ~/.allen && docker compose up -d mongodb && npm run dev` |

## File layout

```
~/.allen/
├── repositories/    ← git clones
├── workspaces/      ← worktrees per workspace
└── worktree-cache/  ← transient worktrees for workflow built-ins
```

Override with `ALLEN_HOME` in `.env` if you want them elsewhere.
