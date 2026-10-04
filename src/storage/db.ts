import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { TaskRecord, WebhookEventRecord, PendingTaskItem, ProcessingStatus } from '../types.js';

export class StorageDB {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolvedPath = this.resolvePath(dbPath);

    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(resolvedPath);
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(resolvedPath);
    this.init();
  }

  private resolvePath(dbPath?: string): string {
    if (dbPath) {
      if (dbPath === ':memory:') {
        return ':memory:';
      }
      return this.expandTilde(dbPath);
    }

    const envPath = process.env.CLICKUP_TUNNEL_DB;
    if (envPath) {
      if (envPath === ':memory:') {
        return ':memory:';
      }
      return this.expandTilde(envPath);
    }

    return path.join(os.homedir(), '.clickup-tunnel', 'events.db');
  }

  private expandTilde(filepath: string): string {
    if (filepath === '~' || filepath.startsWith('~/')) {
      return path.join(os.homedir(), filepath.slice(1));
    }
    return path.resolve(filepath);
  }

  private init(): void {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        description TEXT,
        url TEXT,
        list_id TEXT,
        list_name TEXT,
        raw_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        history_items TEXT,
        processing_status TEXT NOT NULL DEFAULT 'pending',
        agent_notes TEXT,
        received_at INTEGER NOT NULL,
        processed_at INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_status ON webhook_events(processing_status);
      CREATE INDEX IF NOT EXISTS idx_events_task_id ON webhook_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_received_at ON webhook_events(received_at);

      CREATE TABLE IF NOT EXISTS daemon_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  saveTask(task: Omit<TaskRecord, 'updated_at'>): void {
    const updatedAt = Date.now();
    const tagsJson = JSON.stringify(task.tags || []);
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, name, status, tags, description, url, list_id, list_name, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        tags = excluded.tags,
        description = excluded.description,
        url = excluded.url,
        list_id = excluded.list_id,
        list_name = excluded.list_name,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at;
    `);

    stmt.run(
      task.id,
      task.name,
      task.status,
      tagsJson,
      task.description ?? null,
      task.url ?? null,
      task.list_id ?? null,
      task.list_name ?? null,
      task.raw_json ?? '{}',
      task.created_at,
      updatedAt
    );
  }

  /**
   * Checks whether a task exists in the local database.
   */
  hasTask(taskId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM tasks WHERE id = ? LIMIT 1');
    return stmt.get(taskId) !== undefined;
  }

  insertEvent(
    taskId: string,
    eventType: string,
    historyItems: any[],
    status: ProcessingStatus = 'pending'
  ): number {
    const receivedAt = Date.now();
    const historyJson = JSON.stringify(historyItems || []);
    const processedAt = status === 'pending' ? null : receivedAt;
    const stmt = this.db.prepare(`
      INSERT INTO webhook_events (
        task_id, event_type, history_items, processing_status, agent_notes, received_at, processed_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?);
    `);

    const result = stmt.run(taskId, eventType, historyJson, status, receivedAt, processedAt);
    return Number(result.lastInsertRowid);
  }

  getPendingTasks(limit: number = 10, tagFilter?: string, includeHistory: boolean = false): PendingTaskItem[] {
    let query = `
      SELECT
        t.id as task_id,
        t.name,
        t.status,
        t.tags,
        t.description,
        t.url,
        json_group_array(e.id) as event_ids_json,
        COUNT(e.id) as event_count,
        (SELECT event_type FROM webhook_events WHERE task_id = t.id AND processing_status = 'pending' ORDER BY received_at DESC, id DESC LIMIT 1) as latest_event,
        (SELECT history_items FROM webhook_events WHERE task_id = t.id AND processing_status = 'pending' ORDER BY received_at DESC, id DESC LIMIT 1) as latest_history,
        MAX(e.received_at) as latest_received_at,
        MIN(e.id) as first_event_id
      FROM tasks t
      JOIN webhook_events e ON e.task_id = t.id
      WHERE e.processing_status = 'pending'
    `;

    const params: (string | number)[] = [];

    if (tagFilter) {
      query += ` AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)`;
      params.push(tagFilter);
    }

    query += ` GROUP BY t.id ORDER BY latest_received_at ASC, first_event_id ASC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      task_id: string;
      name: string;
      status: string;
      tags: string;
      description: string | null;
      url: string | null;
      event_ids_json: string;
      event_count: number | bigint;
      latest_event: string | null;
      latest_history: string | null;
      latest_received_at: number | bigint;
      first_event_id: number | bigint;
    }>;

    return rows.map((row) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(row.tags || '[]');
      } catch {
        tags = [];
      }

      let eventIds: number[] = [];
      try {
        eventIds = JSON.parse(row.event_ids_json || '[]').map((id: any) => Number(id));
      } catch {
        eventIds = [];
      }

      let historyItems: any[] = [];
      try {
        historyItems = JSON.parse(row.latest_history || '[]');
      } catch {
        historyItems = [];
      }

      const firstId = Number(row.first_event_id);
      const latestEvent = row.latest_event ? String(row.latest_event) : 'taskUpdated';

      return {
        event_id: firstId,
        task_id: String(row.task_id),
        name: String(row.name),
        status: String(row.status),
        tags,
        description: row.description !== null ? String(row.description) : null,
        url: row.url !== null ? String(row.url) : null,
        event_ids: eventIds,
        latest_event: latestEvent,
        event_type: latestEvent,
        event_count: Number(row.event_count),
        received_at: new Date(Number(row.latest_received_at)).toISOString(),
        history_items: historyItems,
      };
    });
  }

  markEventStatus(eventId: number, status: ProcessingStatus, notes?: string): boolean {
    const processedAt = status === 'pending' ? null : Date.now();
    const stmt = this.db.prepare(`
      UPDATE webhook_events
      SET processing_status = ?,
          agent_notes = COALESCE(?, agent_notes),
          processed_at = ?
      WHERE id = ?;
    `);

    const result = stmt.run(status, notes ?? null, processedAt, eventId);
    return Number(result.changes) > 0;
  }

  markTaskStatus(taskId: string, status: ProcessingStatus, notes?: string): number {
    const processedAt = status === 'pending' ? null : Date.now();
    const stmt = this.db.prepare(`
      UPDATE webhook_events
      SET processing_status = ?,
          agent_notes = COALESCE(?, agent_notes),
          processed_at = ?
      WHERE task_id = ? AND processing_status = 'pending';
    `);

    const result = stmt.run(status, notes ?? null, processedAt, taskId);
    return Number(result.changes);
  }

  setDaemonState(state: {
    active: boolean;
    pid: number;
    tunnel_url: string | null;
    webhook_id: string | null;
    team_id: string | null;
    port: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO daemon_state (key, value, updated_at)
      VALUES ('current', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    `);
    stmt.run(JSON.stringify(state), Date.now());
  }

  getDaemonState(): {
    active: boolean;
    pid?: number;
    tunnel_url: string | null;
    webhook_id: string | null;
    team_id: string | null;
    port?: number;
    updated_at: number;
  } | null {
    try {
      const stmt = this.db.prepare('SELECT value, updated_at FROM daemon_state WHERE key = ?');
      const row = stmt.get('current') as { value: string; updated_at: number | bigint } | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.value);
      return { ...parsed, updated_at: Number(row.updated_at) };
    } catch {
      return null;
    }
  }

  getTaskById(taskId: string): { task: TaskRecord | null; events: WebhookEventRecord[] } {
    const taskStmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const taskRow = taskStmt.get(taskId) as
      | {
          id: string;
          name: string;
          status: string;
          tags: string;
          description: string | null;
          url: string | null;
          list_id: string | null;
          list_name: string | null;
          raw_json: string;
          created_at: number | bigint;
          updated_at: number | bigint;
        }
      | undefined;

    let task: TaskRecord | null = null;
    if (taskRow) {
      let tags: string[] = [];
      try {
        tags = JSON.parse(taskRow.tags || '[]');
      } catch {
        tags = [];
      }

      task = {
        id: String(taskRow.id),
        name: String(taskRow.name),
        status: String(taskRow.status),
        tags,
        description: taskRow.description !== null ? String(taskRow.description) : null,
        url: taskRow.url !== null ? String(taskRow.url) : null,
        list_id: taskRow.list_id !== null ? String(taskRow.list_id) : null,
        list_name: taskRow.list_name !== null ? String(taskRow.list_name) : null,
        raw_json: String(taskRow.raw_json),
        created_at: Number(taskRow.created_at),
        updated_at: Number(taskRow.updated_at),
      };
    }

    const eventsStmt = this.db.prepare(`
      SELECT * FROM webhook_events
      WHERE task_id = ?
      ORDER BY received_at ASC, id ASC;
    `);

    const eventRows = eventsStmt.all(taskId) as Array<{
      id: number | bigint;
      task_id: string;
      event_type: string;
      history_items: string | null;
      processing_status: string;
      agent_notes: string | null;
      received_at: number | bigint;
      processed_at: number | bigint | null;
    }>;

    const events: WebhookEventRecord[] = eventRows.map((row) => {
      let historyItems: any[] = [];
      try {
        historyItems = JSON.parse(row.history_items || '[]');
      } catch {
        historyItems = [];
      }

      return {
        id: Number(row.id),
        task_id: String(row.task_id),
        event_type: String(row.event_type),
        history_items: historyItems,
        processing_status: row.processing_status as ProcessingStatus,
        agent_notes: row.agent_notes !== null ? String(row.agent_notes) : null,
        received_at: Number(row.received_at),
        processed_at: row.processed_at !== null ? Number(row.processed_at) : null,
      };
    });

    return { task, events };
  }

  listRecentEvents(
    limit: number = 20,
    status?: ProcessingStatus
  ): (WebhookEventRecord & { task_name?: string })[] {
    let query = `
      SELECT
        e.id,
        e.task_id,
        e.event_type,
        e.history_items,
        e.processing_status,
        e.agent_notes,
        e.received_at,
        e.processed_at,
        t.name as task_name
      FROM webhook_events e
      LEFT JOIN tasks t ON e.task_id = t.id
    `;

    const params: (string | number)[] = [];

    if (status) {
      query += ` WHERE e.processing_status = ?`;
      params.push(status);
    }

    query += ` ORDER BY e.received_at DESC, e.id DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      id: number | bigint;
      task_id: string;
      event_type: string;
      history_items: string | null;
      processing_status: string;
      agent_notes: string | null;
      received_at: number | bigint;
      processed_at: number | bigint | null;
      task_name: string | null;
    }>;

    return rows.map((row) => {
      let historyItems: any[] = [];
      try {
        historyItems = JSON.parse(row.history_items || '[]');
      } catch {
        historyItems = [];
      }

      const event: WebhookEventRecord & { task_name?: string } = {
        id: Number(row.id),
        task_id: String(row.task_id),
        event_type: String(row.event_type),
        history_items: historyItems,
        processing_status: row.processing_status as ProcessingStatus,
        agent_notes: row.agent_notes !== null ? String(row.agent_notes) : null,
        received_at: Number(row.received_at),
        processed_at: row.processed_at !== null ? Number(row.processed_at) : null,
      };

      if (row.task_name !== null && row.task_name !== undefined) {
        event.task_name = String(row.task_name);
      }

      return event;
    });
  }

  getPendingCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM webhook_events WHERE processing_status = 'pending';
    `);
    const row = stmt.get() as { count: number | bigint };
    return Number(row.count);
  }

  close(): void {
    this.db.close();
  }
}
