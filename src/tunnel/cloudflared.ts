import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CLOUDFLARE_URL_REGEX = /https:\/\/[-a-zA-Z0-9]+\.trycloudflare\.com/;

/**
 * Extracts a trycloudflare.com URL from output text.
 * Returns null if no matching URL is found.
 */
export function extractTunnelUrl(text: string): string | null {
  const match = text.match(CLOUDFLARE_URL_REGEX);
  return match ? match[0] : null;
}

/**
 * Auto-detects the cloudflared binary location.
 * Search order:
 * 1. options.binaryPath (if provided)
 * 2. /home/linuxbrew/.linuxbrew/bin/cloudflared
 * 3. /usr/local/bin/cloudflared
 * 4. /usr/bin/cloudflared
 * 5. PATH environment variable
 *
 * Throws if the binary cannot be located.
 */
export function findCloudflaredBinary(customPath?: string): string {
  if (customPath) {
    if (fs.existsSync(customPath)) {
      return customPath;
    }
    throw new Error(`cloudflared binary not found at specified path: ${customPath}`);
  }

  const commonPaths = [
    '/home/linuxbrew/.linuxbrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ];

  for (const candidate of commonPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'cloudflared');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'cloudflared binary not found. Please install cloudflared or specify binaryPath in options.'
  );
}

export interface TunnelManagerOptions {
  binaryPath?: string;
  startupTimeoutMs?: number;
}

/**
 * Manages the Cloudflare Quick Tunnel child process lifecycle.
 */
export class TunnelManager {
  private options: TunnelManagerOptions;
  private childProcess: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private exitHandler: (() => void) | null = null;

  constructor(options: TunnelManagerOptions = {}) {
    this.options = options;
  }

  /**
   * Returns true if the tunnel process is currently running and active.
   */
  public isRunning(): boolean {
    return (
      this.childProcess !== null &&
      this.childProcess.exitCode === null &&
      !this.childProcess.killed
    );
  }

  /**
   * Returns the current public trycloudflare URL or null if tunnel is inactive.
   */
  public getUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * Spawns a Quick Tunnel forwarding to http://127.0.0.1:${port}
   * and resolves with the public https://*.trycloudflare.com URL.
   */
  public async startQuickTunnel(port: number): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${port}. Port must be an integer between 1 and 65535.`);
    }

    if (this.isRunning()) {
      throw new Error('Tunnel is already running');
    }

    const binary = findCloudflaredBinary(this.options.binaryPath);
    const timeoutMs = this.options.startupTimeoutMs ?? 30000;

    return new Promise<string>((resolve, reject) => {
      let resolved = false;
      let startupTimer: NodeJS.Timeout | null = null;

      const cleanupTimer = () => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
      };

      try {
        const child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });

        this.childProcess = child;
        this.tunnelUrl = null;

        this.exitHandler = () => {
          if (this.childProcess) {
            try {
              this.childProcess.kill('SIGTERM');
            } catch {
              // ignore
            }
          }
        };
        process.once('exit', this.exitHandler);

        const handleData = (chunk: Buffer | string) => {
          if (resolved) return;
          const text = chunk.toString();
          const match = extractTunnelUrl(text);
          if (match) {
            resolved = true;
            this.tunnelUrl = match;
            cleanupTimer();
            resolve(match);
          }
        };

        if (child.stdout) {
          child.stdout.on('data', handleData);
        }
        if (child.stderr) {
          child.stderr.on('data', handleData);
        }

        child.once('error', (err) => {
          cleanupTimer();
          this.cleanupProcessState();
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });

        child.once('exit', (code, signal) => {
          cleanupTimer();
          this.cleanupProcessState();
          if (!resolved) {
            resolved = true;
            reject(
              new Error(
                `cloudflared process exited with code ${code ?? signal ?? 'unknown'} before establishing tunnel`
              )
            );
          }
        });

        child.once('close', () => {
          this.cleanupProcessState();
        });

        startupTimer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          cleanupTimer();

          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }

          this.cleanupProcessState();
          reject(new Error(`Cloudflare tunnel startup timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        startupTimer.unref?.();
      } catch (err) {
        cleanupTimer();
        this.cleanupProcessState();
        reject(err);
      }
    });
  }

  /**
   * Gracefully stops the tunnel process.
   * Sends SIGTERM first, then escalates to SIGKILL if not exited within gracePeriodMs.
   */
  public async stop(gracePeriodMs = 3000): Promise<void> {
    const child = this.childProcess;
    if (!child || child.exitCode !== null || child.killed) {
      this.cleanupProcessState();
      return;
    }

    return new Promise<void>((resolve) => {
      let resolved = false;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this.cleanupProcessState();
        resolve();
      };

      child.once('exit', finish);
      child.once('close', finish);

      try {
        child.kill('SIGTERM');
      } catch {
        finish();
        return;
      }

      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish();
      }, gracePeriodMs);

      forceKillTimer.unref?.();
    });
  }

  private cleanupProcessState(): void {
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
    this.childProcess = null;
    this.tunnelUrl = null;
  }
}
