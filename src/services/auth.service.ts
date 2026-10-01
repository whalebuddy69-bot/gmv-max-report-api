import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { AppDataSource } from "../db/dataSource";
import { User, UserRole } from "../entities/User";
import { config } from "../config";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";

const BCRYPT_ROUNDS = 12;

export class AuthError extends AppError {
  constructor(message: string) {
    super(message, "AUTH_FAILED", 401);
  }
}

export interface TokenPayload {
  sub: number;
  email: string;
  role: UserRole;
  /** Issued-at (seconds), set by jwt.sign. */
  iat?: number;
}

/** Shape returned to callers, never includes passwordHash. */
export interface PublicUser {
  id: number;
  email: string;
  name: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
  };
}

/** Shared rule so the CLI, admin reset, and self-service change all agree. */
export const MIN_PASSWORD_LENGTH = 10;

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(
      `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`,
      "WEAK_PASSWORD",
      400
    );
  }
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  user: { id: number; email: string; name: string | null; role: UserRole };
}

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const repo = AppDataSource.getRepository(User);
  // Case-insensitive lookup, matching the unique index on lower(email).
  const user = await repo
    .createQueryBuilder("u")
    .where("lower(u.email) = lower(:email)", { email })
    .getOne();

  // compare against a dummy hash so unknown emails take the same time
  const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok || !user.isActive) {
    // One message for every failure mode, never reveal which part was wrong.
    throw new AuthError("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
  }

  user.lastLoginAt = new Date();
  await repo.save(user);

  const payload: TokenPayload = { sub: user.id, email: user.email, role: user.role };
  const token = jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.auth.tokenTtlSeconds,
  });

  logger.info("Login succeeded", { userId: user.id, email: user.email });

  return {
    token,
    expiresIn: config.auth.tokenTtlSeconds,
    user: { id: user.id, email: user.email, name: user.name ?? null, role: user.role },
  };
}

export function verifyToken(token: string): TokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.auth.jwtSecret);
  } catch {
    throw new AuthError("token ไม่ถูกต้องหรือหมดอายุ");
  }

  const claims = decoded as Partial<TokenPayload>;
  if (typeof claims?.sub !== "number" || typeof claims.email !== "string" || !claims.role) {
    throw new AuthError("token ไม่ถูกต้องหรือหมดอายุ");
  }
  if (typeof claims.iat !== "number") {
    throw new AuthError("token ไม่ถูกต้องหรือหมดอายุ");
  }
  return { sub: claims.sub, email: claims.email, role: claims.role, iat: claims.iat };
}

export async function findUser(id: number): Promise<User | null> {
  return AppDataSource.getRepository(User).findOne({ where: { id } });
}

/** Rejects tokens for inactive users or issued before the last password change. */
export async function loadSessionUser(payload: TokenPayload): Promise<User> {
  const user = await findUser(payload.sub);
  if (!user || !user.isActive) {
    throw new AuthError("บัญชีนี้ถูกปิดใช้งานแล้ว");
  }

  // iat is in whole seconds
  const issuedAtMs = (payload.iat ?? 0) * 1000;
  if (issuedAtMs + 1000 < user.passwordChangedAt.getTime()) {
    throw new AuthError("รหัสผ่านถูกเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่");
  }

  return user;
}

/** Self-service change: proves ownership with the current password first. */
export async function changeOwnPassword(
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  assertPasswordPolicy(newPassword);

  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: userId } });
  if (!user || !user.isActive) throw new AuthError("ไม่พบผู้ใช้");

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AuthError("รหัสผ่านปัจจุบันไม่ถูกต้อง");
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new AppError("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม", "WEAK_PASSWORD", 400);
  }

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await repo.save(user);

  logger.info("Password changed by owner", { userId });
}

/** Admin reset, no current password, so it is admin-only at the route. */
export async function resetPassword(userId: number, newPassword: string): Promise<void> {
  assertPasswordPolicy(newPassword);

  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: userId } });
  if (!user) throw new AppError("ไม่พบผู้ใช้", "NOT_FOUND", 404);

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await repo.save(user);

  logger.info("Password reset by admin", { userId });
}
