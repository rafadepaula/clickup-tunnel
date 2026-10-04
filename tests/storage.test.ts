import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StorageDB } from '../src/storage/db.js';
import type { TaskRecord, WebhookEventRecord } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('StorageDB', () => {
  let db: StorageDB;

  beforeEach(() => {
    db = new StorageDB(':memory:');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore if already closed
    }
  });

  describe('Initialization and Schema', () => {
    it('initializes in :memory: and creates tasks and webhook_events tables and indexes', () => {
      // DB initialized without error
      expect(db).toBeInstanceOf(StorageDB);
      expect(db.getPendingCount()).toBe(0);
    });

    it('resolves custom file path and auto-creates parent directory', () => {
      const tempDir = path.join(os.tmpdir(), `clickup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'nested');
      const tempDbPath = path.join(tempDir, 'test.db');

      expect(fs.existsSync(tempDir)).toBe(false);

      const customDb = new StorageDB(tempDbPath);
      expect(fs.existsSync(tempDir)).toBe(true);
      expect(fs.existsSync(tempDbPath)).toBe(true);

      customDb.close();
      fs.rmSync(path.dirname(tempDir), { recursive: true, force: true });
    });

    it('resolves path from process.env.CLICKUP_TUNNEL_DB if dbPath is not provided', () => {
      const tempDir = path.join(os.tmpdir(), `clickup-test-env-${Date.now()}`);
      const envDbPath = path.join(tempDir, 'env-events.db');
      const originalEnv = process.env.CLICKUP_TUNNEL_DB;

      process.env.CLICKUP_TUNNEL_DB = envDbPath;
      try {
        const envDb = new StorageDB();
        expect(fs.existsSync(envDbPath)).toBe(true);
        envDb.close();
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLICKUP_TUNNEL_DB = originalEnv;
        } else {
          delete process.env.CLICKUP_TUNNEL_DB;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('resolves default path ~/.clickup-tunnel/events.db when neither dbPath nor env is set', () => {
      const originalEnv = process.env.CLICKUP_TUNNEL_DB;
      delete process.env.CLICKUP_TUNNEL_DB;

      const testTmpDir = path.join(os.tmpdir(), `clickup-test-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(testTmpDir);

      try {
        const expectedDir = path.join(testTmpDir, '.clickup-tunnel');
        const expectedDbPath = path.join(expectedDir, 'events.db');

        // Create a test instance with undefined path to verify it defaults to home directory path
        const defaultDb = new StorageDB();
        expect(fs.existsSync(expectedDir)).toBe(true);
        expect(fs.existsSync(expectedDbPath)).toBe(true);
        defaultDb.close();
      } finally {
        homedirSpy.mockRestore();
        if (originalEnv !== undefined) {
          process.env.CLICKUP_TUNNEL_DB = originalEnv;
        }
        fs.rmSync(testTmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('saveTask and getTaskById', () => {
    it('saves a task and retrieves it by id', () => {
      const taskData: Omit<TaskRecord, 'updated_at'> = {
        id: 'task-101',
        name: 'Implement OAuth',
        status: 'in progress',
        tags: ['auth', 'backend'],
        description: 'Set up OAuth flow with Google',
        url: 'https://app.clickup.com/t/task-101',
        list_id: 'list-1',
        list_name: 'Sprint Backlog',
        raw_json: JSON.stringify({ id: 'task-101', name: 'Implement OAuth' }),
        created_at: 1700000000000,
      };

      db.saveTask(taskData);

      const result = db.getTaskById('task-101');
      expect(result.task).not.toBeNull();
      expect(result.task?.id).toBe('task-101');
      expect(result.task?.name).toBe('Implement OAuth');
      expect(result.task?.status).toBe('in progress');
      expect(result.task?.tags).toEqual(['auth', 'backend']);
      expect(result.task?.description).toBe('Set up OAuth flow with Google');
      expect(result.task?.url).toBe('https://app.clickup.com/t/task-101');
      expect(result.task?.list_id).toBe('list-1');
      expect(result.task?.list_name).toBe('Sprint Backlog');
      expect(result.task?.raw_json).toBe(taskData.raw_json);
      expect(result.task?.created_at).toBe(1700000000000);
      expect(typeof result.task?.updated_at).toBe('number');
      expect(result.events).toEqual([]);
    });

    it('returns null task and empty events for non-existent taskId', () => {
      const result = db.getTaskById('non-existent');
      expect(result.task).toBeNull();
      expect(result.events).toEqual([]);
    });

    it('upserts a task when saved multiple times', () => {
      const initialTask: Omit<TaskRecord, 'updated_at'> = {
        id: 'task-102',
        name: 'Initial Name',
        status: 'open',
        tags: ['v1'],
        description: 'Initial description',
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      };

      db.saveTask(initialTask);

      const updatedTask: Omit<TaskRecord, 'updated_at'> = {
        ...initialTask,
        name: 'Updated Name',
        status: 'done',
        tags: ['v1', 'completed'],
        description: 'Updated description',
      };

      db.saveTask(updatedTask);

      const result = db.getTaskById('task-102');
      expect(result.task?.name).toBe('Updated Name');
      expect(result.task?.status).toBe('done');
      expect(result.task?.tags).toEqual(['v1', 'completed']);
      expect(result.task?.description).toBe('Updated description');
    });
  });

  describe('insertEvent and getPendingTasks', () => {
    it('inserts an event and retrieves it in getPendingTasks', () => {
      const taskData: Omit<TaskRecord, 'updated_at'> = {
        id: 'task-201',
        name: 'Fix Login CSRF Bug',
        status: 'open',
        tags: ['bug', 'agent-ready'],
        description: 'Vulnerability in login POST request',
        url: 'https://app.clickup.com/t/task-201',
        list_id: 'list-bugs',
        list_name: 'Bugs',
        raw_json: '{}',
        created_at: 1700000000000,
      };
      db.saveTask(taskData);

      const history = [{ field: 'status', before: 'open', after: 'in progress' }];
      const eventId = db.insertEvent('task-201', 'taskUpdated', history);
      expect(typeof eventId).toBe('number');
      expect(eventId).toBeGreaterThan(0);

      const pending = db.getPendingTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0].event_id).toBe(eventId);
      expect(pending[0].task_id).toBe('task-201');
      expect(pending[0].name).toBe('Fix Login CSRF Bug');
      expect(pending[0].status).toBe('open');
      expect(pending[0].tags).toEqual(['bug', 'agent-ready']);
      expect(pending[0].description).toBe('Vulnerability in login POST request');
      expect(pending[0].event_type).toBe('taskUpdated');
      expect(pending[0].history_items).toEqual(history);
      // received_at should be ISO string
      expect(new Date(pending[0].received_at).toISOString()).toBe(pending[0].received_at);
    });

    it('retrieves event history in getTaskById', () => {
      const taskData: Omit<TaskRecord, 'updated_at'> = {
        id: 'task-202',
        name: 'Event History Test',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1700000000000,
      };
      db.saveTask(taskData);

      const event1Id = db.insertEvent('task-202', 'taskCreated', []);
      const event2Id = db.insertEvent('task-202', 'taskUpdated', [{ field: 'assignee' }]);

      const result = db.getTaskById('task-202');
      expect(result.events).toHaveLength(2);
      expect(result.events[0].id).toBe(event1Id);
      expect(result.events[0].event_type).toBe('taskCreated');
      expect(result.events[0].history_items).toEqual([]);
      expect(result.events[1].id).toBe(event2Id);
      expect(result.events[1].event_type).toBe('taskUpdated');
      expect(result.events[1].history_items).toEqual([{ field: 'assignee' }]);
    });
  });

  describe('Tag filtering in getPendingTasks', () => {
    beforeEach(() => {
      db.saveTask({
        id: 'task-bug',
        name: 'Bug Task',
        status: 'open',
        tags: ['bug', 'urgent'],
        description: 'Bug description',
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1000,
      });

      db.saveTask({
        id: 'task-feature',
        name: 'Feature Task',
        status: 'open',
        tags: ['feature', 'ui'],
        description: 'Feature description',
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 2000,
      });

      db.saveTask({
        id: 'task-debug',
        name: 'Debug Task',
        status: 'open',
        tags: ['debug-only'], // Should NOT match tag "bug"
        description: 'Debug info',
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 3000,
      });

      db.insertEvent('task-bug', 'taskCreated', []);
      db.insertEvent('task-feature', 'taskCreated', []);
      db.insertEvent('task-debug', 'taskCreated', []);
    });

    it('returns all pending tasks when no tag filter is specified', () => {
      const pending = db.getPendingTasks();
      expect(pending).toHaveLength(3);
    });

    it('filters tasks strictly by matching tag', () => {
      const bugs = db.getPendingTasks(10, 'bug');
      expect(bugs).toHaveLength(1);
      expect(bugs[0].task_id).toBe('task-bug');

      const features = db.getPendingTasks(10, 'feature');
      expect(features).toHaveLength(1);
      expect(features[0].task_id).toBe('task-feature');

      const nonExistent = db.getPendingTasks(10, 'unknown');
      expect(nonExistent).toHaveLength(0);
    });

    it('respects the limit parameter', () => {
      const limited = db.getPendingTasks(2);
      expect(limited).toHaveLength(2);
    });
  });

  describe('markEventStatus and getPendingCount', () => {
    it('marks event status and updates pending count', () => {
      db.saveTask({
        id: 'task-301',
        name: 'Task 301',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1000,
      });

      const eventId1 = db.insertEvent('task-301', 'taskCreated', []);
      const eventId2 = db.insertEvent('task-301', 'taskUpdated', []);

      expect(db.getPendingCount()).toBe(2);

      // Mark event 1 as processed
      const updated = db.markEventStatus(eventId1, 'processed', 'Completed successfully');
      expect(updated).toBe(true);

      expect(db.getPendingCount()).toBe(1);

      const pending = db.getPendingTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0].event_id).toBe(eventId2);

      // Verify event details in task
      const result = db.getTaskById('task-301');
      const processedEvent = result.events.find((e) => e.id === eventId1);
      expect(processedEvent?.processing_status).toBe('processed');
      expect(processedEvent?.agent_notes).toBe('Completed successfully');
      expect(typeof processedEvent?.processed_at).toBe('number');
    });

    it('returns false when marking a non-existent event', () => {
      const updated = db.markEventStatus(999999, 'processed');
      expect(updated).toBe(false);
    });

    it('preserves existing agent_notes when notes is undefined on subsequent status change', () => {
      db.saveTask({
        id: 'task-302',
        name: 'Task 302',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1000,
      });

      const eventId = db.insertEvent('task-302', 'taskCreated', []);

      // Set initial status with notes
      db.markEventStatus(eventId, 'processing', 'Initial processing note');
      let result = db.getTaskById('task-302');
      let event = result.events.find((e) => e.id === eventId);
      expect(event?.processing_status).toBe('processing');
      expect(event?.agent_notes).toBe('Initial processing note');

      // Update status without notes - should preserve existing notes
      db.markEventStatus(eventId, 'processed');
      result = db.getTaskById('task-302');
      event = result.events.find((e) => e.id === eventId);
      expect(event?.processing_status).toBe('processed');
      expect(event?.agent_notes).toBe('Initial processing note');

      // Update status with new notes - should overwrite
      db.markEventStatus(eventId, 'failed', 'Updated failure note');
      result = db.getTaskById('task-302');
      event = result.events.find((e) => e.id === eventId);
      expect(event?.processing_status).toBe('failed');
      expect(event?.agent_notes).toBe('Updated failure note');
    });
  });

  describe('listRecentEvents', () => {
    it('lists recent events with task names joined, ordered by newest first', () => {
      db.saveTask({
        id: 'task-401',
        name: 'Alpha Task',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 1000,
      });

      db.saveTask({
        id: 'task-402',
        name: 'Beta Task',
        status: 'open',
        tags: [],
        description: null,
        url: null,
        list_id: null,
        list_name: null,
        raw_json: '{}',
        created_at: 2000,
      });

      const e1 = db.insertEvent('task-401', 'taskCreated', []);
      const e2 = db.insertEvent('task-402', 'taskCreated', []);

      db.markEventStatus(e1, 'processed');

      const allRecent = db.listRecentEvents(10);
      expect(allRecent).toHaveLength(2);
      expect(allRecent[0].id).toBe(e2);
      expect(allRecent[0].task_name).toBe('Beta Task');
      expect(allRecent[1].id).toBe(e1);
      expect(allRecent[1].task_name).toBe('Alpha Task');

      // Filter by status
      const processedOnly = db.listRecentEvents(10, 'processed');
      expect(processedOnly).toHaveLength(1);
      expect(processedOnly[0].id).toBe(e1);

      const pendingOnly = db.listRecentEvents(10, 'pending');
      expect(pendingOnly).toHaveLength(1);
      expect(pendingOnly[0].id).toBe(e2);
    });
  });
});
