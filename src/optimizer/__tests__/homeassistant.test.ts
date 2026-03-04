import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios');

import axios from 'axios';
import { createNotification, dismissNotification, NOTIFICATION_ID_NEGATIVE_PRICES } from '../homeassistant';

const HA_URL = 'http://homeassistant.local:8123';
const HA_TOKEN = 'test-token';

const mockPost = vi.fn().mockResolvedValue({ data: {} });
const mockGet  = vi.fn().mockResolvedValue({ data: {} });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(axios, 'create').mockReturnValue({ post: mockPost, get: mockGet } as any);
});

describe('createNotification', () => {
  it('posts to persistent_notification/create with correct payload', async () => {
    await createNotification(HA_URL, HA_TOKEN, 'Test title', 'Test message');

    expect(mockPost).toHaveBeenCalledWith(
      '/services/persistent_notification/create',
      {
        notification_id: 'sunsynk_optimizer',
        title: 'Test title',
        message: 'Test message',
      }
    );
  });
});

describe('dismissNotification', () => {
  it('posts to persistent_notification/dismiss with correct notification_id', async () => {
    await dismissNotification(HA_URL, HA_TOKEN);

    expect(mockPost).toHaveBeenCalledWith(
      '/services/persistent_notification/dismiss',
      { notification_id: 'sunsynk_optimizer' }
    );
  });

  it('uses a custom notification_id when provided', async () => {
    await dismissNotification(HA_URL, HA_TOKEN, NOTIFICATION_ID_NEGATIVE_PRICES);

    expect(mockPost).toHaveBeenCalledWith(
      '/services/persistent_notification/dismiss',
      { notification_id: NOTIFICATION_ID_NEGATIVE_PRICES }
    );
  });
});

describe('createNotification — custom id', () => {
  it('uses a custom notification_id when provided', async () => {
    await createNotification(HA_URL, HA_TOKEN, 'Title', 'Message', NOTIFICATION_ID_NEGATIVE_PRICES);

    expect(mockPost).toHaveBeenCalledWith(
      '/services/persistent_notification/create',
      {
        notification_id: NOTIFICATION_ID_NEGATIVE_PRICES,
        title: 'Title',
        message: 'Message',
      }
    );
  });
});
