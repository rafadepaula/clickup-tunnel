import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import {
  TunnelManager,
  extractTunnelUrl,
  findCloudflaredBinary,
  CLOUDFLARE_URL_REGEX,
} from '../src/tunnel/cloudflared.js';

class MockChildProcess extends EventEmitter {
  public pid = 12345;
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();
  public stdin = new EventEmitter();
  public ignoreSigterm = false;

  public kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;

    if (signal === 'SIGTERM' && this.ignoreSigterm) {
      // Do not emit exit on SIGTERM if ignoreSigterm is true
      return true;
    }

    queueMicrotask(() => {
      this.exitCode = signal === 'SIGKILL' ? 137 : 0;
      this.emit('exit', this.exitCode, signal);
      this.emit('close', this.exitCode, signal);
    });
    return true;
  }
}

let mockChild: MockChildProcess;
let mockExistsSync = vi.fn().mockReturnValue(true);
let mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: (p: any) => mockExistsSync(p),
  },
  existsSync: (p: any) => mockExistsSync(p),
}));

describe('TunnelManager', () => {
  const originalEnvPath = process.env.PATH;

  beforeEach(() => {
    mockChild = new MockChildProcess();
    mockSpawn.mockReset().mockImplementation(() => mockChild);
    mockExistsSync.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = originalEnvPath;
  });

  describe('URL Extraction Regex and Helper', () => {
    it('extracts URL from sample cloudflared output line', () => {
      const line = '2026-10-04T00:26:07Z INF |  https://innovative-paso-elder-bizarre.trycloudflare.com   |';
      const url = extractTunnelUrl(line);
      expect(url).toBe('https://innovative-paso-elder-bizarre.trycloudflare.com');
    });

    it('extracts URL from multi-line banner output', () => {
      const output = [
        '2026-10-04T00:26:07Z INF +--------------------------------------------------------------------------------------------+',
        '2026-10-04T00:26:07Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
        '2026-10-04T00:26:07Z INF |  https://brave-falcon-tunnel-42.trycloudflare.com                                         |',
        '2026-10-04T00:26:07Z INF +--------------------------------------------------------------------------------------------+',
      ].join('\n');

      expect(extractTunnelUrl(output)).toBe('https://brave-falcon-tunnel-42.trycloudflare.com');
    });

    it('matches URLs containing letters, numbers, and hyphens', () => {
      const line = 'INF https://a1-b2-c3-4d.trycloudflare.com is ready';
      expect(extractTunnelUrl(line)).toBe('https://a1-b2-c3-4d.trycloudflare.com');
    });

    it('returns null when no trycloudflare URL is present', () => {
      const line = '2026-10-04T00:26:07Z INF Starting cloudflared tunnel client...';
      expect(extractTunnelUrl(line)).toBeNull();
    });

    it('returns null for insecure http protocol', () => {
      const line = 'http://innovative-paso-elder-bizarre.trycloudflare.com';
      expect(extractTunnelUrl(line)).toBeNull();
    });

    it('returns null for non-trycloudflare domains', () => {
      const line = 'https://cloudflare.com or https://trycloudflare.other.com';
      expect(extractTunnelUrl(line)).toBeNull();
    });

    it('CLOUDFLARE_URL_REGEX matches trycloudflare url directly', () => {
      expect(CLOUDFLARE_URL_REGEX.test('https://sub-domain.trycloudflare.com')).toBe(true);
      expect(CLOUDFLARE_URL_REGEX.test('http://sub-domain.trycloudflare.com')).toBe(false);
    });
  });

  describe('Binary Auto-Detection (findCloudflaredBinary)', () => {
    it('uses options.binaryPath when specified and file exists', () => {
      mockExistsSync.mockImplementation((p) => p === '/custom/bin/cloudflared');
      const binary = findCloudflaredBinary('/custom/bin/cloudflared');
      expect(binary).toBe('/custom/bin/cloudflared');
    });

    it('throws error when options.binaryPath is specified but does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => findCloudflaredBinary('/non/existent/cloudflared')).toThrow(
        /cloudflared binary not found at specified path/
      );
    });

    it('detects /home/linuxbrew/.linuxbrew/bin/cloudflared', () => {
      mockExistsSync.mockImplementation((p) => p === '/home/linuxbrew/.linuxbrew/bin/cloudflared');
      const binary = findCloudflaredBinary();
      expect(binary).toBe('/home/linuxbrew/.linuxbrew/bin/cloudflared');
    });

    it('detects /usr/local/bin/cloudflared when linuxbrew is not present', () => {
      mockExistsSync.mockImplementation((p) => p === '/usr/local/bin/cloudflared');
      const binary = findCloudflaredBinary();
      expect(binary).toBe('/usr/local/bin/cloudflared');
    });

    it('detects /usr/bin/cloudflared when previous paths are not present', () => {
      mockExistsSync.mockImplementation((p) => p === '/usr/bin/cloudflared');
      const binary = findCloudflaredBinary();
      expect(binary).toBe('/usr/bin/cloudflared');
    });

    it('detects cloudflared from PATH directories when default paths not present', () => {
      process.env.PATH = '/opt/bin:/my/tools/bin';
      mockExistsSync.mockImplementation((p) => p === path.join('/my/tools/bin', 'cloudflared'));

      const binary = findCloudflaredBinary();
      expect(binary).toBe(path.join('/my/tools/bin', 'cloudflared'));
    });

    it('throws when cloudflared binary is not found in any location', () => {
      mockExistsSync.mockReturnValue(false);
      process.env.PATH = '/usr/bin:/bin';
      expect(() => findCloudflaredBinary()).toThrow(/cloudflared binary not found/);
    });
  });

  describe('Lifecycle: startQuickTunnel, isRunning, getUrl', () => {
    it('initializes with inactive state', () => {
      const manager = new TunnelManager();
      expect(manager.isRunning()).toBe(false);
      expect(manager.getUrl()).toBeNull();
    });

    it('spawns cloudflared with correct arguments and resolves when URL received on stderr', async () => {
      mockExistsSync.mockReturnValue(true);
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });

      const startPromise = manager.startQuickTunnel(3000);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/cloudflared',
        ['tunnel', '--url', 'http://127.0.0.1:3000'],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );

      // Emit sample output on stderr
      mockChild.stderr.emit(
        'data',
        Buffer.from('2026-10-04T00:26:07Z INF |  https://my-quick-tunnel.trycloudflare.com   |\n')
      );

      const url = await startPromise;
      expect(url).toBe('https://my-quick-tunnel.trycloudflare.com');
      expect(manager.isRunning()).toBe(true);
      expect(manager.getUrl()).toBe('https://my-quick-tunnel.trycloudflare.com');
    });

    it('resolves when URL received on stdout', async () => {
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });

      const startPromise = manager.startQuickTunnel(8080);

      mockChild.stdout.emit(
        'data',
        Buffer.from('Created tunnel at https://stdout-tunnel.trycloudflare.com\n')
      );

      const url = await startPromise;
      expect(url).toBe('https://stdout-tunnel.trycloudflare.com');
      expect(manager.isRunning()).toBe(true);
      expect(manager.getUrl()).toBe('https://stdout-tunnel.trycloudflare.com');
    });

    it('validates port parameter', async () => {
      const manager = new TunnelManager();
      await expect(manager.startQuickTunnel(0)).rejects.toThrow(/Invalid port/);
      await expect(manager.startQuickTunnel(-1)).rejects.toThrow(/Invalid port/);
      await expect(manager.startQuickTunnel(65536)).rejects.toThrow(/Invalid port/);
      await expect(manager.startQuickTunnel(NaN)).rejects.toThrow(/Invalid port/);
    });

    it('rejects if tunnel is already running', async () => {
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });
      const startPromise = manager.startQuickTunnel(3000);

      mockChild.stderr.emit(
        'data',
        Buffer.from('https://first-tunnel.trycloudflare.com\n')
      );
      await startPromise;

      await expect(manager.startQuickTunnel(3001)).rejects.toThrow(/Tunnel is already running/);
    });

    it('rejects if binary not found', async () => {
      mockExistsSync.mockReturnValue(false);
      const manager = new TunnelManager({ binaryPath: '/non/existent/cloudflared' });

      await expect(manager.startQuickTunnel(3000)).rejects.toThrow(/cloudflared binary not found/);
      expect(manager.isRunning()).toBe(false);
    });

    it('rejects if child process emits error before URL is resolved', async () => {
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });
      const startPromise = manager.startQuickTunnel(3000);

      mockChild.emit('error', new Error('spawn ENOENT'));

      await expect(startPromise).rejects.toThrow('spawn ENOENT');
      expect(manager.isRunning()).toBe(false);
      expect(manager.getUrl()).toBeNull();
    });

    it('rejects if child process exits unexpectedly before URL is resolved', async () => {
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });
      const startPromise = manager.startQuickTunnel(3000);

      mockChild.exitCode = 1;
      mockChild.emit('exit', 1, null);
      mockChild.emit('close', 1, null);

      await expect(startPromise).rejects.toThrow(/exited with code 1/);
      expect(manager.isRunning()).toBe(false);
      expect(manager.getUrl()).toBeNull();
    });

    it('updates state if child process terminates unexpectedly after URL is resolved', async () => {
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });
      const startPromise = manager.startQuickTunnel(3000);

      mockChild.stderr.emit(
        'data',
        Buffer.from('https://active-tunnel.trycloudflare.com\n')
      );
      await startPromise;
      expect(manager.isRunning()).toBe(true);

      // Child terminates unexpectedly
      mockChild.exitCode = 1;
      mockChild.emit('exit', 1, null);
      mockChild.emit('close', 1, null);

      expect(manager.isRunning()).toBe(false);
      expect(manager.getUrl()).toBeNull();
    });
  });

  describe('Timeout Handling', () => {
    it('rejects with timeout error if URL is not found within startupTimeoutMs and kills child', async () => {
      const manager = new TunnelManager({
        binaryPath: '/bin/cloudflared',
        startupTimeoutMs: 50,
      });

      const killSpy = vi.spyOn(mockChild, 'kill');
      const startPromise = manager.startQuickTunnel(3000);

      // Send unrelated logs
      mockChild.stderr.emit('data', Buffer.from('Starting up, please wait...\n'));

      await expect(startPromise).rejects.toThrow(/timed out after 50ms/);
      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
      expect(manager.isRunning()).toBe(false);
      expect(manager.getUrl()).toBeNull();
    });
  });

  describe('Stopping Tunnel (stop)', () => {
    it('gracefully sends SIGTERM and waits for exit', async () => {
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });
      const startPromise = manager.startQuickTunnel(3000);

      mockChild.stderr.emit(
        'data',
        Buffer.from('https://stop-test-tunnel.trycloudflare.com\n')
      );
      await startPromise;

      const killSpy = vi.spyOn(mockChild, 'kill');
      await manager.stop();

      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
      expect(manager.isRunning()).toBe(false);
      expect(manager.getUrl()).toBeNull();
    });

    it('falls back to SIGKILL if process does not exit within grace period', async () => {
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });
      const startPromise = manager.startQuickTunnel(3000);

      mockChild.stderr.emit(
        'data',
        Buffer.from('https://force-kill-tunnel.trycloudflare.com\n')
      );
      await startPromise;

      mockChild.ignoreSigterm = true;
      const killSpy = vi.spyOn(mockChild, 'kill');

      // Stop with a short grace period of 50ms
      await manager.stop(50);

      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
      expect(killSpy).toHaveBeenCalledWith('SIGKILL');
      expect(manager.isRunning()).toBe(false);
      expect(manager.getUrl()).toBeNull();
    });

    it('does nothing and resolves cleanly when stop() called on stopped tunnel', async () => {
      const manager = new TunnelManager();
      expect(manager.isRunning()).toBe(false);
      await expect(manager.stop()).resolves.toBeUndefined();
      expect(manager.isRunning()).toBe(false);
      expect(manager.getUrl()).toBeNull();
    });
  });

  describe('Parent Process Exit Cleanup', () => {
    it('kills child process if parent process exits', async () => {
      const manager = new TunnelManager({ binaryPath: '/bin/cloudflared' });
      const startPromise = manager.startQuickTunnel(3000);

      mockChild.stderr.emit(
        'data',
        Buffer.from('https://exit-cleanup-tunnel.trycloudflare.com\n')
      );
      await startPromise;

      const killSpy = vi.spyOn(mockChild, 'kill');

      // Trigger process exit event
      process.emit('exit', 0);

      expect(killSpy).toHaveBeenCalledWith('SIGTERM');

      // Cleanup
      await manager.stop();
    });
  });
});
