# ClickUp Tunnel & Agent MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish `@rafadepaula/clickup-tunnel`, an open-source CLI service and MCP server that bridges ClickUp task webhooks via Cloudflare Quick Tunnels into a local SQLite queue for AI agents (Antigravity, Claude, Codex, Cursor).

**Architecture:** A TypeScript/Node.js package with built-in `node:sqlite`. The CLI manages an HTTP webhook server on port 3456, supervises a `cloudflared` quick tunnel, auto-registers ClickUp webhooks, enriches task payloads via ClickUp REST API, and provides a stdio MCP server for AI agents to query and mark tasks as processed.

**Tech Stack:** Node.js 26+, TypeScript 5+, `node:sqlite` (native standard library), `@modelcontextprotocol/sdk`, Vitest, `cloudflared`.

## Global Constraints

- Package Name: `@rafadepaula/clickup-tunnel`
- GitHub Repo: `rafadepaula/clickup-tunnel`
- Security: ZERO fallback to local file paths (no `token.txt`). Token must strictly be read from `process.env.CLICKUP_API_TOKEN`, `.env`, or `--token` CLI flag.
- Concurrency: SQLite configured with WAL mode (`PRAGMA journal_mode = WAL;`) and busy timeout (5000ms).
- Node runtime: Native `node:sqlite` (`DatabaseSync` from `node:sqlite`).

---

### Task 1: Project Setup, Types and Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `vitest.config.ts`
- Create: `src/types.ts`

**Interfaces:**
- Consumes: Node standard libraries, `@modelcontextprotocol/sdk`
- Produces: Data interfaces `TaskRecord`, `WebhookEventRecord`, `ClickUpTaskResponse`, `TunnelConfig`, `McpTaskItem`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules
dist
data
*.db
*.db-wal
*.db-shm
.env
*.log
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "@rafadepaula/clickup-tunnel",
  "version": "1.0.0",
  "description": "ClickUp Webhook Cloudflare Tunnel with SQLite queue and MCP Server for AI agents",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "clickup-tunnel": "dist/cli.js"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/rafadepaula/clickup-tunnel.git"
  },
  "homepage": "https://github.com/rafadepaula/clickup-tunnel#readme",
  "bugs": {
    "url": "https://github.com/rafadepaula/clickup-tunnel/issues"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "start": "node dist/cli.js start",
    "dev": "tsx src/cli.ts start",
    "mcp": "node dist/cli.js mcp",
    "test": "vitest run",
    "prepare": "npm run build"
  },
  "keywords": [
    "clickup",
    "cloudflare",
    "cloudflared",
    "tunnel",
    "webhook",
    "mcp",
    "model-context-protocol",
    "agents",
    "ai",
    "sqlite"
  ],
  "author": "Rafael de Paula",
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.0",
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
});
```

- [ ] **Step 5: Create `src/types.ts`**

```typescript
export interface TaskRecord {
  id: string;
  name: string;
  status: string;
  tags: string[]; // parsed from JSON array
  description: string | null;
  url: string | null;
  list_id: string | null;
  list_name: string | null;
  raw_json: string;
  created_at: number;
  updated_at: number;
}

export type ProcessingStatus = 'pending' | 'in_progress' | 'processed' | 'failed' | 'ignored';

export interface WebhookEventRecord {
  id: number;
  task_id: string;
  event_type: string;
  history_items: any[];
  processing_status: ProcessingStatus;
  agent_notes: string | null;
  received_at: number;
  processed_at: number | null;
}

export interface PendingTaskItem {
  event_id: number;
  task_id: string;
  name: string;
  status: string;
  tags: string[];
  description: string | null;
  event_type: string;
  history_items: any[];
  received_at: string;
}

