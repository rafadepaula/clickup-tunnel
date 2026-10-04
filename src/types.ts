export interface TaskRecord {
  id: string;
  name: string;
  status: string;
  tags: string[]; // parsed from JSON array
  description: string | null;
  url: string | null;
  list_id: string | null;
  list_name: string | null;
  raw_json: string;
  created_at: number;
  updated_at: number;
}

export type ProcessingStatus = 'pending' | 'in_progress' | 'processed' | 'failed' | 'ignored';

export interface WebhookEventRecord {
  id: number;
  task_id: string;
  event_type: string;
  history_items: any[];
  processing_status: ProcessingStatus;
  agent_notes: string | null;
  received_at: number;
  processed_at: number | null;
}

export interface PendingTaskItem {
  event_id: number;
  task_id: string;
  name: string;
  status: string;
  tags: string[];
  description: string | null;
  url?: string | null;
  event_ids: number[];
  latest_event: string;
  event_type: string;
  event_count: number;
  received_at: string;
  history_items?: any[];
}

export interface TunnelStatus {
  active: boolean;
  tunnel_url: string | null;
  webhook_id: string | null;
  team_id: string | null;
  pending_tasks_count: number;
}

export interface ClickUpTag {
  name: string;
  tag_fg?: string;
  tag_bg?: string;
  creator?: number;
}

export interface ClickUpTaskDetail {
  id: string;
  name: string;
  status: { status: string; type?: string; orderindex?: number; color?: string } | string;
  tags?: ClickUpTag[] | string[];
  description?: string | null;
  url?: string | null;
  list?: { id: string; name: string };
  date_created?: string | number;
  date_updated?: string | number;
  [key: string]: any;
}

export type ClickUpTaskResponse = ClickUpTaskDetail;

export interface TunnelConfig {
  port: number;
  publicUrl?: string;
  tunnelToken?: string;
  dbPath?: string;
}

export type McpTaskItem = PendingTaskItem;
