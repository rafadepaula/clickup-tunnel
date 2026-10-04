import http, { type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import type { StorageDB } from '../storage/db.js';
import type { ClickUpClient } from '../clickup/client.js';
import type { TaskRecord, ClickUpTaskDetail } from '../types.js';

export interface WebhookServerOptions {
  db: StorageDB;
  clickup: ClickUpClient;
  port?: number;
}

/**
 * Converts a raw ClickUp task detail object from the API into a TaskRecord
 * suitable for StorageDB.saveTask.
 */
export function convertTaskDetail(task: ClickUpTaskDetail): Omit<TaskRecord, 'updated_at'> {
  let statusStr = '';
  if (typeof task.status === 'string') {
    statusStr = task.status;
  } else if (task.status && typeof task.status === 'object') {
    statusStr = task.status.status || '';
  }

  const tags: string[] = [];
  if (Array.isArray(task.tags)) {
    for (const tag of task.tags) {
      if (typeof tag === 'string') {
        tags.push(tag);
      } else if (tag && typeof tag === 'object' && 'name' in tag && typeof tag.name === 'string') {
        tags.push(tag.name);
      }
    }
  }

  let createdAt = Date.now();
  if (task.date_created) {
    const parsed = Number(task.date_created);
    if (!Number.isNaN(parsed) && parsed > 0) {
      createdAt = parsed;
    }
  }

  return {
    id: String(task.id),
    name: String(task.name ?? ''),
    status: statusStr,
    tags,
    description: task.description !== undefined && task.description !== null ? String(task.description) : null,
    url: task.url !== undefined && task.url !== null ? String(task.url) : null,
    list_id: task.list?.id !== undefined && task.list?.id !== null ? String(task.list.id) : null,
    list_name: task.list?.name !== undefined && task.list?.name !== null ? String(task.list.name) : null,
    raw_json: JSON.stringify(task),
    created_at: createdAt,
  };
}

export class WebhookServer extends EventEmitter {
  private readonly db: StorageDB;
  private readonly clickup: ClickUpClient;
  private readonly requestedPort: number;
  private port: number | null = null;
  private server: Server | null = null;

  constructor(options: WebhookServerOptions) {
    super();
    this.db = options.db;
    this.clickup = options.clickup;
    this.requestedPort = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3456);
  }

  /**
   * Starts the HTTP server on the configured port.
   * Resolves with the actual listening port number.
   */
  start(): Promise<number> {
    if (this.server) {
      return Promise.reject(new Error('Server is already running'));
    }

    return new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server = server;

      const errorHandler = (err: Error) => {
        this.server = null;
        this.port = null;
        reject(err);
      };

      server.once('error', errorHandler);

      server.listen(this.requestedPort, () => {
        server.removeListener('error', errorHandler);
        server.on('error', (err) => {
          console.error('[WebhookServer] Server error:', err);
        });

        const addr = server.address() as AddressInfo | null;
        this.port = addr ? addr.port : this.requestedPort;
        resolve(this.port);
      });
    });
  }

  /**
   * Stops the HTTP server and actively closes open connections.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const serverToClose = this.server;
    this.server = null;
    this.port = null;

    return new Promise<void>((resolve, reject) => {
      if (typeof serverToClose.closeAllConnections === 'function') {
        serverToClose.closeAllConnections();
      }

      serverToClose.close((err) => {
        if (err && (err as any).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Returns the port the server is actively listening on.
   * Throws if the server is not currently running.
   */
  getPort(): number {
    if (!this.server || !this.server.listening || this.port === null) {
      throw new Error('Server is not running');
    }
    return this.port;
  }

  /**
   * Main HTTP request router.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && pathname === '/webhook') {
      this.handleWebhook(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  /**
   * Handles incoming POST /webhook requests.
   * Acknowledges immediately with 200 before asynchronously enriching the task.
   */
  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('error', (err) => {
      console.error('[WebhookServer] Request read error:', err);
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Request' }));
      }
    });

    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      let payload: any;

      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return;
      }

      // Immediate acknowledgement to prevent ClickUp webhook timeouts
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));

      // Asynchronously execute enrichment pipeline
      this.enrichTask(payload).catch((err) => {
        console.error('[WebhookServer] Unhandled error during task enrichment:', err);
      });
    });
  }

  /**
   * Enriches task details asynchronously by calling ClickUp API and storing in DB.
   */
  private async enrichTask(payload: any): Promise<void> {
    const taskId = payload?.task_id || payload?.task?.id || payload?.id;
    const event = payload?.event || payload?.event_type || 'taskUpdated';
    const historyItems = Array.isArray(payload?.history_items) ? payload.history_items : [];

    if (!taskId) {
      console.warn(`[Webhook] Ignored event '${event}': missing task_id`);
      this.emit('skipped', { reason: 'missing_task_id', payload });
      return;
    }

    const taskIdStr = String(taskId);

    try {
      const taskDetail = await this.clickup.getTask(taskIdStr);
      const taskRecord = convertTaskDetail(taskDetail);

      this.db.saveTask(taskRecord);
      const eventId = this.db.insertEvent(taskIdStr, String(event), historyItems);

      console.log(`[Webhook] Task updated: #${taskIdStr} "${taskRecord.name}" -> Saved to SQLite`);
      this.emit('enriched', {
        taskId: taskIdStr,
        eventId,
        task: taskRecord,
        event: String(event),
      });
    } catch (error) {
      console.error(`[Webhook] Failed to enrich task #${taskIdStr}:`, error);
      this.emit('enrichmentError', {
        taskId: taskIdStr,
        error,
      });
    }
  }
}
