import { describe, it, expect } from 'vitest';
import { extractNgrokUrl, NgrokManager } from '../src/tunnel/ngrok.js';

describe('NgrokManager & URL Extractor', () => {
  it('extracts URL from JSON log line', () => {
    const log = '{"lvl":"info","msg":"started tunnel","obj":"tunnels","name":"command_line","addr":"http://localhost:3456","url":"https://superaverage-sharda-unthinkingly.ngrok-free.dev"}';
    expect(extractNgrokUrl(log)).toBe('https://superaverage-sharda-unthinkingly.ngrok-free.dev');
  });

  it('extracts URL from ngrok-free.app domain', () => {
    const log = '{"lvl":"info","msg":"started tunnel","url":"https://abc-123.ngrok-free.app"}';
    expect(extractNgrokUrl(log)).toBe('https://abc-123.ngrok-free.app');
  });

  it('returns null if no ngrok URL present', () => {
    expect(extractNgrokUrl('connecting to ngrok...')).toBeNull();
  });

  it('validates port number', async () => {
    const mgr = new NgrokManager();
    await expect(mgr.start(0)).rejects.toThrow('Invalid port: 0');
    await expect(mgr.start(70000)).rejects.toThrow('Invalid port: 70000');
  });

  it('rejects with descriptive error if binary does not exist', async () => {
    const mgr = new NgrokManager({ binaryPath: '/path/does/not/exist/ngrok-bogus' });
    await expect(mgr.start(3456)).rejects.toThrow();
  });
});
