import { createHash } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { AUTH_USER_DOC_BY_ID_PREFIX } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';

const AUTH_USER_DOC_CACHE_VERSION = 1;

export type AuthUserDocCacheMode = 'off' | 'on';

export interface AuthUserDocCacheStore {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
}

export interface AuthUserDocCacheKeyInput {
  strategy: string;
  subject?: string;
  issuer?: string;
  scope?: string;
}

interface CachedAuthUserDoc {
  version: number;
  cachedAt: number;
  user: Partial<IUser>;
}

function parseAuthUserDocCacheTtlMs(): number {
  const parsed = Number(process.env.AUTH_USER_CACHE_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getAuthUserDocCacheTtlMs(): number {
  return parseAuthUserDocCacheTtlMs();
}

export function getAuthUserDocCacheMode(): AuthUserDocCacheMode {
  if (parseAuthUserDocCacheTtlMs() <= 0) {
    return 'off';
  }
  const mode = process.env.AUTH_USER_CACHE_MODE;
  if (mode === 'on') {
    return mode;
  }
  return 'off';
}

function normalizeKeyPart(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\/+$/, '');
}

export function buildAuthUserDocCacheKey(input: AuthUserDocCacheKeyInput): string | undefined {
  const strategy = input.strategy.trim();
  const subject = input.subject?.trim();
  if (!strategy || !subject) {
    return undefined;
  }

  const digest = createHash('sha256')
    .update(
      [
        normalizeKeyPart(strategy),
        subject,
        normalizeKeyPart(input.issuer),
        normalizeKeyPart(input.scope),
      ].join('\0'),
    )
    .digest('base64url');

  return `auth-user-doc:v${AUTH_USER_DOC_CACHE_VERSION}:${digest}`;
}

function getUserId(user: Partial<IUser>): string | undefined {
  const id = user._id ?? user.id;
  if (id == null) {
    return undefined;
  }
  return typeof id === 'string' ? id : id.toString();
}

export function buildAuthUserDocReverseIndexKey(userId: string): string {
  return `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
}

function sanitizeUserForCache(user: Partial<IUser>): Partial<IUser> {
  const sanitized = { ...user };
  const id = getUserId(sanitized);
  if (id) {
    sanitized._id = id as unknown as IUser['_id'];
    sanitized.id = id;
  }

  delete sanitized.password;
  delete sanitized.refreshToken;
  delete sanitized.totpSecret;
  delete sanitized.pendingTotpSecret;
  delete sanitized.backupCodes;
  delete sanitized.pendingBackupCodes;
  delete sanitized.federatedTokens;
  delete sanitized.openidTokens;

  return sanitized;
}

async function rememberUserCacheKey(
  store: AuthUserDocCacheStore,
  userId: string,
  cacheKey: string,
  ttlMs: number,
): Promise<void> {
  const indexKey = buildAuthUserDocReverseIndexKey(userId);
  const existing = await store.get<string[]>(indexKey);
  const keys = Array.isArray(existing) ? existing.filter((value) => value !== cacheKey) : [];
  keys.push(cacheKey);
  await store.set(indexKey, keys.slice(-20), ttlMs);
}

export async function getCachedAuthUserDoc(
  store: AuthUserDocCacheStore,
  cacheKey: string,
): Promise<Partial<IUser> | undefined> {
  try {
    const cached = await store.get<CachedAuthUserDoc>(cacheKey);
    if (!cached || cached.version !== AUTH_USER_DOC_CACHE_VERSION || !cached.user) {
      return undefined;
    }
    return cached.user;
  } catch (error) {
    logger.warn('[authUserDocCache] Cache read failed; falling back to user lookup', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function setCachedAuthUserDoc(
  store: AuthUserDocCacheStore,
  cacheKey: string,
  user: Partial<IUser>,
): Promise<void> {
  const ttlMs = parseAuthUserDocCacheTtlMs();
  if (ttlMs <= 0) {
    return;
  }
  try {
    const sanitized = sanitizeUserForCache(user);
    await store.set(
      cacheKey,
      {
        version: AUTH_USER_DOC_CACHE_VERSION,
        cachedAt: Date.now(),
        user: sanitized,
      } satisfies CachedAuthUserDoc,
      ttlMs,
    );
    const userId = getUserId(sanitized);
    if (userId) {
      await rememberUserCacheKey(store, userId, cacheKey, ttlMs);
    }
  } catch (error) {
    logger.warn('[authUserDocCache] Cache write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function invalidateCachedAuthUserDoc(
  store: AuthUserDocCacheStore | undefined,
  input: { userId?: string; cacheKey?: string },
): Promise<void> {
  if (!store) {
    return;
  }
  try {
    const keys = new Set<string>();
    if (input.cacheKey) {
      keys.add(input.cacheKey);
    }
    if (input.userId) {
      const indexKey = buildAuthUserDocReverseIndexKey(input.userId);
      const indexed = await store.get<string[]>(indexKey);
      if (Array.isArray(indexed)) {
        for (const key of indexed) {
          keys.add(key);
        }
      }
      await store.delete(indexKey);
    }
    await Promise.all([...keys].map((key) => store.delete(key)));
  } catch (error) {
    logger.warn('[authUserDocCache] Cache invalidation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
