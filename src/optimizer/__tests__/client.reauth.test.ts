import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('axios');

import axios from 'axios';
import SunsyncClient from '../../index';

// Real RSA-1024 key pair — needed so crypto.publicEncrypt in login() doesn't throw.
// Generated once at module level to avoid per-test overhead.
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const PUBLIC_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

// Capture the response interceptor error handler as the client registers it.
let capturedErrorHandler: (err: any) => any;
let mockAxiosInstance: any;

beforeEach(() => {
  vi.clearAllMocks();
  capturedErrorHandler = () => { throw new Error('interceptor not registered'); };

  // Must be callable: axios instances act as both a function and an object.
  mockAxiosInstance = Object.assign(vi.fn(), {
    get:  vi.fn(),
    post: vi.fn(),
    interceptors: {
      response: {
        use: vi.fn((_onOk: any, onError: any) => {
          capturedErrorHandler = onError;
          return 0;
        }),
      },
    },
  });

  vi.mocked(axios.create).mockReturnValue(mockAxiosInstance);
});

// ── Credential storage ───────────────────────────────────────────────────────

describe('SunsyncClient — credential storage', () => {
  it('stores username and password after successful login', async () => {
    mockAxiosInstance.get.mockResolvedValue({ data: { data: PUBLIC_KEY_B64 } });
    mockAxiosInstance.post.mockResolvedValue({ data: { access_token: 'tok-abc' } });

    const client = new SunsyncClient();
    await client.login('user@example.com', 'secret');

    expect((client as any)._username).toBe('user@example.com');
    expect((client as any)._password).toBe('secret');
    expect(client.token).toBe('tok-abc');
  });
});

// ── Token re-auth on 401 ─────────────────────────────────────────────────────

describe('SunsyncClient — token re-auth on 401', () => {
  function make401(retry = false) {
    return {
      response: { status: 401, data: 'Unauthorized' },
      config: { headers: { Authorization: 'Bearer old-token' }, _retry: retry },
    };
  }

  it('re-authenticates and retries on 401 when credentials are stored', async () => {
    const client = new SunsyncClient();
    (client as any)._username = 'user@example.com';
    (client as any)._password = 'secret';
    client.token = 'old-token';

    const loginSpy = vi.spyOn(client, 'login').mockResolvedValue('new-token');
    mockAxiosInstance.mockResolvedValue({ data: { ok: true } }); // retry succeeds

    const err = make401();
    await capturedErrorHandler(err);

    expect(loginSpy).toHaveBeenCalledWith('user@example.com', 'secret');
    expect(err.config.headers['Authorization']).toBe('Bearer new-token');
    expect(err.config._retry).toBe(true);
    expect(mockAxiosInstance).toHaveBeenCalledWith(err.config);
  });

  it('does NOT re-authenticate when credentials are not stored', async () => {
    const client = new SunsyncClient(); // no login called
    const loginSpy = vi.spyOn(client, 'login');

    await expect(capturedErrorHandler(make401())).rejects.toBeDefined();
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('does NOT re-authenticate on a second 401 (prevents infinite loop)', async () => {
    const client = new SunsyncClient();
    (client as any)._username = 'user@example.com';
    (client as any)._password = 'secret';
    const loginSpy = vi.spyOn(client, 'login');

    await expect(capturedErrorHandler(make401(true))).rejects.toBeDefined();
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('does NOT re-authenticate on non-401 errors', async () => {
    const client = new SunsyncClient();
    (client as any)._username = 'user@example.com';
    (client as any)._password = 'secret';
    const loginSpy = vi.spyOn(client, 'login');

    const err500 = {
      response: { status: 500, data: 'error' },
      config: { headers: {}, _retry: false },
    };
    await expect(capturedErrorHandler(err500)).rejects.toBeDefined();
    expect(loginSpy).not.toHaveBeenCalled();
  });
});
