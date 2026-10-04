import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { StorageDB } from '../storage/db.js';
import type { ProcessingStatus, TunnelStatus } from '../types.js';

export interface ClickUpTunnelMcpServerOptions {
  name?: string;
  version?: string;
  tunnelUrl?: string | null;
  webhookId?: string | null;
  teamId?: string | null;
  getStatus?: () => Partial<TunnelStatus>;
}

const TOOLS = [
  {
    name: 'get_pending_tasks',
    description: 'Retrieve pending tasks for agent action, deduplicated and token-optimized (omits verbose history)',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of pending tasks to retrieve (default: 10)',
        },
        tag: {
          type: 'string',
          description: 'Optional tag filter to match',
        },
      },
    },
  },
  {
    name: 'mark_task_processed',
    description: 'Mark task or event status (processed | failed | ignored). Accepts task_id (to clear all pending events for that task) or specific event_id.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ClickUp task ID (e.g. 86e3jq5f1). Marks ALL pending events for this task at once.',
        },
        event_id: {
          type: 'number',
          description: 'Specific webhook event ID to update (optional if task_id is provided)',
        },
        status: {
          type: 'string',
          enum: ['processed', 'failed', 'ignored', 'in_progress', 'pending'],
          description: "Status to set (default: 'processed')",
        },
        notes: {
          type: 'string',
          description: 'Optional notes or outcome summary',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_task_by_id',
    description: 'Get full task details and event history by task_id',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ClickUp task ID (e.g. 86b123)',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_recent_events',
    description: 'List recent events with optional limit and status filter',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of recent events to return (default: 20)',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'processed', 'failed', 'ignored'],
          description: 'Optional status filter',
        },
      },
    },
  },
  {
    name: 'get_tunnel_status',
    description: 'Inspect current tunnel URL and queue metrics',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export class ClickUpTunnelMcpServer {
  private readonly db: StorageDB;
  private readonly options: ClickUpTunnelMcpServerOptions;
  private readonly server: Server;

  constructor(db: StorageDB, options: ClickUpTunnelMcpServerOptions = {}) {
    this.db = db;
    this.options = options;

    this.server = new Server(
      {
        name: options.name ?? 'clickup-tunnel',
        version: options.version ?? '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOLS,
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'get_pending_tasks':
          return this.handleGetPendingTasks(args);
        case 'mark_task_processed':
          return this.handleMarkTaskProcessed(args);
        case 'get_task_by_id':
          return this.handleGetTaskById(args);
        case 'list_recent_events':
          return this.handleListRecentEvents(args);
        case 'get_tunnel_status':
          return this.handleGetTunnelStatus(args);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    });
  }

  private handleGetPendingTasks(args: any): CallToolResult {
    const limit = typeof args?.limit === 'number' ? args.limit : 10;
    const tag = typeof args?.tag === 'string' && args.tag.trim().length > 0 ? args.tag.trim() : undefined;

    const tasks = this.db.getPendingTasks(limit, tag);
    const cleanTasks = tasks.map((t) => ({
      task_id: t.task_id,
      name: t.name,
      status: t.status,
      tags: t.tags,
      description: t.description,
      url: t.url,
      event_id: t.event_id,
      event_type: t.latest_event,
      latest_event: t.latest_event,
      event_count: t.event_count,
      event_ids: t.event_ids,
      received_at: t.received_at,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(cleanTasks, null, 2),
        },
      ],
    };
  }

  private handleMarkTaskProcessed(args: any): CallToolResult {
    const allowedStatuses: ProcessingStatus[] = [
      'processed',
      'failed',
      'ignored',
      'in_progress',
      'pending',
    ];
    const status = (args?.status ?? 'processed') as ProcessingStatus;

    if (!allowedStatuses.includes(status)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Invalid status: "${args?.status}". Must be one of: ${allowedStatuses.join(', ')}`,
          },
        ],
      };
    }

    const notes = args?.notes !== undefined && args?.notes !== null ? String(args.notes) : undefined;

    // Support marking by task_id (clears all pending events for that task at once)
    if (args?.task_id && typeof args.task_id === 'string' && args.task_id.trim().length > 0) {
      const taskId = args.task_id.trim();
      const count = this.db.markTaskStatus(taskId, status, notes);
      return {
        content: [
          {
            type: 'text',
            text: `Successfully marked ${count} pending event(s) for task #${taskId} as '${status}'.`,
          },
        ],
      };
    }

    // Support marking by specific event_id
    if (typeof args?.event_id === 'number') {
      const eventId = args.event_id;
      const updated = this.db.markEventStatus(eventId, status, notes);

      if (!updated) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Event #${eventId} not found.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Event #${eventId} successfully marked as '${status}'.`,
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Missing required parameter: provide either task_id (string) or event_id (number)',
        },
      ],
    };
  }

  private handleGetTaskById(args: any): CallToolResult {
    if (!args?.task_id || typeof args.task_id !== 'string') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Missing or invalid required parameter: task_id (must be a non-empty string)',
          },
        ],
      };
    }

    const taskId = String(args.task_id);
    const result = this.db.getTaskById(taskId);

    if (!result.task && result.events.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Task #${taskId} not found.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private handleListRecentEvents(args: any): CallToolResult {
    const limit = typeof args?.limit === 'number' ? args.limit : 20;
    const status = args?.status ? (args.status as ProcessingStatus) : undefined;

    const events = this.db.listRecentEvents(limit, status);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(events, null, 2),
        },
      ],
    };
  }

  private handleGetTunnelStatus(_args: any): CallToolResult {
    const pendingCount = this.db.getPendingCount();
    const dynamic = this.options.getStatus ? this.options.getStatus() : {};
    const persisted = this.db.getDaemonState();

    let isDaemonRunning = false;
    if (persisted?.pid) {
      try {
        process.kill(persisted.pid, 0);
        isDaemonRunning = true;
      } catch {
        isDaemonRunning = false;
      }
    }

    const tunnelUrl =
      dynamic.tunnel_url !== undefined
        ? dynamic.tunnel_url
        : (this.options.tunnelUrl ??
          (isDaemonRunning && persisted?.active ? persisted.tunnel_url : null) ??
          process.env.WEBHOOK_PUBLIC_URL ??
          process.env.TUNNEL_URL ??
          null);

    const webhookId =
      dynamic.webhook_id !== undefined
        ? dynamic.webhook_id
        : (this.options.webhookId ??
          (isDaemonRunning && persisted?.active ? persisted.webhook_id : null) ??
          process.env.CLICKUP_WEBHOOK_ID ??
          null);

    const teamId =
      dynamic.team_id !== undefined
        ? dynamic.team_id
        : (this.options.teamId ??
          (isDaemonRunning && persisted?.active ? persisted.team_id : null) ??
          process.env.CLICKUP_TEAM_ID ??
          null);

    const active =
      dynamic.active !== undefined
        ? Boolean(dynamic.active)
        : Boolean(
            this.options.tunnelUrl ||
            (isDaemonRunning && persisted?.active && Boolean(persisted.tunnel_url))
          );

    const status: TunnelStatus = {
      active,
      tunnel_url: tunnelUrl,
      webhook_id: webhookId,
      team_id: teamId,
      pending_tasks_count: pendingCount,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }

  /**
   * Starts the MCP server on standard input/output.
   */
  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Connects the MCP server to a custom transport (e.g. InMemoryTransport for testing).
   */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Closes the MCP server and its underlying connections.
   */
  async close(): Promise<void> {
    await this.server.close();
  }

  /**
   * Returns the underlying MCP Server instance.
   */
  getServer(): Server {
    return this.server;
  }
}
