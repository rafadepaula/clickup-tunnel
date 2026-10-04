import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StorageDB } from '../src/storage/db.js';
import { ClickUpTunnelMcpServer } from '../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as stdioModule from '@modelcontextprotocol/sdk/server/stdio.js';

describe('ClickUpTunnelMcpServer', () => {
  let db: StorageDB;
  let server: ClickUpTunnelMcpServer;
  let client: Client;

  async function createConnectedClient(mcpServer: ClickUpTunnelMcpServer): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    const mcpClient = new Client(
      { name: 'test-agent', version: '1.0.0' },
      { capabilities: {} }
    );
    await mcpClient.connect(clientTransport);
    return mcpClient;
  }

  beforeEach(() => {
    db = new StorageDB(':memory:');
  });

  afterEach(async () => {
    if (client) {
      await client.close();
    }
    if (server) {
      await server.close();
    }
    if (db) {
      db.close();
    }
    vi.restoreAllMocks();
  });

  describe('Tool Registration', () => {
    it('registers all 5 required tools with proper descriptions and schemas', async () => {
      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const response = await client.listTools();
      const toolNames = response.tools.map((t) => t.name);

      expect(toolNames).toContain('get_pending_tasks');
      expect(toolNames).toContain('mark_task_processed');
      expect(toolNames).toContain('get_task_by_id');
      expect(toolNames).toContain('list_recent_events');
      expect(toolNames).toContain('get_tunnel_status');
      expect(toolNames).toHaveLength(5);

      const markTool = response.tools.find((t) => t.name === 'mark_task_processed');
      expect(markTool?.inputSchema.required).toContain('event_id');

      const getTaskTool = response.tools.find((t) => t.name === 'get_task_by_id');
      expect(getTaskTool?.inputSchema.required).toContain('task_id');
    });
  });

  describe('Tool: get_pending_tasks', () => {
    it('returns empty array formatted as JSON when no pending tasks exist', async () => {
      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_pending_tasks',
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = (result.content[0] as { type: 'text'; text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed).toEqual([]);
    });

    it('returns pending tasks formatted as JSON text', async () => {
      db.saveTask({
        id: 'task_1',
        name: 'Build MCP Server',
        status: 'in progress',
        tags: ['backend', 'mcp'],
        description: 'Implement tools for AI agents',
        url: 'https://app.clickup.com/t/task_1',
        list_id: 'list_1',
        list_name: 'Sprint 1',
        raw_json: '{}',
        created_at: 1700000000000,
      });
      const eventId = db.insertEvent('task_1', 'taskCreated', [{ field: 'status' }]);

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_pending_tasks',
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      const tasks = JSON.parse(text);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].event_id).toBe(eventId);
      expect(tasks[0].task_id).toBe('task_1');
      expect(tasks[0].name).toBe('Build MCP Server');
      expect(tasks[0].tags).toEqual(['backend', 'mcp']);
      expect(tasks[0].event_type).toBe('taskCreated');
    });

    it('supports limit parameter', async () => {
      for (let i = 1; i <= 5; i++) {
        db.saveTask({
          id: `task_${i}`,
          name: `Task ${i}`,
          status: 'open',
          tags: ['feature'],
          description: null,
          url: null,
          list_id: null,
          list_name: null,
          raw_json: '{}',
          created_at: 1700000000000 + i,
        });
        db.insertEvent(`task_${i}`, 'taskCreated', []);
      }

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_pending_tasks',
        arguments: { limit: 2 },
      });

      const tasks = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].task_id).toBe('task_1');
      expect(tasks[1].task_id).toBe('task_2');
    });

    it('supports tag filter parameter', async () => {
      db.saveTask({
        id: 'task_backend',
        name: 'Fix DB Index',
        status: 'open',
        tags: ['backend', 'urgent'],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });
      db.insertEvent('task_backend', 'taskCreated', []);

      db.saveTask({
        id: 'task_frontend',
        name: 'Fix CSS button',
        status: 'open',
        tags: ['frontend'],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000001000,
      });
      db.insertEvent('task_frontend', 'taskCreated', []);

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const resultUrgent = await client.callTool({
        name: 'get_pending_tasks',
        arguments: { tag: 'urgent' },
      });
      const urgentTasks = JSON.parse((resultUrgent.content[0] as { type: 'text'; text: string }).text);
      expect(urgentTasks).toHaveLength(1);
      expect(urgentTasks[0].task_id).toBe('task_backend');

      const resultFrontend = await client.callTool({
        name: 'get_pending_tasks',
        arguments: { tag: 'frontend' },
      });
      const frontendTasks = JSON.parse((resultFrontend.content[0] as { type: 'text'; text: string }).text);
      expect(frontendTasks).toHaveLength(1);
      expect(frontendTasks[0].task_id).toBe('task_frontend');
    });

    it('deduplicates multiple pending events for the same task and returns token-optimized task list', async () => {
      db.saveTask({
        id: 'task_dup',
        name: 'Deduplicated Task',
        status: 'to do',
        tags: ['mcp-test'],
        description: 'Testing token optimization',
        url: 'https://app.clickup.com/t/task_dup',
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });

      // Insert 6 events for this single task
      for (let i = 1; i <= 6; i++) {
        db.insertEvent('task_dup', i === 1 ? 'taskCreated' : 'taskUpdated', [
          { huge_nested_quill_delta: 'should not be returned in get_pending_tasks' },
        ]);
      }

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_pending_tasks',
        arguments: {},
      });

      const tasks = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(tasks).toHaveLength(1); // Exactly 1 item instead of 6 duplicate items!
      expect(tasks[0].task_id).toBe('task_dup');
      expect(tasks[0].name).toBe('Deduplicated Task');
      expect(tasks[0].event_count).toBe(6);
      expect(tasks[0].event_ids).toHaveLength(6);
      expect(tasks[0].history_items).toBeUndefined(); // History stripped for token economy!
    });
  });

  describe('Tool: mark_task_processed', () => {
    it('marks pending event as processed with default status and updates DB', async () => {
      db.saveTask({
        id: 'task_mark_1',
        name: 'Mark test',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });
      const eventId = db.insertEvent('task_mark_1', 'taskCreated', []);

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'mark_task_processed',
        arguments: { event_id: eventId },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain(`Event #${eventId}`);
      expect(text).toContain('processed');

      // Verify DB update
      expect(db.getPendingCount()).toBe(0);
      const events = db.listRecentEvents(10);
      expect(events[0].id).toBe(eventId);
      expect(events[0].processing_status).toBe('processed');
      expect(events[0].processed_at).not.toBeNull();
    });

    it('marks event with status failed and includes agent notes', async () => {
      db.saveTask({
        id: 'task_mark_2',
        name: 'Fail test',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });
      const eventId = db.insertEvent('task_mark_2', 'taskCreated', []);

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'mark_task_processed',
        arguments: {
          event_id: eventId,
          status: 'failed',
          notes: 'Agent failed to run regression tests',
        },
      });

      expect(result.isError).toBeFalsy();
      const events = db.listRecentEvents(10);
      expect(events[0].processing_status).toBe('failed');
      expect(events[0].agent_notes).toBe('Agent failed to run regression tests');
    });

    it('marks event as ignored', async () => {
      db.saveTask({
        id: 'task_mark_3',
        name: 'Ignore test',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });
      const eventId = db.insertEvent('task_mark_3', 'taskCreated', []);

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'mark_task_processed',
        arguments: {
          event_id: eventId,
          status: 'ignored',
          notes: 'Irrelevant tag update',
        },
      });

      expect(result.isError).toBeFalsy();
      const events = db.listRecentEvents(10);
      expect(events[0].processing_status).toBe('ignored');
    });

    it('marks all pending events for a task at once when task_id is provided', async () => {
      db.saveTask({
        id: 'task_bulk_clear',
        name: 'Bulk Clear Task',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });

      for (let i = 1; i <= 5; i++) {
        db.insertEvent('task_bulk_clear', 'taskUpdated', []);
      }

      expect(db.getPendingCount()).toBe(5);

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'mark_task_processed',
        arguments: { task_id: 'task_bulk_clear', status: 'processed', notes: 'Done by agent' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Successfully marked 5 pending event(s) for task #task_bulk_clear as \'processed\'');

      // All pending events are now processed
      expect(db.getPendingCount()).toBe(0);
    });

    it('returns error when event_id does not exist', async () => {
      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'mark_task_processed',
        arguments: { event_id: 99999 },
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('not found');
    });

    it('returns error when event_id parameter is missing', async () => {
      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'mark_task_processed',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('event_id');
    });

    it('returns error when status parameter is invalid', async () => {
      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'mark_task_processed',
        arguments: {
          event_id: 1,
          status: 'invalid_status_value',
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Invalid status');
    });
  });

  describe('Tool: get_task_by_id', () => {
    it('returns task and event history for existing task', async () => {
      db.saveTask({
        id: 'task_detail_1',
        name: 'Implement OAuth',
        status: 'review',
        tags: ['auth', 'security'],
        description: 'OAuth2 with Google and GitHub',
        url: 'https://app.clickup.com/t/task_detail_1',
        list_id: 'list_123',
        list_name: 'Authentication',
        raw_json: '{"custom":"prop"}',
        created_at: 1700000000000,
      });
      const event1 = db.insertEvent('task_detail_1', 'taskCreated', []);
      const event2 = db.insertEvent('task_detail_1', 'taskUpdated', [{ field: 'status' }]);
      db.markEventStatus(event1, 'processed', 'Handled creation');

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_task_by_id',
        arguments: { task_id: 'task_detail_1' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      const data = JSON.parse(text);

      expect(data.task).toBeDefined();
      expect(data.task.id).toBe('task_detail_1');
      expect(data.task.name).toBe('Implement OAuth');
      expect(data.task.status).toBe('review');
      expect(data.task.tags).toEqual(['auth', 'security']);

      expect(data.events).toHaveLength(2);
      expect(data.events[0].id).toBe(event1);
      expect(data.events[0].processing_status).toBe('processed');
      expect(data.events[1].id).toBe(event2);
      expect(data.events[1].processing_status).toBe('pending');
    });

    it('returns error when task_id does not exist', async () => {
      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_task_by_id',
        arguments: { task_id: 'non_existent_task' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('non_existent_task');
      expect(text).toContain('not found');
    });

    it('returns error when task_id parameter is missing', async () => {
      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_task_by_id',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('task_id');
    });
  });

  describe('Tool: list_recent_events', () => {
    it('returns recent events list formatted as JSON', async () => {
      db.saveTask({
        id: 't_rec_1',
        name: 'Event Task 1',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });
      db.saveTask({
        id: 't_rec_2',
        name: 'Event Task 2',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000001000,
      });

      const e1 = db.insertEvent('t_rec_1', 'taskCreated', []);
      const e2 = db.insertEvent('t_rec_2', 'taskUpdated', []);
      db.markEventStatus(e1, 'processed');

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'list_recent_events',
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const events = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe(e2);
      expect(events[1].id).toBe(e1);
    });

    it('filters recent events by status and limit', async () => {
      db.saveTask({
        id: 't_filter',
        name: 'Filter Test',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });

      const e1 = db.insertEvent('t_filter', 'e1', []);
      const e2 = db.insertEvent('t_filter', 'e2', []);
      const e3 = db.insertEvent('t_filter', 'e3', []);

      db.markEventStatus(e1, 'processed');
      db.markEventStatus(e2, 'failed');

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const resultPending = await client.callTool({
        name: 'list_recent_events',
        arguments: { status: 'pending' },
      });
      const pendingEvents = JSON.parse((resultPending.content[0] as { type: 'text'; text: string }).text);
      expect(pendingEvents).toHaveLength(1);
      expect(pendingEvents[0].id).toBe(e3);

      const resultFailed = await client.callTool({
        name: 'list_recent_events',
        arguments: { status: 'failed' },
      });
      const failedEvents = JSON.parse((resultFailed.content[0] as { type: 'text'; text: string }).text);
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].id).toBe(e2);
    });
  });

  describe('Tool: get_tunnel_status', () => {
    it('returns default status metrics with queue count', async () => {
      db.saveTask({
        id: 't_stat',
        name: 'Status Test',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      });
      db.insertEvent('t_stat', 'taskCreated', []);
      db.insertEvent('t_stat', 'taskUpdated', []);

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_tunnel_status',
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const status = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

      expect(status.pending_tasks_count).toBe(2);
      expect(status.active).toBe(false);
      expect(status.tunnel_url).toBeNull();
    });

    it('returns configured status when options are provided', async () => {
      server = new ClickUpTunnelMcpServer(db, {
        tunnelUrl: 'https://test-tunnel.trycloudflare.com',
        webhookId: 'webhook_987',
        teamId: 'team_12345',
      });
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_tunnel_status',
        arguments: {},
      });

      const status = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(status.active).toBe(true);
      expect(status.tunnel_url).toBe('https://test-tunnel.trycloudflare.com');
      expect(status.webhook_id).toBe('webhook_987');
      expect(status.team_id).toBe('team_12345');
      expect(status.pending_tasks_count).toBe(0);
    });

    it('supports dynamic getStatus callback', async () => {
      let isLive = true;
      server = new ClickUpTunnelMcpServer(db, {
        getStatus: () => ({
          active: isLive,
          tunnel_url: isLive ? 'https://dynamic-tunnel.trycloudflare.com' : null,
          webhook_id: 'dynamic_wh',
          team_id: 'dynamic_team',
        }),
      });
      client = await createConnectedClient(server);

      const res1 = await client.callTool({ name: 'get_tunnel_status', arguments: {} });
      const status1 = JSON.parse((res1.content[0] as { type: 'text'; text: string }).text);
      expect(status1.active).toBe(true);
      expect(status1.tunnel_url).toBe('https://dynamic-tunnel.trycloudflare.com');

      isLive = false;
      const res2 = await client.callTool({ name: 'get_tunnel_status', arguments: {} });
      const status2 = JSON.parse((res2.content[0] as { type: 'text'; text: string }).text);
      expect(status2.active).toBe(false);
      expect(status2.tunnel_url).toBeNull();
    });

    it('reads active daemon state persisted in SQLite database', async () => {
      db.setDaemonState({
        active: true,
        pid: process.pid,
        tunnel_url: 'https://persisted-tunnel.trycloudflare.com',
        webhook_id: 'wh_persisted_123',
        team_id: 'team_persisted',
        port: 3456,
      });

      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      const result = await client.callTool({
        name: 'get_tunnel_status',
        arguments: {},
      });

      const status = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(status.active).toBe(true);
      expect(status.tunnel_url).toBe('https://persisted-tunnel.trycloudflare.com');
      expect(status.webhook_id).toBe('wh_persisted_123');
      expect(status.team_id).toBe('team_persisted');
    });
  });

  describe('Error handling', () => {
    it('throws or returns error for unknown tool call', async () => {
      server = new ClickUpTunnelMcpServer(db);
      client = await createConnectedClient(server);

      await expect(
        client.callTool({
          name: 'non_existent_tool',
          arguments: {},
        })
      ).rejects.toThrow();
    });
  });

  describe('startStdio and lifecycle', () => {
    it('calls StdioServerTransport and connects server', async () => {
      server = new ClickUpTunnelMcpServer(db);
      const mockConnect = vi.spyOn(server.getServer(), 'connect').mockResolvedValue(undefined);

      await server.startStdio();

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('close() can be called cleanly', async () => {
      server = new ClickUpTunnelMcpServer(db);
      await expect(server.close()).resolves.toBeUndefined();
    });
  });
});
