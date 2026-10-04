import 'dotenv/config';
import type { ClickUpTaskDetail } from '../types.js';

export class ClickUpApiError extends Error {
  readonly status: number;
  readonly errorDetail: string;

  constructor(message: string, status: number, errorDetail: string) {
    super(message);
    this.name = 'ClickUpApiError';
    this.status = status;
    this.errorDetail = errorDetail;
    Object.setPrototypeOf(this, ClickUpApiError.prototype);
  }
}

export class ClickUpClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;

  constructor(apiToken?: string, baseUrl: string = 'https://api.clickup.com/api/v2') {
    const token = (apiToken || process.env.CLICKUP_API_TOKEN || '').trim();
    if (!token) {
      throw new Error('CLICKUP_API_TOKEN is required');
    }

    this.apiToken = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async handleError(response: Response): Promise<never> {
    let errorDetail = '';

    try {
      const rawText = await response.text();
      if (rawText && rawText.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawText);
          if (typeof parsed === 'object' && parsed !== null) {
            errorDetail = parsed.err || parsed.error || parsed.message || rawText;
          } else {
            errorDetail = String(parsed);
          }
        } catch {
          errorDetail = rawText;
        }
      }
    } catch {
      // response.text() failed, fallback to statusText
    }

    const detailStr = errorDetail && errorDetail.trim().length > 0
      ? errorDetail.trim()
      : (response.statusText || 'Unknown error');

    const message = `ClickUp API error (${response.status}): ${detailStr}`;
    throw new ClickUpApiError(message, response.status, detailStr);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = {
      Authorization: this.apiToken,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    const text = await response.text();
    if (!text || text.trim().length === 0) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async getDefaultTeamId(): Promise<string> {
    const data = await this.request<{ teams?: Array<{ id: string | number; name: string }> }>('/team', {
      method: 'GET',
    });

    if (!data.teams || !Array.isArray(data.teams) || data.teams.length === 0) {
      throw new Error('No teams found in ClickUp account');
    }

    return String(data.teams[0].id);
  }

  async getTask(taskId: string): Promise<ClickUpTaskDetail> {
    const encodedId = encodeURIComponent(taskId);
    const data = await this.request<{ task?: ClickUpTaskDetail } & ClickUpTaskDetail>(`/task/${encodedId}`, {
      method: 'GET',
    });

    return (data.task || data) as ClickUpTaskDetail;
  }

  async createWebhook(
    teamId: string,
    endpointUrl: string,
    events: string[] = ['*']
  ): Promise<{ id: string; secret: string }> {
    const encodedTeamId = encodeURIComponent(teamId);
    const body = JSON.stringify({
      endpoint: endpointUrl,
      events,
    });

    const data = await this.request<{
      id?: string;
      secret?: string;
      webhook?: { id: string; secret?: string };
    }>(`/team/${encodedTeamId}/webhook`, {
      method: 'POST',
      body,
    });

    const webhook = data.webhook ?? data;
    const id = String(data.id || webhook.id || '');
    const secret = String(data.secret || webhook.secret || '');

    return { id, secret };
  }

  async deleteWebhook(webhookId: string): Promise<boolean> {
    const encodedWebhookId = encodeURIComponent(webhookId);
    const url = `${this.baseUrl}/webhook/${encodedWebhookId}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: this.apiToken,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      await this.handleError(response);
    }

    return true;
  }

  async listWebhooks(teamId: string): Promise<Array<{ id: string; endpoint: string }>> {
    const encodedTeamId = encodeURIComponent(teamId);
    const data = await this.request<{
      webhooks?: Array<{ id: string | number; endpoint: string; [key: string]: any }>;
    }>(`/team/${encodedTeamId}/webhook`, {
      method: 'GET',
    });

    const webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
    return webhooks.map((w) => ({
      id: String(w.id),
      endpoint: String(w.endpoint),
    }));
  }

  async getRecentTasks(
    teamId: string,
    options: GetRecentTasksOptions = {}
  ): Promise<ClickUpTaskDetail[]> {
    const encodedTeamId = encodeURIComponent(teamId);
    const params = new URLSearchParams();
    params.set('subtasks', String(options.subtasks ?? true));
    params.set('include_closed', String(options.includeClosed ?? false));
    params.set('order_by', options.orderBy ?? 'updated');
    params.set('reverse', String(options.reverse ?? true));
    if (options.page !== undefined) {
      params.set('page', String(options.page));
    }

    const data = await this.request<{ tasks?: ClickUpTaskDetail[] }>(
      `/team/${encodedTeamId}/task?${params.toString()}`,
      { method: 'GET' }
    );

    return Array.isArray(data.tasks) ? data.tasks : [];
  }
}

export interface GetRecentTasksOptions {
  subtasks?: boolean;
  includeClosed?: boolean;
  orderBy?: string;
  reverse?: boolean;
  page?: number;
}
