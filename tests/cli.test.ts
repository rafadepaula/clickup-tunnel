import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import * as indexExports from '../src/index.js';
import {
  parseCliArgs,
  resolveToken,
  resolveTeamId,
  startDaemon,
  showStatus,
  cleanWebhooks,
  syncMissingTasks,
  runCli,
  VERSION,
} from '../src/cli.js';
import { StorageDB } from '../src/storage/db.js';
import { ClickUpClient } from '../src/clickup/client.js';

describe('Task 7: CLI Entrypoint & Library Exports', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.CLICKUP_API_TOKEN;
    delete process.env.CLICKUP_TEAM_ID;
    delete process.env.PORT;
    delete process.env.CLICKUP_TUNNEL_DB;
    delete process.env.WEBHOOK_PUBLIC_URL;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  describe('src/index.ts exports', () => {
    it('exports all core classes', () => {
      expect(indexExports.StorageDB).toBeDefined();
      expect(indexExports.ClickUpClient).toBeDefined();
      expect(indexExports.ClickUpApiError).toBeDefined();
      expect(indexExports.TunnelManager).toBeDefined();
      expect(indexExports.WebhookServer).toBeDefined();
      expect(indexExports.ClickUpTunnelMcpServer).toBeDefined();
    });

    it('exports core utility functions and constants', () => {
      expect(typeof indexExports.findCloudflaredBinary).toBe('function');
      expect(typeof indexExports.extractTunnelUrl).toBe('function');
      expect(typeof indexExports.convertTaskDetail).toBe('function');
      expect(indexExports.CLOUDFLARE_URL_REGEX).toBeInstanceOf(RegExp);
    });

    it('exports CLI functions', () => {
      expect(typeof indexExports.parseCliArgs).toBe('function');
      expect(typeof indexExports.runCli).toBe('function');
    });
  });

  describe('CLI Argument Parsing (parseCliArgs)', () => {
    it('defaults to help command when no arguments are provided', () => {
      const parsed = parseCliArgs([]);
      expect(parsed.command).toBe('help');
    });

    it('parses "start" command with full options', () => {
      const parsed = parseCliArgs([
        'start',
        '--token', 'pk_test_token',
        '--port', '4000',
        '--db', ':memory:',
        '--team', 'team_999',
        '--url', 'https://custom-tunnel.domain.com',
      ]);

      expect(parsed.command).toBe('start');
      expect(parsed.options.token).toBe('pk_test_token');
      expect(parsed.options.port).toBe(4000);
      expect(parsed.options.db).toBe(':memory:');
      expect(parsed.options.team).toBe('team_999');
      expect(parsed.options.url).toBe('https://custom-tunnel.domain.com');
    });

    it('parses short options (-t, -p, -h, -v)', () => {
      const parsed = parseCliArgs(['start', '-t', 'pk_short_token', '-p', '5000']);
      expect(parsed.command).toBe('start');
      expect(parsed.options.token).toBe('pk_short_token');
      expect(parsed.options.port).toBe(5000);
    });

    it('switches command to "help" when --help or -h is passed', () => {
      expect(parseCliArgs(['--help']).command).toBe('help');
      expect(parseCliArgs(['start', '-h']).command).toBe('help');
      expect(parseCliArgs(['help']).command).toBe('help');
    });

    it('switches command to "version" when --version or -v is passed', () => {
      expect(parseCliArgs(['--version']).command).toBe('version');
      expect(parseCliArgs(['-v']).command).toBe('version');
      expect(parseCliArgs(['version']).command).toBe('version');
    });

    it('parses "mcp", "status", "clean", and "sync" commands', () => {
      expect(parseCliArgs(['mcp']).command).toBe('mcp');
      expect(parseCliArgs(['status', '--db', ':memory:']).command).toBe('status');
      expect(parseCliArgs(['clean', '--team', '123']).command).toBe('clean');
      expect(parseCliArgs(['sync', '--team', '123']).command).toBe('sync');
    });

    it('parses --include-closed and --no-sync options', () => {
      const parsed = parseCliArgs(['start', '--include-closed', '--no-sync']);
      expect(parsed.options.includeClosed).toBe(true);
      expect(parsed.options.noSync).toBe(true);
    });
  });

  describe('Security & Token Resolution', () => {
    it('resolves token strictly from options or environment variable', () => {
      expect(resolveToken({})).toBeNull();

      expect(resolveToken({ token: 'pk_cli_flag' })).toBe('pk_cli_flag');

      process.env.CLICKUP_API_TOKEN = 'pk_env_token';
      expect(resolveToken({})).toBe('pk_env_token');

      // CLI flag takes priority over env var
      expect(resolveToken({ token: 'pk_override' })).toBe('pk_override');
    });

    it('never reads tokens from arbitrary file paths (zero fallback to token.txt)', () => {
      // resolveToken must only use options.token or process.env.CLICKUP_API_TOKEN
      delete process.env.CLICKUP_API_TOKEN;
      const token = resolveToken({} as any);
      expect(token).toBeNull();
    });
  });

  describe('Team ID Resolution', () => {
    it('resolves team ID from options, then env, then ClickUp API client', async () => {
      expect(await resolveTeamId({ team: 'team_from_opt' } as any, null as any)).toBe('team_from_opt');

      process.env.CLICKUP_TEAM_ID = 'team_from_env';
      expect(await resolveTeamId({} as any, null as any)).toBe('team_from_env');

      delete process.env.CLICKUP_TEAM_ID;
      const fakeClient = {
        getDefaultTeamId: vi.fn().mockResolvedValue('team_from_api'),
      } as unknown as ClickUpClient;

      expect(await resolveTeamId({} as any, fakeClient)).toBe('team_from_api');
      expect(fakeClient.getDefaultTeamId).toHaveBeenCalledTimes(1);
    });
  });

  describe('Commands Execution', () => {
    describe('status command', () => {
      it('prints statistics and pending tasks without error', async () => {
        const db = new StorageDB(':memory:');
        db.saveTask({
          id: 'task_1',
          name: 'Test Task',
          status: 'to do',
          tags: ['backend'],
          description: 'A test task',
          url: 'https://app.clickup.com/t/task_1',
          list_id: 'list_1',
          list_name: 'Tasks',
          raw_json: '{}',
          created_at: Date.now(),
        });
        db.insertEvent('task_1', 'taskCreated', []);

        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showStatus({ db: ':memory:' }, db);

        expect(consoleLogSpy).toHaveBeenCalled();
        const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logs).toContain('Pending Events: 1');
        expect(logs).toContain('task_1');

        db.close();
      });
    });

    describe('clean command', () => {
      it('lists webhooks and deletes only those with trycloudflare.com / clickup-tunnel', async () => {
        const fakeClient = {
          listWebhooks: vi.fn().mockResolvedValue([
            { id: 'wh_1', endpoint: 'https://random-words.trycloudflare.com/webhook' },
            { id: 'wh_2', endpoint: 'https://my-domain.com/clickup-tunnel/hook' },
            { id: 'wh_3', endpoint: 'https://other-service.com/webhook' },
          ]),
          deleteWebhook: vi.fn().mockResolvedValue(true),
        } as unknown as ClickUpClient;

        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const count = await cleanWebhooks(fakeClient, 'team_123');

        expect(fakeClient.listWebhooks).toHaveBeenCalledWith('team_123');
        expect(fakeClient.deleteWebhook).toHaveBeenCalledWith('wh_1');
        expect(fakeClient.deleteWebhook).toHaveBeenCalledWith('wh_2');
        expect(fakeClient.deleteWebhook).not.toHaveBeenCalledWith('wh_3');
        expect(count).toBe(2);
      });
    });

    describe('start command (startDaemon)', () => {
      it('fails with clean message when CLICKUP_API_TOKEN is missing', async () => {
        delete process.env.CLICKUP_API_TOKEN;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const exitCode = await runCli(['start']);

        expect(exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalled();
        const errorLogs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(errorLogs).toContain('CLICKUP_API_TOKEN is required');
      });

      it('orchestrates daemon startup, banner printing, and graceful shutdown', async () => {
        const mockClient = {
          getDefaultTeamId: vi.fn().mockResolvedValue('team_abc'),
          createWebhook: vi.fn().mockResolvedValue({ id: 'wh_created_123', secret: 'wh_secret' }),
          deleteWebhook: vi.fn().mockResolvedValue(true),
          getTask: vi.fn(),
        } as unknown as ClickUpClient;

        const mockTunnel = {
          startQuickTunnel: vi.fn().mockResolvedValue('https://mock-tunnel.trycloudflare.com'),
          stop: vi.fn().mockResolvedValue(undefined),
          getUrl: vi.fn().mockReturnValue('https://mock-tunnel.trycloudflare.com'),
          isRunning: vi.fn().mockReturnValue(true),
        };

        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const controller = await startDaemon(
          {
            token: 'pk_mock_token',
            port: 0,
            db: ':memory:',
            team: 'team_abc',
          },
          {
            clickupClient: mockClient,
            tunnelManager: mockTunnel as any,
            autoListenSignals: false, // Don't attach process signal listeners during unit tests
          }
        );

        expect(controller).toBeDefined();
        expect(controller.webhookId).toBe('wh_created_123');
        expect(controller.tunnelUrl).toBe('https://mock-tunnel.trycloudflare.com');
        expect(mockClient.createWebhook).toHaveBeenCalledWith(
          'team_abc',
          'https://mock-tunnel.trycloudflare.com/webhook'
        );

        // Verify status banner was printed
        const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logs).toContain('mock-tunnel.trycloudflare.com');
        expect(logs).toContain('wh_created_123');
        expect(logs).toContain('npx @rafadepaula/clickup-tunnel mcp');

        // Test shutdown
        await controller.shutdown();

        expect(mockClient.deleteWebhook).toHaveBeenCalledWith('wh_created_123');
        expect(mockTunnel.stop).toHaveBeenCalled();
      });

      it('supports custom URL override without starting cloudflared tunnel', async () => {
        const mockClient = {
          createWebhook: vi.fn().mockResolvedValue({ id: 'wh_override_1', secret: 'wh_sec' }),
          deleteWebhook: vi.fn().mockResolvedValue(true),
        } as unknown as ClickUpClient;

        const mockTunnel = {
          startQuickTunnel: vi.fn(),
          stop: vi.fn(),
        };

        const controller = await startDaemon(
          {
            token: 'pk_mock_token',
            port: 0,
            db: ':memory:',
            team: 'team_custom',
            url: 'https://my-public-domain.org',
          },
          {
            clickupClient: mockClient,
            tunnelManager: mockTunnel as any,
            autoListenSignals: false,
          }
        );

        expect(mockTunnel.startQuickTunnel).not.toHaveBeenCalled();
        expect(controller.tunnelUrl).toBe('https://my-public-domain.org');
        expect(mockClient.createWebhook).toHaveBeenCalledWith(
          'team_custom',
          'https://my-public-domain.org/webhook'
        );

        await controller.shutdown();
      });
    });

    describe('runCli command dispatcher', () => {
      it('handles "version" command and returns 0', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const code = await runCli(['version']);
        expect(code).toBe(0);
        expect(consoleLogSpy).toHaveBeenCalledWith(VERSION);
      });

      it('handles "help" command and returns 0', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const code = await runCli(['help']);
        expect(code).toBe(0);
        const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logs).toContain('Usage: clickup-tunnel');
      });

      it('handles "status" command and returns 0', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const code = await runCli(['status', '--db', ':memory:']);
        expect(code).toBe(0);
      });

      it('handles "clean" command without token and returns 1 with clean error', async () => {
        delete process.env.CLICKUP_API_TOKEN;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const code = await runCli(['clean']);
        expect(code).toBe(1);
        const errorLogs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(errorLogs).toContain('CLICKUP_API_TOKEN is required');
      });

      it('handles cleanWebhooks when no webhooks match', async () => {
        const fakeClient = {
          listWebhooks: vi.fn().mockResolvedValue([
            { id: 'wh_other', endpoint: 'https://other-domain.com/hook' },
          ]),
          deleteWebhook: vi.fn(),
        } as unknown as ClickUpClient;

        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const count = await cleanWebhooks(fakeClient, 'team_123');

        expect(count).toBe(0);
        expect(fakeClient.deleteWebhook).not.toHaveBeenCalled();
        const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logs).toContain('No matching webhooks found to clean');
      });

      it('handles "sync" command without token and returns 1 with clean error', async () => {
        delete process.env.CLICKUP_API_TOKEN;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const code = await runCli(['sync']);
        expect(code).toBe(1);
        const errorLogs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(errorLogs).toContain('CLICKUP_API_TOKEN is required');
      });
    });

    describe('syncMissingTasks (initial startup sync / lost notifications)', () => {
      it('fetches tasks from ClickUp and backfills missing ones into SQLite queue', async () => {
        const db = new StorageDB(':memory:');

        // Pre-populate db with task_1
        db.saveTask({
          id: 'task_1',
          name: 'Already in SQLite',
          status: 'in progress',
          tags: [],
          description: null,
          url: null,
          list_id: null,
          list_name: null,
          raw_json: '{}',
          created_at: Date.now(),
        });

        const mockClient = {
          getRecentTasks: vi.fn().mockResolvedValue([
            {
              id: 'task_1',
              name: 'Already in SQLite',
              status: { status: 'in progress' },
            },
            {
              id: 'task_2',
              name: 'Missing Task 2',
              status: { status: 'to do' },
              tags: [{ name: 'frontend' }],
              description: 'Lost notification task',
              url: 'https://app.clickup.com/t/task_2',
              date_created: 1700000000000,
            },
            {
              id: 'task_3',
              name: 'Finished Task 3',
              status: { status: 'done', type: 'done' },
              tags: [],
              date_closed: 1700000100000,
            },
          ]),
        } as unknown as ClickUpClient;

        const result = await syncMissingTasks(mockClient, 'team_100', db, { includeClosed: true });

        expect(result.totalFetched).toBe(3);
        expect(result.newTasksCount).toBe(2);
        expect(result.taskIds).toEqual(['task_2', 'task_3']);

        // Verify task_2 was saved and enqueued as pending
        expect(db.hasTask('task_2')).toBe(true);
        const task2Detail = db.getTaskById('task_2');
        expect(task2Detail.task?.name).toBe('Missing Task 2');
        expect(task2Detail.task?.tags).toEqual(['frontend']);
        expect(task2Detail.events).toHaveLength(1);
        expect(task2Detail.events[0].processing_status).toBe('pending');
        expect(task2Detail.events[0].event_type).toBe('taskCreated');

        // Verify task_3 was saved with status 'processed' because it's already done
        expect(db.hasTask('task_3')).toBe(true);
        const task3Detail = db.getTaskById('task_3');
        expect(task3Detail.events[0].processing_status).toBe('processed');

        // Only task_2 should be in pending queue
        const pending = db.getPendingTasks();
        expect(pending).toHaveLength(1);
        expect(pending[0].task_id).toBe('task_2');

        db.close();
      });

      it('automatically runs sync on startDaemon and logs backfill summary', async () => {
        const db = new StorageDB(':memory:');
        const mockClient = {
          getDefaultTeamId: vi.fn().mockResolvedValue('team_sync'),
          createWebhook: vi.fn().mockResolvedValue({ id: 'wh_sync_1', secret: 'sec' }),
          deleteWebhook: vi.fn().mockResolvedValue(true),
          getRecentTasks: vi.fn().mockResolvedValue([
            { id: 'task_sync_a', name: 'Auto Synced Task', status: { status: 'open' } },
          ]),
        } as unknown as ClickUpClient;

        const mockTunnel = {
          startQuickTunnel: vi.fn().mockResolvedValue('https://mock.trycloudflare.com'),
          stop: vi.fn().mockResolvedValue(undefined),
        };

        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const controller = await startDaemon(
          {
            token: 'pk_sync_token',
            port: 0,
            team: 'team_sync',
          },
          {
            db,
            clickupClient: mockClient,
            tunnelManager: mockTunnel as any,
            autoListenSignals: false,
          }
        );

        expect(mockClient.getRecentTasks).toHaveBeenCalledWith(
          'team_sync',
          expect.objectContaining({ includeClosed: false })
        );
        expect(db.hasTask('task_sync_a')).toBe(true);

        const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logs).toContain('[Sync] Backfilled 1 missing task(s) from ClickUp into SQLite queue.');

        await controller.shutdown();
      });

      it('bypasses startup sync when noSync is true', async () => {
        const db = new StorageDB(':memory:');
        const mockClient = {
          getDefaultTeamId: vi.fn().mockResolvedValue('team_sync'),
          createWebhook: vi.fn().mockResolvedValue({ id: 'wh_sync_2', secret: 'sec' }),
          deleteWebhook: vi.fn().mockResolvedValue(true),
          getRecentTasks: vi.fn(),
        } as unknown as ClickUpClient;

        const mockTunnel = {
          startQuickTunnel: vi.fn().mockResolvedValue('https://mock.trycloudflare.com'),
          stop: vi.fn().mockResolvedValue(undefined),
        };

        const controller = await startDaemon(
          {
            token: 'pk_sync_token',
            port: 0,
            team: 'team_sync',
            noSync: true,
          },
          {
            db,
            clickupClient: mockClient,
            tunnelManager: mockTunnel as any,
            autoListenSignals: false,
          }
        );

        expect(mockClient.getRecentTasks).not.toHaveBeenCalled();
        await controller.shutdown();
      });
    });
  });

  describe('CLI Process Execution (E2E)', () => {
    const cliPath = path.resolve(__dirname, '../src/cli.ts');

    it('--help prints usage instructions with exit code 0', () => {
      const output = execSync(`npx tsx "${cliPath}" --help`, { encoding: 'utf-8' });
      expect(output).toContain('Usage: clickup-tunnel');
      expect(output).toContain('start');
      expect(output).toContain('mcp');
      expect(output).toContain('status');
      expect(output).toContain('clean');
    });

    it('--version prints package version with exit code 0', () => {
      const output = execSync(`npx tsx "${cliPath}" --version`, { encoding: 'utf-8' });
      expect(output.trim()).toMatch(/\d+\.\d+\.\d+/);
    });

    it('start without token exits with code 1 and clean error message on stderr', () => {
      let threw = false;
      try {
        execSync(`npx tsx "${cliPath}" start`, {
          encoding: 'utf-8',
          env: { ...process.env, CLICKUP_API_TOKEN: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        threw = true;
        expect(err.status).toBe(1);
        const stderr = err.stderr ? err.stderr.toString() : '';
        expect(stderr).toContain('CLICKUP_API_TOKEN is required');
        // Ensure no node stack trace is printed
        expect(stderr).not.toContain('at Object.<anonymous>');
        expect(stderr).not.toContain('at runCli');
      }
      expect(threw).toBe(true);
    });
  });
});
