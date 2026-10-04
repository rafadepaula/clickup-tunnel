import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookServer } from '../src/server/webhook.js';
import { StorageDB } from '../src/storage/db.js';
import { ClickUpClient, ClickUpApiError } from '../src/clickup/client.js';
import type { ClickUpTaskDetail } from '../src/types.js';

describe('WebhookServer', () => {
  let db: StorageDB;
  let clickup: ClickUpClient;
  let server: WebhookServer;

  beforeEach(() => {
    db = new StorageDB(':memory:');
    clickup = new ClickUpClient('pk_test_fake_token_123');
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (db) {
      db.close();
    }
    vi.restoreAllMocks();
  });

  describe('Lifecycle and Configuration', () => {
    it('throws error when getPort is called before start', () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      expect(() => server.getPort()).toThrow('Server is not running');
    });

    it('defaults to port 3456 when port option and process.env.PORT are not set', () => {
      const origPort = process.env.PORT;
      delete process.env.PORT;
      try {
        const s = new WebhookServer({ db, clickup });
        expect((s as any).requestedPort).toBe(3456);
      } finally {
        if (origPort !== undefined) {
          process.env.PORT = origPort;
        }
      }
    });

    it('starts listening on an assigned port and getPort returns it', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const assignedPort = await server.start();

      expect(assignedPort).toBeGreaterThan(0);
      expect(server.getPort()).toBe(assignedPort);
    });

    it('throws error if start() is called when already running', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      await server.start();

      await expect(server.start()).rejects.toThrow('Server is already running');
    });

    it('shuts down cleanly on stop() and getPort throws afterward', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      await server.stop();
      expect(() => server.getPort()).toThrow('Server is not running');

      // Subsequent requests should fail
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    });

    it('calling stop() when not running is safe and idempotent', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      await expect(server.stop()).resolves.toBeUndefined();
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  describe('GET /health', () => {
    it('returns 200 with { status: "ok" } and application/json Content-Type', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const data = await response.json();
      expect(data).toEqual({ status: 'ok' });
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      const resGet = await fetch(`http://127.0.0.1:${port}/nonexistent`);
      expect(resGet.status).toBe(404);
      expect(await resGet.json()).toEqual({ error: 'Not Found' });

      const resPost = await fetch(`http://127.0.0.1:${port}/api/something`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(resPost.status).toBe(404);
      expect(await resPost.json()).toEqual({ error: 'Not Found' });
    });

    it('returns 404 for wrong HTTP method on /webhook and /health', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      // GET /webhook is not supported
      const resGetWebhook = await fetch(`http://127.0.0.1:${port}/webhook`);
      expect(resGetWebhook.status).toBe(404);

      // POST /health is not supported
      const resPostHealth = await fetch(`http://127.0.0.1:${port}/health`, {
        method: 'POST',
      });
      expect(resPostHealth.status).toBe(404);
    });
  });

  describe('POST /webhook payload validation', () => {
    it('returns 400 when payload is invalid JSON', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json-{broken',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBeDefined();

      // Ensure no events or tasks stored in db
      expect(db.getPendingCount()).toBe(0);
    });

    it('returns 200 and skips enrichment when payload has no task_id', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();
      const getTaskSpy = vi.spyOn(clickup, 'getTask');

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'ping', webhook_id: 'wb_123' }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
      expect(getTaskSpy).not.toHaveBeenCalled();
      expect(db.getPendingCount()).toBe(0);
    });
  });

  describe('POST /webhook enrichment pipeline', () => {
    it('acknowledges immediately before asynchronous enrichment finishes', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      // Simulate a slow ClickUp API response (200ms delay)
      let enrichmentCompleted = false;
      vi.spyOn(clickup, 'getTask').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        enrichmentCompleted = true;
        return {
          id: '86b123',
          name: 'Delayed Task',
          status: 'to do',
        } as ClickUpTaskDetail;
      });

      const startTime = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: '86b123',
          event: 'taskUpdated',
        }),
      });

      const duration = Date.now() - startTime;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });

      // Immediate acknowledgement: response should arrive well before the 200ms API call
      expect(duration).toBeLessThan(150);
      expect(enrichmentCompleted).toBe(false);

      // Wait for enrichment to complete
      await new Promise<void>((resolve) => {
        server.once('enriched', () => resolve());
      });
      expect(enrichmentCompleted).toBe(true);
    });

    it('asynchronously enriches task and persists task & event in DB', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      const mockTask: ClickUpTaskDetail = {
        id: '86b123',
        name: 'Fix login bug',
        status: { status: 'in progress', color: '#ff0000', type: 'custom', orderindex: 1 },
        tags: [{ name: 'urgent' }, { name: 'bug' }],
        description: 'Users cannot log in with OAuth',
        url: 'https://app.clickup.com/t/86b123',
        list: { id: 'list_999', name: 'Sprint 42' },
        date_created: '1700000000000',
      };

      vi.spyOn(clickup, 'getTask').mockResolvedValueOnce(mockTask);

      const enrichmentPromise = new Promise<void>((resolve) => {
        server.once('enriched', () => resolve());
      });

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: '86b123',
          event: 'taskStatusUpdated',
          history_items: [
            { field: 'status', before: 'to do', after: 'in progress' },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });

      // Await enrichment completion
      await enrichmentPromise;

      // Verify DB state
      const { task, events } = db.getTaskById('86b123');
      expect(task).not.toBeNull();
      expect(task?.id).toBe('86b123');
      expect(task?.name).toBe('Fix login bug');
      expect(task?.status).toBe('in progress');
      expect(task?.tags).toEqual(['urgent', 'bug']);
      expect(task?.description).toBe('Users cannot log in with OAuth');
      expect(task?.url).toBe('https://app.clickup.com/t/86b123');
      expect(task?.list_id).toBe('list_999');
      expect(task?.list_name).toBe('Sprint 42');
      expect(task?.created_at).toBe(1700000000000);

      expect(events).toHaveLength(1);
      expect(events[0].task_id).toBe('86b123');
      expect(events[0].event_type).toBe('taskStatusUpdated');
      expect(events[0].processing_status).toBe('pending');
      expect(events[0].history_items).toEqual([
        { field: 'status', before: 'to do', after: 'in progress' },
      ]);
    });

    it('handles string status and string array tags properly', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      const mockTask: ClickUpTaskDetail = {
        id: 'task_string_test',
        name: 'Simple task',
        status: 'completed',
        tags: ['frontend', 'v2'],
      };

      vi.spyOn(clickup, 'getTask').mockResolvedValueOnce(mockTask);

      const enrichmentPromise = new Promise<void>((resolve) => {
        server.once('enriched', () => resolve());
      });

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: 'task_string_test',
          event: 'taskCreated',
        }),
      });

      expect(response.status).toBe(200);
      await enrichmentPromise;

      const { task } = db.getTaskById('task_string_test');
      expect(task?.status).toBe('completed');
      expect(task?.tags).toEqual(['frontend', 'v2']);
    });

    it('handles clickup.getTask rejection gracefully without crashing server', async () => {
      server = new WebhookServer({ db, clickup, port: 0 });
      const port = await server.start();

      // Spy on console.error to avoid test output noise
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(clickup, 'getTask').mockRejectedValueOnce(
        new ClickUpApiError('ClickUp API error (404): Task not found', 404, 'Task not found')
      );

      const errorPromise = new Promise<void>((resolve) => {
        server.once('enrichmentError', () => resolve());
      });

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: 'nonexistent_task',
          event: 'taskUpdated',
        }),
      });

      // Server returns 200 immediately
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });

      // Error event is emitted
      await errorPromise;

      // Verify console.error was called
      expect(consoleErrorSpy).toHaveBeenCalled();

      // Verify server is STILL running and responsive to further requests
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ status: 'ok' });
    });
  });
});
