#!/usr/bin/env node

import dotenv from 'dotenv';
import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { StorageDB } from './storage/db.js';
import { ClickUpClient } from './clickup/client.js';
import { TunnelManager } from './tunnel/cloudflared.js';
import { WebhookServer } from './server/webhook.js';
import { ClickUpTunnelMcpServer } from './mcp/server.js';

// Automatically load .env file
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pkgVersion = '1.0.3';
try {
  const pkgJsonPath = path.resolve(__dirname, '../package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (pkg.version) pkgVersion = pkg.version;
  }
} catch {
  // fallback to default
}
export const VERSION = pkgVersion;

export interface CliOptions {
  token?: string;
  port?: number;
  db?: string;
  team?: string;
  url?: string;
  help?: boolean;
  version?: boolean;
}

export type CliCommand = 'start' | 'mcp' | 'status' | 'clean' | 'help' | 'version';

export interface ParsedCliArgs {
  command: CliCommand;
  options: CliOptions;
}

export interface DaemonController {
  port: number;
  tunnelUrl: string;
  webhookId: string;
  dbPath: string;
  teamId: string;
  shutdown: () => Promise<void>;
}

export interface DaemonOverrides {
  clickupClient?: ClickUpClient;
  tunnelManager?: TunnelManager;
  webhookServer?: WebhookServer;
  db?: StorageDB;
  autoListenSignals?: boolean;
}

/**
 * Parses command-line arguments into a command and typed options.
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const optionsConfig = {
    token: { type: 'string', short: 't' },
    port: { type: 'string', short: 'p' },
    db: { type: 'string' },
    team: { type: 'string' },
    url: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  } as const;

  const parsed = parseArgs({
    args: argv,
    options: optionsConfig,
    allowPositionals: true,
    strict: false,
  });

  const positionals = parsed.positionals || [];
  const rawCommand = positionals[0]?.toLowerCase();

  let command: CliCommand = 'help';
  if (parsed.values.help || rawCommand === 'help') {
    command = 'help';
  } else if (parsed.values.version || rawCommand === 'version') {
    command = 'version';
  } else if (rawCommand === 'start') {
    command = 'start';
  } else if (rawCommand === 'mcp') {
    command = 'mcp';
  } else if (rawCommand === 'status') {
    command = 'status';
  } else if (rawCommand === 'clean') {
    command = 'clean';
  }

  const portNum = parsed.values.port ? Number(parsed.values.port) : undefined;

  const options: CliOptions = {
    token: parsed.values.token as string | undefined,
    port: Number.isInteger(portNum) ? portNum : undefined,
    db: parsed.values.db as string | undefined,
    team: parsed.values.team as string | undefined,
    url: parsed.values.url as string | undefined,
    help: Boolean(parsed.values.help),
    version: Boolean(parsed.values.version),
  };

  return { command, options };
}

/**
 * Resolves the ClickUp API token strictly from CLI options or process.env.
 * ZERO fallback to local file paths (e.g. token.txt).
 */
export function resolveToken(options: CliOptions): string | null {
  if (options.token && options.token.trim().length > 0) {
    return options.token.trim();
  }

  if (process.env.CLICKUP_API_TOKEN && process.env.CLICKUP_API_TOKEN.trim().length > 0) {
    return process.env.CLICKUP_API_TOKEN.trim();
  }

  return null;
}

/**
 * Resolves the ClickUp team ID from CLI options, process.env, or ClickUp API.
 */
export function resolveTeamId(options: CliOptions, client: ClickUpClient): Promise<string> {
  if (options.team && options.team.trim().length > 0) {
    return Promise.resolve(options.team.trim());
  }

  if (process.env.CLICKUP_TEAM_ID && process.env.CLICKUP_TEAM_ID.trim().length > 0) {
    return Promise.resolve(process.env.CLICKUP_TEAM_ID.trim());
  }

  return client.getDefaultTeamId();
}

/**
 * Resolves the database file path for display.
 */
function resolveDbPathDisplay(dbPath?: string): string {
  if (dbPath) return dbPath;
  if (process.env.CLICKUP_TUNNEL_DB) return process.env.CLICKUP_TUNNEL_DB;
  return path.join(os.homedir(), '.clickup-tunnel', 'events.db');
}

/**
 * Prints CLI usage instructions.
 */