export interface TunnelStatus {
  active: boolean;
  tunnel_url: string | null;
  webhook_id: string | null;
  team_id: string | null;
  pending_tasks_count: number;
}
```

- [ ] **Step 6: Install dependencies & run build check**

Run: `npm install`
Expected: Packages installed successfully.

- [ ] **Step 7: Commit setup**

```bash
git add package.json tsconfig.json .gitignore vitest.config.ts src/types.ts package-lock.json
git commit -m "chore: setup project structure, tsconfig, vitest and types"
```

---

### Task 2: SQLite Storage Layer (`src/storage/db.ts`)

**Files:**
- Create: `src/storage/db.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Consumes: `node:sqlite`, `src/types.ts`
- Produces: `StorageDB` class:
  - `constructor(dbPath?: string)`
  - `saveTask(task: Omit<TaskRecord, 'updated_at'>): void`
  - `insertEvent(taskId: string, eventType: string, historyItems: any[]): number`
  - `getPendingTasks(limit?: number, tagFilter?: string): PendingTaskItem[]`
  - `markEventStatus(eventId: number, status: ProcessingStatus, notes?: string): boolean`
  - `getTaskById(taskId: string): { task: TaskRecord | null, events: WebhookEventRecord[] }`
  - `listRecentEvents(limit?: number, status?: ProcessingStatus): (WebhookEventRecord & { task_name?: string })[]`
  - `getPendingCount(): number`
  - `close(): void`

- [ ] **Step 1: Write unit tests for storage layer**

Create `tests/storage.test.ts` with tests for:
1. Creating tables in `:memory:`
2. Saving a task and retrieving it
3. Inserting an event and verifying it appears in `getPendingTasks`
4. Tag filtering in `getPendingTasks`
5. Marking an event as processed and verifying pending count decreases

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL (module `src/storage/db.ts` not found)

- [ ] **Step 3: Implement `src/storage/db.ts`**

Implement `StorageDB` using `DatabaseSync` from `node:sqlite`:
- Enable WAL mode: `db.exec('PRAGMA journal_mode = WAL;')`
- Set busy timeout: `db.exec('PRAGMA busy_timeout = 5000;')`
- Create `tasks` and `webhook_events` tables and indexes.
- Default path resolution: If no path given, resolve to `process.env.CLICKUP_TUNNEL_DB` or `~/.clickup-tunnel/events.db`. Create parent directory with `fs.mkdirSync(dir, { recursive: true })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/db.ts tests/storage.test.ts
git commit -m "feat: add SQLite storage layer with WAL mode and unit tests"
```

---

### Task 3: ClickUp API Client (`src/clickup/client.ts`)

**Files:**
- Create: `src/clickup/client.ts`
- Test: `tests/clickup.test.ts`

**Interfaces:**
- Consumes: Node standard `fetch`
- Produces: `ClickUpClient` class:
  - `constructor(apiToken: string)`
  - `getDefaultTeamId(): Promise<string>`
  - `getTask(taskId: string): Promise<ClickUpTaskDetail>`
  - `createWebhook(teamId: string, endpointUrl: string): Promise<{ id: string; secret: string }>`
  - `deleteWebhook(webhookId: string): Promise<boolean>`
  - `listWebhooks(teamId: string): Promise<Array<{ id: string; endpoint: string }>>`

- [ ] **Step 1: Write unit tests with mocked fetch**

Create `tests/clickup.test.ts`:
- Test initialization throws if token is missing.
- Mock fetch for `GET /api/v2/team` returning workspace id `90171427561`.
- Mock fetch for `GET /api/v2/task/86b123` returning task with name, status, tags, description.
- Mock fetch for `POST /api/v2/team/90171427561/webhook`.
- Mock fetch for `DELETE /api/v2/webhook/webhook_id`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/clickup.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/clickup/client.ts`**

Implement `ClickUpClient`:
- Strict validation: `if (!apiToken) throw new Error('CLICKUP_API_TOKEN is required')`.
- Headers: `Authorization: apiToken`, `Content-Type: application/json`.
- Handle ClickUp error responses gracefully with descriptive Error messages.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/clickup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/clickup/client.ts tests/clickup.test.ts
git commit -m "feat: add ClickUp API client for tasks and webhooks"
```

---

### Task 4: Cloudflare Tunnel Manager (`src/tunnel/cloudflared.ts`)

