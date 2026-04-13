import { ObjectId, type Collection, type Db } from 'mongodb';
import { hashToken } from '../auth/jwt.js';

export interface RefreshTokenDoc {
  _id: ObjectId;
  userId: ObjectId;
  jti: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  userAgent: string;
}

export class RefreshTokenService {
  private col: Collection<RefreshTokenDoc>;

  constructor(db: Db) {
    this.col = db.collection<RefreshTokenDoc>('refresh_tokens');
  }

  async store(params: {
    userId: ObjectId;
    jti: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string;
  }): Promise<void> {
    await this.col.insertOne({
      _id: new ObjectId(),
      userId: params.userId,
      jti: params.jti,
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
      userAgent: params.userAgent,
    });
  }

  async findValidByToken(rawToken: string): Promise<RefreshTokenDoc | null> {
    const tokenHash = hashToken(rawToken);
    return this.col.findOne({ tokenHash });
  }

  async revokeByJti(jti: string): Promise<void> {
    await this.col.updateOne({ jti }, { $set: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: ObjectId): Promise<void> {
    await this.col.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }
}