export function printHelp(): void {
  console.log(`
clickup-tunnel - ClickUp Webhook Cloudflare Tunnel with SQLite queue and MCP Server

Usage: clickup-tunnel <command> [options]

Commands:
  start       Start webhook daemon, launch Cloudflare tunnel, and register webhook in ClickUp
  mcp         Start stdio MCP server for AI agents to query and process tasks
  status      Display SQLite database statistics and recent events
  clean       Remove trycloudflare/clickup-tunnel webhooks from ClickUp
  help        Show this help message

Options:
  -t, --token <token>   ClickUp API token (or CLICKUP_API_TOKEN in env / .env)
  -p, --port <port>     Local webhook server port (default: 3456, or PORT env var)
      --db <path>       SQLite DB path (default: ~/.clickup-tunnel/events.db)
      --team <id>       ClickUp Team/Workspace ID (or CLICKUP_TEAM_ID env var)
      --url <url>       Public webhook URL override (skips quick tunnel)
  -h, --help            Show help
  -v, --version         Show version
`);
}

/**
 * Prints package version.
 */
export function printVersion(): void {
  console.log(VERSION);
}

/**
 * Starts the tunnel daemon, webhook HTTP server, registers ClickUp webhook,
 * and sets up graceful shutdown handlers.
 */
export async function startDaemon(
  options: CliOptions,
  overrides: DaemonOverrides = {}
): Promise<DaemonController> {
  const token = resolveToken(options);
  if (!token) {
    throw new Error(
      'CLICKUP_API_TOKEN is required. Provide it via the --token flag, CLICKUP_API_TOKEN environment variable, or a .env file.'
    );
  }

  const clickup = overrides.clickupClient ?? new ClickUpClient(token);
  const teamId = await resolveTeamId(options, clickup);
  const db = overrides.db ?? new StorageDB(options.db);

  const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3456);
  const webhookServer = overrides.webhookServer ?? new WebhookServer({ db, clickup, port });
  const listeningPort = await webhookServer.start();

  let tunnelUrl: string;
  let tunnelManager: TunnelManager | null = null;
  const customUrl = (options.url || process.env.WEBHOOK_PUBLIC_URL || '').trim();

  if (customUrl) {
    tunnelUrl = customUrl.replace(/\/+$/, '');
  } else {
    tunnelManager = overrides.tunnelManager ?? new TunnelManager();
    tunnelUrl = await tunnelManager.startQuickTunnel(listeningPort);
  }

  const webhookEndpoint = `${tunnelUrl.replace(/\/+$/, '')}/webhook`;
  const webhook = await clickup.createWebhook(teamId, webhookEndpoint);
  const webhookId = webhook.id;
  const dbDisplay = resolveDbPathDisplay(options.db);

  // Pretty prints status banner
  console.log(`
================================================================================
  ClickUp Tunnel Daemon Started
================================================================================
  Tunnel URL:    ${tunnelUrl}
  Webhook ID:    ${webhookId}
  Team ID:       ${teamId}
  Listening:     http://localhost:${listeningPort}
  SQLite DB:     ${dbDisplay}
  Agent Command: npx @rafadepaula/clickup-tunnel mcp
================================================================================
`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\n[Daemon] Gracefully shutting down clickup-tunnel...');

    if (webhookId) {
      try {
        console.log(`[Daemon] Deregistering webhook ${webhookId} from ClickUp...`);
        await clickup.deleteWebhook(webhookId);
      } catch (err: any) {
        console.error(`[Daemon] Error deregistering webhook ${webhookId}:`, err?.message || err);
      }
    }

    if (tunnelManager) {
      try {
        console.log('[Daemon] Stopping Cloudflare tunnel...');
        await tunnelManager.stop();
      } catch (err: any) {
        console.error('[Daemon] Error stopping tunnel:', err?.message || err);
      }
    }

    try {
      console.log('[Daemon] Stopping webhook server...');
      await webhookServer.stop();
    } catch (err: any) {
      console.error('[Daemon] Error stopping webhook server:', err?.message || err);
    }

    try {
      console.log('[Daemon] Closing SQLite database...');
      db.close();
    } catch (err: any) {
      console.error('[Daemon] Error closing database:', err?.message || err);
    }

    console.log('[Daemon] Shutdown complete.');
  };

  if (overrides.autoListenSignals !== false) {
    const handleSignal = async (sig: string) => {
      console.log(`\nReceived ${sig}`);
      await shutdown();
      process.exit(0);
    };

    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
  }

  return {
    port: listeningPort,
    tunnelUrl,
    webhookId,
    dbPath: dbDisplay,
    teamId,
    shutdown,
  };
}

/**
 * Starts the stdio MCP server directly connected to the SQLite database.
 */
