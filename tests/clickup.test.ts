import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClickUpClient, ClickUpApiError } from '../src/clickup/client.js';
import type { ClickUpTaskDetail } from '../src/types.js';
import fs from 'node:fs';

describe('ClickUpClient', () => {
  const originalEnv = process.env.CLICKUP_API_TOKEN;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.CLICKUP_API_TOKEN;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLICKUP_API_TOKEN = originalEnv;
    } else {
      delete process.env.CLICKUP_API_TOKEN;
    }
    vi.restoreAllMocks();
  });

  describe('Initialization and Token Validation', () => {
    it('throws if token is missing and not in process.env', () => {
      expect(() => new ClickUpClient()).toThrow('CLICKUP_API_TOKEN is required');
      expect(() => new ClickUpClient('')).toThrow('CLICKUP_API_TOKEN is required');
      expect(() => new ClickUpClient('   ')).toThrow('CLICKUP_API_TOKEN is required');
    });

    it('initializes successfully with constructor token', () => {
      const client = new ClickUpClient('pk_test_token_123');
      expect(client).toBeInstanceOf(ClickUpClient);
    });

    it('initializes successfully from process.env.CLICKUP_API_TOKEN when constructor argument omitted', () => {
      process.env.CLICKUP_API_TOKEN = 'pk_env_token_456';
      const client = new ClickUpClient();
      expect(client).toBeInstanceOf(ClickUpClient);
    });

    it('sets default baseUrl to https://api.clickup.com/api/v2', async () => {
      const client = new ClickUpClient('pk_test_token');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ teams: [{ id: '123', name: 'Team' }] }), { status: 200 })
      );

      await client.getDefaultTeamId();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team',
        expect.any(Object)
      );
    });

    it('accepts custom baseUrl and removes trailing slashes', async () => {
      const client = new ClickUpClient('pk_test_token', 'https://mock.clickup.local/api/v2///');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ teams: [{ id: '123', name: 'Team' }] }), { status: 200 })
      );

      await client.getDefaultTeamId();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://mock.clickup.local/api/v2/team',
        expect.any(Object)
      );
    });

    it('does not read any local file paths (zero fallback to token.txt)', () => {
      const fsReadSpy = vi.spyOn(fs, 'readFileSync');
      const fsExistsSpy = vi.spyOn(fs, 'existsSync');

      expect(() => new ClickUpClient()).toThrow('CLICKUP_API_TOKEN is required');

      expect(fsReadSpy).not.toHaveBeenCalled();
      expect(fsExistsSpy).not.toHaveBeenCalled();
    });
  });

  describe('Headers and Authentication', () => {
    it('sends Authorization and Content-Type headers in every request', async () => {
      const client = new ClickUpClient('pk_secret_token');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ teams: [{ id: 'team_99', name: 'My Team' }] }), { status: 200 })
      );

      await client.getDefaultTeamId();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callArgs = fetchSpy.mock.calls[0];
      const requestOptions = callArgs[1] as RequestInit;

      expect(requestOptions.headers).toMatchObject({
        Authorization: 'pk_secret_token',
        'Content-Type': 'application/json',
      });
    });
  });

  describe('getDefaultTeamId', () => {
    it('returns workspace id for GET /api/v2/team', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            teams: [
              {
                id: '90171427561',
                name: 'Workspace Alpha',
                members: [],
              },
            ],
          }),
          { status: 200 }
        )
      );

      const teamId = await client.getDefaultTeamId();

      expect(teamId).toBe('90171427561');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('converts numeric team id to string', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            teams: [{ id: 90171427561, name: 'Numeric Workspace' }],
          }),
          { status: 200 }
        )
      );

      const teamId = await client.getDefaultTeamId();
      expect(teamId).toBe('90171427561');
      expect(typeof teamId).toBe('string');
    });

    it('throws error when no teams are returned', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ teams: [] }), { status: 200 })
      );

      await expect(client.getDefaultTeamId()).rejects.toThrow('No teams found in ClickUp account');
    });
  });

  describe('getTask', () => {
    it('fetches task details by id for GET /api/v2/task/:id', async () => {
      const client = new ClickUpClient('pk_test');
      const mockTask: ClickUpTaskDetail = {
        id: '86b123',
        name: 'Implement OAuth Tunnel',
        status: { status: 'in progress', color: '#00ff00', type: 'custom', orderindex: 1 },
        tags: [{ name: 'backend' }, { name: 'agent-ready' }],
        description: 'Complete the OAuth implementation for ClickUp Tunnel',
        url: 'https://app.clickup.com/t/86b123',
        list: { id: 'list_123', name: 'Backlog' },
        date_created: '1700000000000',
        date_updated: '1700000050000',
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockTask), { status: 200 })
      );

      const task = await client.getTask('86b123');

      expect(task).toEqual(mockTask);
      expect(task.id).toBe('86b123');
      expect(task.name).toBe('Implement OAuth Tunnel');
      expect(task.tags).toEqual([{ name: 'backend' }, { name: 'agent-ready' }]);
      expect(task.description).toBe('Complete the OAuth implementation for ClickUp Tunnel');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/task/86b123',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('unwraps task object if wrapped in { task: ... }', async () => {
      const client = new ClickUpClient('pk_test');
      const innerTask = {
        id: '86b123',
        name: 'Wrapped Task',
        status: 'open',
        tags: ['v1'],
        description: 'Wrapped description',
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ task: innerTask }), { status: 200 })
      );

      const task = await client.getTask('86b123');
      expect(task.id).toBe('86b123');
      expect(task.name).toBe('Wrapped Task');
    });

    it('properly encodes taskId in URL', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '#custom/id 123', name: 'Special ID' }), { status: 200 })
      );

      await client.getTask('#custom/id 123');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/task/%23custom%2Fid%20123',
        expect.any(Object)
      );
    });
  });

  describe('createWebhook', () => {
    it('creates webhook with POST /api/v2/team/:teamId/webhook and default events', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'webhook_901',
            webhook: {
              id: 'webhook_901',
              userid: 183,
              team_id: 90171427561,
              endpoint: 'https://tunnel.trycloudflare.com/webhook',
              secret: 'sec_webhook_secret_123',
              events: ['*'],
            },
          }),
          { status: 200 }
        )
      );

      const result = await client.createWebhook('90171427561', 'https://tunnel.trycloudflare.com/webhook');

      expect(result).toEqual({
        id: 'webhook_901',
        secret: 'sec_webhook_secret_123',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team/90171427561/webhook',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            endpoint: 'https://tunnel.trycloudflare.com/webhook',
            events: ['*'],
          }),
        })
      );
    });

    it('creates webhook with custom events array', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'webhook_902',
            secret: 'sec_custom_secret',
          }),
          { status: 200 }
        )
      );

      const result = await client.createWebhook(
        '90171427561',
        'https://tunnel.trycloudflare.com/webhook',
        ['taskCreated', 'taskUpdated']
      );

      expect(result).toEqual({
        id: 'webhook_902',
        secret: 'sec_custom_secret',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team/90171427561/webhook',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            endpoint: 'https://tunnel.trycloudflare.com/webhook',
            events: ['taskCreated', 'taskUpdated'],
          }),
        })
      );
    });
  });

  describe('deleteWebhook', () => {
    it('deletes webhook with DELETE /api/v2/webhook/:webhookId and returns true on 200', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );

      const success = await client.deleteWebhook('webhook_id_to_delete');

      expect(success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/webhook/webhook_id_to_delete',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('returns false when webhook is not found (404)', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ err: 'Webhook not found', ECODE: 'HOOK_014' }), { status: 404 })
      );

      const success = await client.deleteWebhook('non_existent_webhook');
      expect(success).toBe(false);
    });

    it('throws ClickUpApiError when deleteWebhook encounters non-404 error (e.g. 500)', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ err: 'Internal database error' }), { status: 500 })
      );

      await expect(client.deleteWebhook('webhook_fail')).rejects.toThrow(ClickUpApiError);
    });
  });

  describe('listWebhooks', () => {
    it('lists webhooks for team with GET /api/v2/team/:teamId/webhook', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            webhooks: [
              {
                id: 'wh_1',
                endpoint: 'https://tunnel-1.trycloudflare.com/webhook',
                client_id: 'client_1',
              },
              {
                id: 'wh_2',
                endpoint: 'https://tunnel-2.trycloudflare.com/webhook',
                client_id: 'client_2',
              },
            ],
          }),
          { status: 200 }
        )
      );

      const list = await client.listWebhooks('90171427561');

      expect(list).toEqual([
        { id: 'wh_1', endpoint: 'https://tunnel-1.trycloudflare.com/webhook' },
        { id: 'wh_2', endpoint: 'https://tunnel-2.trycloudflare.com/webhook' },
      ]);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team/90171427561/webhook',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns empty array when webhooks array is empty or missing', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );

      const list = await client.listWebhooks('90171427561');
      expect(list).toEqual([]);
    });
  });

  describe('Error Handling', () => {
    it('throws ClickUpApiError with status and message for 401 Unauthorized', async () => {
      const client = new ClickUpClient('pk_invalid');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ err: 'Oauth token not found', ECODE: 'OAUTH_019' }),
          { status: 401, statusText: 'Unauthorized' }
        )
      );

      let caughtError: ClickUpApiError | null = null;
      try {
        await client.getDefaultTeamId();
      } catch (err) {
        caughtError = err as ClickUpApiError;
      }

      expect(caughtError).toBeInstanceOf(ClickUpApiError);
      expect(caughtError?.status).toBe(401);
      expect(caughtError?.message).toBe('ClickUp API error (401): Oauth token not found');
      expect(caughtError?.errorDetail).toBe('Oauth token not found');
    });

    it('throws ClickUpApiError with status and message for 404 Not Found', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ err: 'Task not found', ECODE: 'ITEM_004' }),
          { status: 404, statusText: 'Not Found' }
        )
      );

      await expect(client.getTask('invalid_id')).rejects.toThrow(
        'ClickUp API error (404): Task not found'
      );
    });

    it('handles alternative error response keys (e.g. error or message)', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: 'Rate limit reached' }),
          { status: 429, statusText: 'Too Many Requests' }
        )
      );

      await expect(client.getDefaultTeamId()).rejects.toThrow(
        'ClickUp API error (429): Rate limit reached'
      );
    });

    it('handles non-JSON error response bodies gracefully', async () => {
      const client = new ClickUpClient('pk_test');
      fetchSpy.mockResolvedValueOnce(
        new Response('502 Bad Gateway - Cloudflare upstream error', {
          status: 502,
          statusText: 'Bad Gateway',
        })
      );

      await expect(client.getDefaultTeamId()).rejects.toThrow(
        'ClickUp API error (502): 502 Bad Gateway - Cloudflare upstream error'
      );
    });
  });

  describe('getRecentTasks', () => {
    it('queries tasks with default parameters (subtasks=true, include_closed=false, order_by=updated, reverse=true)', async () => {
      const client = new ClickUpClient('pk_test_token');
      const mockTasks = [
        { id: 't1', name: 'Task 1', status: { status: 'to do' } },
        { id: 't2', name: 'Task 2', status: { status: 'in progress' } },
      ];

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ tasks: mockTasks }), { status: 200 })
      );

      const tasks = await client.getRecentTasks('team_99');

      expect(tasks).toEqual(mockTasks);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team/team_99/task?subtasks=true&include_closed=false&order_by=updated&reverse=true',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'pk_test_token',
          }),
        })
      );
    });

    it('passes custom query parameters correctly', async () => {
      const client = new ClickUpClient('pk_test_token');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ tasks: [] }), { status: 200 })
      );

      await client.getRecentTasks('team_123', {
        includeClosed: true,
        subtasks: false,
        orderBy: 'created',
        reverse: false,
        page: 3,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team/team_123/task?subtasks=false&include_closed=true&order_by=created&reverse=false&page=3',
        expect.any(Object)
      );
    });

    it('returns empty array when tasks key is omitted or not an array', async () => {
      const client = new ClickUpClient('pk_test_token');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );

      const tasks = await client.getRecentTasks('team_empty');
      expect(tasks).toEqual([]);
    });
  });
});

