import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface NgrokManagerOptions {
  binaryPath?: string;
  startupTimeoutMs?: number;
  domain?: string;
}

/**
 * Extracts public ngrok HTTPS URL from log strings.
 */
export function extractNgrokUrl(text: string): string | null {
  // Matches "url":"https://xxx" or URL: https://xxx
  const jsonMatch = text.match(/"url"\s*:\s*"(https:\/\/[^"\s]+)"/);
  if (jsonMatch && jsonMatch[1]) {
    return jsonMatch[1].trim();
  }

  const plainMatch = text.match(/(https:\/\/[a-zA-Z0-9.-]+\.ngrok(?:-free)?\.(?:dev|app|io)[^\s]*)/);
  if (plainMatch && plainMatch[1]) {
    return plainMatch[1].trim().replace(/[,\s]+$/, '');
  }

  return null;
}

/**
 * Supervises an ngrok tunnel child process.
 */
export class NgrokManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private binaryPath: string;
  private startupTimeoutMs: number;
  private domain?: string;

  constructor(options: NgrokManagerOptions = {}) {
    super();
    this.binaryPath = options.binaryPath ?? 'ngrok';
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15000;
    this.domain = options.domain ?? process.env.NGROK_DOMAIN;
  }

  /**
   * Starts ngrok tunnel pointing to local port and resolves with the public URL.
   */
  public async start(port: number): Promise<string> {
    if (this.child) {
      throw new Error('ngrok tunnel is already running');
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${port}`);
    }

    return new Promise<string>((resolve, reject) => {
      let resolved = false;
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stop().catch(() => {});
          reject(
            new Error(
              `ngrok tunnel startup timed out after ${this.startupTimeoutMs}ms. If another ngrok session is running on free tier, please stop it first.`
            )
          );
        }
      }, this.startupTimeoutMs);

      const args = ['http', String(port), '--log=stdout', '--log-format=json'];
      if (this.domain) {
        args.push(`--url=${this.domain}`);
      }

      try {
        this.child = spawn(this.binaryPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        clearTimeout(timeoutTimer);
        return reject(err);
      }

      const handleData = (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (!resolved) {
          const foundUrl = extractNgrokUrl(text);
          if (foundUrl) {
            resolved = true;
            clearTimeout(timeoutTimer);
            this.url = foundUrl;
            this.emit('ready', foundUrl);
            resolve(foundUrl);
          }
        }
      };

      this.child.stdout?.on('data', handleData);
      this.child.stderr?.on('data', handleData);

      this.child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutTimer);
          reject(new Error(`Failed to start ngrok binary: ${err.message}`));
        }
      });

      this.child.on('exit', (code, signal) => {
        const wasResolved = resolved;
        this.child = null;
        this.url = null;
        this.emit('exit', { code, signal });

        if (!wasResolved) {
          resolved = true;
          clearTimeout(timeoutTimer);
          reject(new Error(`ngrok process exited prematurely with code ${code ?? signal}`));
        }
      });
    });
  }

  /**
   * Gracefully terminates the ngrok child process.
   */
  public async stop(): Promise<void> {
    if (!this.child) {
      this.url = null;
      return;
    }

    const child = this.child;
    this.child = null;
    this.url = null;

    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 3000);

      child.once('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(forceKillTimer);
        resolve();
      }
    });
  }

  public getUrl(): string | null {
    return this.url;
  }

  public isRunning(): boolean {
    return this.child !== null && this.url !== null;
  }
}
