import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/dataSource";
import { User, UserRole } from "../entities/User";
import { requireAdmin, requireAuth } from "../middleware/auth";
import {
  assertPasswordPolicy,
  hashPassword,
  resetPassword,
  toPublicUser,
} from "../services/auth.service";
import { AppError, NotFoundError, ValidationError } from "../utils/errors";
import { logger } from "../utils/logger";

/**
 * Admin-only user management. An admin cannot demote or disable themselves, and the
 * last active admin cannot be demoted or disabled.
 */
export const usersRouter = Router();
usersRouter.use(requireAuth, requireAdmin);

function repo() {
  return AppDataSource.getRepository(User);
}

async function countOtherActiveAdmins(excludeId: number): Promise<number> {
  return repo()
    .createQueryBuilder("u")
    .where("u.role = :role", { role: "admin" })
    .andWhere("u.is_active = true")
    .andWhere("u.id != :id", { id: excludeId })
    .getCount();
}

async function assertNotLastAdmin(target: User, action: string): Promise<void> {
  if (target.role !== "admin" || !target.isActive) return;
  if ((await countOtherActiveAdmins(target.id)) === 0) {
    throw new AppError(
      `${action}ไม่ได้, นี่คือ admin ที่ใช้งานอยู่คนสุดท้าย ถ้าทำจะไม่มีใครเข้าระบบจัดการได้อีก`,
      "LAST_ADMIN",
      409
    );
  }
}

/** GET /users: everyone, newest last. Never includes passwordHash. */
usersRouter.get("/", async (_req, res, next) => {
  try {
    const users = await repo().find({ order: { id: "ASC" } });
    res.json({ users: users.map(toPublicUser) });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  email: z.string().email("อีเมลไม่ถูกต้อง"),
  password: z.string().min(1),
  name: z.string().min(1).optional(),
  role: z.enum(["viewer", "admin"]).optional(),
});

/** POST /users: the admin sets the new account's first password. */
usersRouter.post("/", async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("ข้อมูลไม่ถูกต้อง", { issues: parsed.error.issues });
    }
    const { email, password, name, role } = parsed.data;
    assertPasswordPolicy(password);

    const existing = await repo()
      .createQueryBuilder("u")
      .where("lower(u.email) = lower(:email)", { email })
      .getOne();
    if (existing) {
      throw new AppError("มีผู้ใช้อีเมลนี้อยู่แล้ว", "EMAIL_TAKEN", 409);
    }

    const user = await repo().save(
      repo().create({
        email,
        passwordHash: await hashPassword(password),
        name: name ?? null,
        role: (role as UserRole) ?? "viewer",
        isActive: true,
        passwordChangedAt: new Date(),
      })
    );

    logger.info("User created", { by: req.user!.sub, userId: user.id, role: user.role });
    res.status(201).json(toPublicUser(user));
  } catch (err) {
    next(err);
  }
});

const updateSchema = z
  .object({
    name: z.string().min(1).nullable().optional(),
    role: z.enum(["viewer", "admin"]).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "ต้องระบุอย่างน้อย 1 field" });

/** PATCH /users/:id: name / role / isActive. */
usersRouter.patch("/:id", async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("ข้อมูลไม่ถูกต้อง", { issues: parsed.error.issues });
    }

    const user = await repo().findOne({ where: { id: Number(req.params.id) } });
    if (!user) throw new NotFoundError(`ไม่พบผู้ใช้ id ${req.params.id}`);

    const { name, role, isActive } = parsed.data;
    const demoting = role !== undefined && role !== "admin" && user.role === "admin";
    const disabling = isActive === false && user.isActive;

    if ((demoting || disabling) && user.id === req.user!.sub) {
      throw new AppError(
        "เปลี่ยน role หรือปิดใช้งานบัญชีตัวเองไม่ได้, ให้ admin คนอื่นทำแทน",
        "SELF_LOCKOUT",
        409
      );
    }
    if (demoting) await assertNotLastAdmin(user, "ลด role");
    if (disabling) await assertNotLastAdmin(user, "ปิดใช้งาน");

    if (name !== undefined) user.name = name;
    if (role !== undefined) user.role = role as UserRole;
    if (isActive !== undefined) user.isActive = isActive;

    await repo().save(user);
    logger.info("User updated", { by: req.user!.sub, userId: user.id, name, role, isActive });
    res.json(toPublicUser(user));
  } catch (err) {
    next(err);
  }
});

const passwordSchema = z.object({ password: z.string().min(1) });

/** POST /users/:id/password: admin password reset; logs the user out everywhere. */
usersRouter.post("/:id/password", async (req, res, next) => {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("ต้องส่ง password");

    const id = Number(req.params.id);
    const user = await repo().findOne({ where: { id } });
    if (!user) throw new NotFoundError(`ไม่พบผู้ใช้ id ${id}`);

    await resetPassword(id, parsed.data.password);
    logger.info("Password reset", { by: req.user!.sub, userId: id });
    res.json({ ok: true, message: "รีเซ็ตรหัสผ่านแล้ว, session เดิมของผู้ใช้คนนี้ถูกยกเลิกทั้งหมด" });
  } catch (err) {
    next(err);
  }
});

/** DELETE /users/:id: soft delete. */
usersRouter.delete("/:id", async (req, res, next) => {
  try {
    const user = await repo().findOne({ where: { id: Number(req.params.id) } });
    if (!user) throw new NotFoundError(`ไม่พบผู้ใช้ id ${req.params.id}`);

    if (user.id === req.user!.sub) {
      throw new AppError("ปิดใช้งานบัญชีตัวเองไม่ได้", "SELF_LOCKOUT", 409);
    }
    await assertNotLastAdmin(user, "ปิดใช้งาน");

    user.isActive = false;
    await repo().save(user);
    logger.info("User deactivated", { by: req.user!.sub, userId: user.id });
    res.json({ ok: true, user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});
