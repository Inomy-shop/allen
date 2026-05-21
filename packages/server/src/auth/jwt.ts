import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';

const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL ?? '1d';
const REFRESH_TTL = process.env.REFRESH_TOKEN_TTL ?? '7d';

function accessSecret(): string {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error('JWT_ACCESS_SECRET is not set');
  return s;
}

function refreshSecret(): string {
  const s = process.env.JWT_REFRESH_SECRET;
  if (!s) throw new Error('JWT_REFRESH_SECRET is not set');
  return s;
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
  return jwt.sign(payload, accessSecret(), { expiresIn: expiresIn ?? ACCESS_TTL } as SignOptions);
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
  const token = jwt.sign(payload, refreshSecret(), { expiresIn: REFRESH_TTL } as SignOptions);
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