**Files:**
- Create: `src/tunnel/cloudflared.ts`
- Test: `tests/tunnel.test.ts`

**Interfaces:**
- Consumes: Node `child_process`, `types.ts`
- Produces: `TunnelManager` class:
  - `startQuickTunnel(port: number): Promise<string>` (resolves with public `https://*.trycloudflare.com` URL)
  - `stop(): Promise<void>`
  - `getUrl(): string | null`
  - `isRunning(): boolean`

- [ ] **Step 1: Write unit tests for tunnel parsing and manager lifecycle**

Create `tests/tunnel.test.ts`:
- Test regex URL extractor with sample cloudflared output lines:
  `2026-10-04T00:26:07Z INF |  https://innovative-paso-elder-bizarre.trycloudflare.com   |`
- Test starting and stopping mock tunnel process.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tunnel.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/tunnel/cloudflared.ts`**

Implement `TunnelManager`:
- Locates `cloudflared` binary (searches common paths like `/home/linuxbrew/.linuxbrew/bin/cloudflared`, `/usr/local/bin/cloudflared`, `which cloudflared`).
- Spawns `cloudflared tunnel --url http://127.0.0.1:${port}`.
- Listens on `stderr` and `stdout` for `https://[-a-zA-Z0-9]+\.trycloudflare\.com`.
- Rejects with clear error if binary not found or timeout occurs (default 30s timeout).
- `stop()` gracefully kills process with `SIGTERM` / `SIGKILL`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tunnel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tunnel/cloudflared.ts tests/tunnel.test.ts
git commit -m "feat: add Cloudflare Quick Tunnel supervisor"
```

---

### Task 5: Webhook HTTP Server & Enricher Pipeline (`src/server/webhook.ts`)

**Files:**
- Create: `src/server/webhook.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `node:http`, `src/storage/db.ts`, `src/clickup/client.ts`
- Produces: `WebhookServer` class:
  - `constructor(options: { db: StorageDB; clickup: ClickUpClient; port?: number })`
  - `start(): Promise<number>`
  - `stop(): Promise<void>`
  - `getPort(): number`

- [ ] **Step 1: Write integration tests for HTTP server**

Create `tests/server.test.ts`:
- Test `GET /health` returns `200` with `{ status: "ok" }`.
- Test `POST /webhook` with valid ClickUp payload returns `200` immediately with `{ received: true }`.
- Test that background enrichment calls `clickup.getTask` and updates DB with task `name`, `status`, `tags`.
- Test handling invalid payload.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/server/webhook.ts`**

Implement `WebhookServer`:
- Native `node:http` server to keep zero runtime overhead.
- Parse JSON body for incoming requests.
- `POST /webhook`:
  - Acknowledge immediately (`res.writeHead(200, ...); res.end(...)`).
  - Asynchronously extract `task_id`, `event`, and `history_items`.
  - Fetch full task details using `clickup.getTask(task_id)`.
  - Save task in `db.saveTask(...)`.
  - Insert event in `db.insertEvent(task_id, event, history_items)`.
  - Log helpful console summary (e.g. `[Webhook] Task updated: #86b123 "Fix login bug" -> Saved to SQLite`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/webhook.ts tests/server.test.ts
git commit -m "feat: add Webhook HTTP receiver with task enrichment pipeline"
```

---

### Task 6: MCP Server & Tool Definitions (`src/mcp/server.ts`)

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk`, `src/storage/db.ts`
- Produces: `ClickUpTunnelMcpServer` class:
  - `constructor(db: StorageDB)`
  - `startStdio(): Promise<void>`
  - `close(): Promise<void>`
  - Tools:
    - `get_pending_tasks`
    - `mark_task_processed`
    - `get_task_by_id`
    - `list_recent_events`
    - `get_tunnel_status`

- [ ] **Step 1: Write tests for MCP tool handlers**

