import { Router } from "express";
import { z } from "zod";
import { changeOwnPassword, findUser, login, toPublicUser } from "../services/auth.service";
import { requireAuth } from "../middleware/auth";
import { NotFoundError, ValidationError } from "../utils/errors";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

/** POST /auth/login → { token, expiresIn, user } */
authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("ต้องส่ง email และ password");
    }
    res.json(await login(parsed.data.email, parsed.data.password));
  } catch (err) {
    next(err);
  }
});

/** GET /auth/me: lets the frontend restore a session on refresh. */
authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await findUser(req.user!.sub);
    if (!user || !user.isActive) throw new NotFoundError("ไม่พบผู้ใช้");
    res.json(toPublicUser(user));
  } catch (err) {
    next(err);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

/** POST /auth/change-password: invalidates all of the user's tokens, including this one. */
authRouter.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("ต้องส่ง currentPassword และ newPassword");
    }

    await changeOwnPassword(
      req.user!.sub,
      parsed.data.currentPassword,
      parsed.data.newPassword
    );

    res.json({
      ok: true,
      message: "เปลี่ยนรหัสผ่านแล้ว, token เดิมใช้ไม่ได้อีก กรุณาเข้าสู่ระบบใหม่",
      reloginRequired: true,
    });
  } catch (err) {
    next(err);
  }
});
