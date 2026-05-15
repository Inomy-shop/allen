import { ObjectId, type Collection, type Db } from 'mongodb';
import { hashPassword } from '../auth/password.js';

export type UserRole = 'admin' | 'user';

export interface UserDoc {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  mustResetPassword: boolean;
  createdBy: ObjectId | 'system';
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  mustResetPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export function toPublicUser(u: UserDoc): PublicUser {
  return {
    id: u._id.toHexString(),
    email: u.email,
    name: u.name,
    role: u.role,
    mustResetPassword: u.mustResetPassword,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  };
}

export class UserService {
  private col: Collection<UserDoc>;

  constructor(db: Db) {
    this.col = db.collection<UserDoc>('users');
  }

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.col.findOne({ email: email.toLowerCase() });
  }

  async findById(id: string): Promise<UserDoc | null> {
    if (!ObjectId.isValid(id)) return null;
    return this.col.findOne({ _id: new ObjectId(id) });
  }

  async list(): Promise<UserDoc[]> {
    return this.col.find({}, { sort: { createdAt: -1 } }).toArray();
  }

  async countUsers(): Promise<number> {
    return this.col.countDocuments({});
  }

  async createUser(params: {
    email: string;
    name: string;
    plainPassword: string;
    role: UserRole;
    mustResetPassword: boolean;
    createdBy: ObjectId | 'system';
  }): Promise<UserDoc> {
    const email = params.email.toLowerCase().trim();
    const existing = await this.col.findOne({ email });
    if (existing) {
      throw Object.assign(new Error('User with this email already exists'), { status: 409 });
    }
    const now = new Date();
    const doc: UserDoc = {
      _id: new ObjectId(),
      email,
      passwordHash: await hashPassword(params.plainPassword),
      name: params.name.trim(),
      role: params.role,
      mustResetPassword: params.mustResetPassword,
      createdBy: params.createdBy,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    await this.col.insertOne(doc);
    return doc;
  }

  async updatePassword(userId: ObjectId, newPasswordPlain: string): Promise<void> {
    await this.col.updateOne(
      { _id: userId },
      {
        $set: {
          passwordHash: await hashPassword(newPasswordPlain),
          mustResetPassword: false,
          updatedAt: new Date(),
        },
      },
    );
  }

  async updateProfile(userId: ObjectId, patch: { name?: string; role?: UserRole }): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.role !== undefined) set.role = patch.role;
    await this.col.updateOne({ _id: userId }, { $set: set });
  }

  async touchLastLogin(userId: ObjectId): Promise<void> {
    await this.col.updateOne({ _id: userId }, { $set: { lastLoginAt: new Date() } });
  }

  async delete(userId: ObjectId): Promise<void> {
    await this.col.deleteOne({ _id: userId });
  }

  async resetToTempPassword(userId: ObjectId, tempPlainPassword: string): Promise<void> {
    await this.col.updateOne(
      { _id: userId },
      {
        $set: {
          passwordHash: await hashPassword(tempPlainPassword),
          mustResetPassword: true,
          updatedAt: new Date(),
        },
      },
    );
  }

  async countAdmins(): Promise<number> {
    return this.col.countDocuments({ role: 'admin' });
  }
}