Create `tests/mcp.test.ts`:
- Call tool `get_pending_tasks` -> verify formatted output.
- Call tool `mark_task_processed` with event_id -> verify updated status in DB.
- Call tool `get_task_by_id` -> verify task and event history returned.
- Call tool `get_tunnel_status` -> verify status metrics.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/mcp/server.ts`**

Implement `ClickUpTunnelMcpServer`:
- Initialize `Server` from `@modelcontextprotocol/sdk/server/index.js`.
- Register tool schemas with `ListToolsRequestSchema` and `CallToolRequestSchema`.
- Connect via `StdioServerTransport` when `startStdio()` is called.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp.test.ts
git commit -m "feat: add MCP server exposing tools for agents"
```

---

### Task 7: CLI Entrypoint & Daemon Orchestration (`src/cli.ts` & `src/index.ts`)

**Files:**
- Create: `src/cli.ts`
- Create: `src/index.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `src/server/webhook.ts`, `src/tunnel/cloudflared.ts`, `src/mcp/server.ts`, `src/clickup/client.ts`
- Produces: Executable CLI `clickup-tunnel` with subcommands:
  - `start`: Starts daemon (HTTP + Tunnel + ClickUp Webhook register + Graceful exit).
  - `mcp`: Starts MCP server over stdio.
  - `status`: Displays current tunnel and database info.
  - `clean`: Removes webhooks registered by clickup-tunnel from ClickUp.

- [ ] **Step 1: Implement `src/index.ts` exporting library functions**
- [ ] **Step 2: Implement `src/cli.ts` with subcommands and flag parsing**
  - Read `--token` or `process.env.CLICKUP_API_TOKEN`.
  - Read `--port` or `process.env.PORT` (default 3456).
  - Read `--db` or `process.env.CLICKUP_TUNNEL_DB` (default `~/.clickup-tunnel/events.db`).
  - Read `--url` or `process.env.WEBHOOK_PUBLIC_URL` (for custom tunnel override).
  - Register `process.on('SIGINT')` and `process.on('SIGTERM')` to deregister webhook from ClickUp before exiting.
- [ ] **Step 3: Write tests for CLI parsing**
- [ ] **Step 4: Test build (`npm run build`) and test execution**
- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/index.ts tests/cli.test.ts
git commit -m "feat: add CLI entrypoint with start, mcp, status, clean commands"
```

---

### Task 8: Complete Documentation (`README.md`)

**Files:**
- Create: `README.md`
- Create: `LICENSE`

**Interfaces:**
- Produces: Comprehensive user and agent documentation with setup guides for Claude Desktop, Antigravity, Cursor, and Codex.

- [ ] **Step 1: Create MIT `LICENSE`**
- [ ] **Step 2: Create comprehensive `README.md` in English and Portuguese**
  - Features, Architecture diagram
  - Installation via npm (`npm install -g @rafadepaula/clickup-tunnel` or `npx @rafadepaula/clickup-tunnel`)
  - Running the webhook daemon: `CLICKUP_API_TOKEN=pk_... npx @rafadepaula/clickup-tunnel start`
  - Agent Configuration in `claude_desktop_config.json`, Antigravity `mcp_servers`, etc.
  - MCP Tools Reference
- [ ] **Step 3: Commit documentation**

```bash
git add README.md LICENSE
git commit -m "docs: add comprehensive README and MIT license"
```

---

### Task 9: Real E2E Verification, GitHub Repo & npm Public Release

**Files:**
- GitHub repository `rafadepaula/clickup-tunnel`
- Published package `@rafadepaula/clickup-tunnel`

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: 100% tests passing.

- [ ] **Step 2: Build project**

Run: `npm run build`
Expected: `dist/` generated with `dist/cli.js`, `dist/index.js`, etc.

- [ ] **Step 3: Create GitHub repository and push code**

```bash
gh repo create rafadepaula/clickup-tunnel --public --source=. --remote=origin --push
```

- [ ] **Step 4: Publish to npm**

```bash
npm publish --access public
```

- [ ] **Step 5: Verify public installation via npx**

Run: `npx @rafadepaula/clickup-tunnel --help`
Expected: Output showing `clickup-tunnel` commands and flags.
