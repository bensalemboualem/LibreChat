import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';

import {
  buildAuthUserDocCacheKey,
  buildAuthUserDocReverseIndexKey,
  getAuthUserDocCacheMode,
  getCachedAuthUserDoc,
  invalidateCachedAuthUserDoc,
  setCachedAuthUserDoc,
} from './userDocCache';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

const ORIGINAL_ENV = {
  AUTH_USER_CACHE_MODE: process.env.AUTH_USER_CACHE_MODE,
  AUTH_USER_CACHE_TTL_MS: process.env.AUTH_USER_CACHE_TTL_MS,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function makeStore() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: jest.fn(async <T = unknown>(key: string) => values.get(key) as T | undefined),
    set: jest.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key: string) => values.delete(key)),
  };
}

describe('auth user document cache helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv();
  });

  afterAll(() => {
    restoreEnv();
  });

  it('only enables cache modes when a positive TTL is configured', () => {
    process.env.AUTH_USER_CACHE_MODE = 'on';
    delete process.env.AUTH_USER_CACHE_TTL_MS;
    expect(getAuthUserDocCacheMode()).toBe('off');

    process.env.AUTH_USER_CACHE_TTL_MS = '0';
    expect(getAuthUserDocCacheMode()).toBe('off');

    process.env.AUTH_USER_CACHE_TTL_MS = '60000';
    expect(getAuthUserDocCacheMode()).toBe('on');

    process.env.AUTH_USER_CACHE_MODE = 'shadow';
    expect(getAuthUserDocCacheMode()).toBe('off');

    process.env.AUTH_USER_CACHE_MODE = 'invalid';
    expect(getAuthUserDocCacheMode()).toBe('off');
  });

  it('builds stable keys from strategy, subject, issuer, and scope', () => {
    const key = buildAuthUserDocCacheKey({
      strategy: ' OpenID-JWT ',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com/',
      scope: ' Org-A ',
    });
    const equivalent = buildAuthUserDocCacheKey({
      strategy: 'openid-jwt',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      scope: 'org-a',
    });
    const otherScope = buildAuthUserDocCacheKey({
      strategy: 'openid-jwt',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      scope: 'org-b',
    });

    expect(key).toMatch(/^auth-user-doc:v1:/);
    expect(key).toBe(equivalent);
    expect(key).not.toBe(otherScope);
    expect(buildAuthUserDocCacheKey({ strategy: '', subject: 'subject-1' })).toBeUndefined();
    expect(buildAuthUserDocCacheKey({ strategy: 'openid-jwt' })).toBeUndefined();
  });

  it('sanitizes sensitive fields and remembers cache keys by user id', async () => {
    process.env.AUTH_USER_CACHE_TTL_MS = '60000';
    const store = makeStore();
    const cacheKey = 'auth-user-doc:v1:key';
    const userId = new Types.ObjectId();

    await setCachedAuthUserDoc(store, cacheKey, {
      _id: userId,
      id: userId.toString(),
      email: 'user@example.com',
      provider: 'openid',
      password: 'secret',
      refreshToken: [{ refreshToken: 'secret' }],
      federatedTokens: { access_token: 'secret' },
      openidTokens: { accessToken: 'secret' },
      totpSecret: 'secret',
      backupCodes: [{ codeHash: 'secret', used: false }],
    });

    const cached = store.values.get(cacheKey) as { user: Record<string, unknown> };
    expect(cached.user).toMatchObject({
      _id: userId.toString(),
      id: userId.toString(),
      email: 'user@example.com',
    });
    expect(cached.user.password).toBeUndefined();
    expect(cached.user.refreshToken).toBeUndefined();
    expect(cached.user.federatedTokens).toBeUndefined();
    expect(cached.user.openidTokens).toBeUndefined();
    expect(cached.user.totpSecret).toBeUndefined();
    expect(cached.user.backupCodes).toBeUndefined();

    expect(store.values.get(buildAuthUserDocReverseIndexKey(userId.toString()))).toEqual([
      cacheKey,
    ]);
  });

  it('deduplicates reverse-index keys and caps the remembered set', async () => {
    process.env.AUTH_USER_CACHE_TTL_MS = '60000';
    const store = makeStore();
    const userId = new Types.ObjectId().toString();
    const indexKey = buildAuthUserDocReverseIndexKey(userId);
    store.values.set(
      indexKey,
      Array.from({ length: 20 }, (_value, index) => `existing-key-${index}`),
    );

    await setCachedAuthUserDoc(store, 'existing-key-10', {
      _id: userId,
      email: 'user@example.com',
    });
    await setCachedAuthUserDoc(store, 'new-key', {
      _id: userId,
      email: 'user@example.com',
    });

    const indexed = store.values.get(indexKey);
    expect(indexed).toHaveLength(20);
    expect(indexed).not.toContain('existing-key-0');
    expect(indexed).toContain('existing-key-10');
    expect(indexed).toContain('new-key');
  });

  it('returns cached user documents only for the current cache version', async () => {
    const store = makeStore();
    store.values.set('current', { version: 1, cachedAt: Date.now(), user: { id: 'user-1' } });
    store.values.set('stale', { version: 0, cachedAt: Date.now(), user: { id: 'user-2' } });

    await expect(getCachedAuthUserDoc(store, 'current')).resolves.toEqual({ id: 'user-1' });
    await expect(getCachedAuthUserDoc(store, 'stale')).resolves.toBeUndefined();
  });

  it('invalidates explicit and reverse-indexed cache keys', async () => {
    const store = makeStore();
    store.values.set(buildAuthUserDocReverseIndexKey('user-1'), ['key-a', 'key-b']);

    await invalidateCachedAuthUserDoc(store, { userId: 'user-1', cacheKey: 'key-c' });

    expect(store.delete).toHaveBeenCalledWith(buildAuthUserDocReverseIndexKey('user-1'));
    expect(store.delete).toHaveBeenCalledWith('key-a');
    expect(store.delete).toHaveBeenCalledWith('key-b');
    expect(store.delete).toHaveBeenCalledWith('key-c');
  });

  it('logs cache failures without throwing', async () => {
    const store = {
      get: jest.fn(async () => {
        throw new Error('redis unavailable');
      }),
      set: jest.fn(),
      delete: jest.fn(),
    };

    await expect(getCachedAuthUserDoc(store, 'key')).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      '[authUserDocCache] Cache read failed; falling back to user lookup',
      { error: 'redis unavailable' },
    );
  });
});
