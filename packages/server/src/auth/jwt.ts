import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import { getRuntimeConfigProvider } from '../runtime/config.js';

function accessTtl(): string {
  return getRuntimeConfigProvider().get('ACCESS_TOKEN_TTL') ?? '1d';
}

function refreshTtl(): string {
  return getRuntimeConfigProvider().get('REFRESH_TOKEN_TTL') ?? '7d';
}

function accessSecret(): string {
  return getRuntimeConfigProvider().require('JWT_ACCESS_SECRET');
}

function refreshSecret(): string {
  return getRuntimeConfigProvider().require('JWT_REFRESH_SECRET');
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: 'admin' | 'user';
  mustResetPassword: boolean;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

export function signAccessToken(payload: AccessTokenPayload, expiresIn?: string): string {
  return jwt.sign(payload, accessSecret(), { expiresIn: expiresIn ?? accessTtl() } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, accessSecret()) as AccessTokenPayload;
}

export function createRefreshToken(userId: string): {
  token: string;
  jti: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const jti = randomBytes(16).toString('hex');
  const payload: RefreshTokenPayload = { sub: userId, jti };
  const token = jwt.sign(payload, refreshSecret(), { expiresIn: refreshTtl() } as SignOptions);
  const decoded = jwt.decode(token) as { exp: number };
  return {
    token,
    jti,
    tokenHash: hashToken(token),
    expiresAt: new Date(decoded.exp * 1000),
  };
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, refreshSecret()) as RefreshTokenPayload;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