export async function startMcp(options: CliOptions, existingDb?: StorageDB): Promise<void> {
  const db = existingDb ?? new StorageDB(options.db);
  const mcpServer = new ClickUpTunnelMcpServer(db);

  const shutdown = async () => {
    try {
      await mcpServer.close();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await mcpServer.startStdio();
}

/**
 * Displays status and statistics from the SQLite database.
 */
export async function showStatus(options: CliOptions, existingDb?: StorageDB): Promise<void> {
  const db = existingDb ?? new StorageDB(options.db);
  const dbPath = resolveDbPathDisplay(options.db);

  try {
    const pendingCount = db.getPendingCount();
    const pendingTasks = db.getPendingTasks(10);
    const recentEvents = db.listRecentEvents(10);

    console.log(`
=== ClickUp Tunnel Status ===
SQLite DB:      ${dbPath}
Pending Events: ${pendingCount}
`);

    if (pendingTasks.length > 0) {
      console.log('Pending Tasks (up to 10):');
      for (const t of pendingTasks) {
        const tags = t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : '';
        console.log(`  - #${t.task_id}: "${t.name}" (${t.status})${tags} (Event: ${t.event_type})`);
      }
      console.log('');
    }

    if (recentEvents.length > 0) {
      console.log('Recent Events (up to 10):');
      for (const e of recentEvents) {
        const taskName = e.task_name ? ` "${e.task_name}"` : '';
        const dateStr = new Date(e.received_at).toLocaleTimeString();
        console.log(`  - [${dateStr}] Event #${e.id}: Task #${e.task_id}${taskName} (${e.event_type}) -> Status: ${e.processing_status}`);
      }
      console.log('');
    } else {
      console.log('No events recorded in database yet.\n');
    }
  } finally {
    if (!existingDb) {
      db.close();
    }
  }
}

/**
 * Removes old webhooks pointing to trycloudflare.com or clickup-tunnel.
 */
export async function cleanWebhooks(client: ClickUpClient, teamId: string): Promise<number> {
  const webhooks = await client.listWebhooks(teamId);
  const targets = webhooks.filter((w) => {
    const endpoint = w.endpoint.toLowerCase();
    return endpoint.includes('trycloudflare.com') || endpoint.includes('clickup-tunnel');
  });

  if (targets.length === 0) {
    console.log('No matching webhooks found to clean.');
    return 0;
  }

  let deletedCount = 0;
  for (const wh of targets) {
    try {
      await client.deleteWebhook(wh.id);
      console.log(`Deleted webhook ${wh.id} (${wh.endpoint})`);
      deletedCount++;
    } catch (err: any) {
      console.error(`Failed to delete webhook ${wh.id}:`, err?.message || err);
    }
  }

  console.log(`Cleaned ${deletedCount} of ${targets.length} webhook(s).`);
  return deletedCount;
}

/**
 * Main CLI runner. Returns exit code.
 */
export async function runCli(argv: string[]): Promise<number> {
  try {
    const { command, options } = parseCliArgs(argv);

    switch (command) {
      case 'help': {
        printHelp();
        return 0;
      }
      case 'version': {
        printVersion();
        return 0;
      }
      case 'status': {
        await showStatus(options);
        return 0;
      }
      case 'clean': {
        const token = resolveToken(options);
        if (!token) {
          console.error(
            'Error: CLICKUP_API_TOKEN is required. Provide it via the --token flag, CLICKUP_API_TOKEN environment variable, or a .env file.'
          );
          return 1;
        }
        const client = new ClickUpClient(token);
        const teamId = await resolveTeamId(options, client);
        await cleanWebhooks(client, teamId);
        return 0;
      }
      case 'mcp': {
        await startMcp(options);
        return 0;
      }
      case 'start': {
        const token = resolveToken(options);
        if (!token) {
          console.error(
            'Error: CLICKUP_API_TOKEN is required. Provide it via the --token flag, CLICKUP_API_TOKEN environment variable, or a .env file.'
          );
          return 1;
        }
        await startDaemon(options);
        return 0;
      }
      default: {
        printHelp();
        return 0;
      }
    }
  } catch (err: any) {
    console.error(`Error: ${err?.message || err}`);
    return 1;
  }
}

// Execute CLI automatically if this file is run directly
const isMain = () => {
  if (!process.argv[1]) return false;
  try {
    const current = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return current === entry;
  } catch {
    return false;
  }
};

if (isMain()) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  }).catch((err) => {
    console.error(`Fatal error: ${err?.message || err}`);
    process.exit(1);
  });
}
