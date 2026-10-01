import { NextFunction, Request, Response } from "express";
import { AuthError, TokenPayload, loadSessionUser, verifyToken } from "../services/auth.service";
import { AppError } from "../utils/errors";
import { config } from "../config";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * JWT auth for the web app. Also checks the user row so deactivated accounts and
 * password resets take effect immediately.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new AuthError("ต้องส่ง Authorization: Bearer <token>");
    }

    const payload = verifyToken(token);
    const user = await loadSessionUser(payload);
    req.user = { ...payload, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    next(new AppError("ต้องเป็น admin เท่านั้น", "FORBIDDEN", 403));
    return;
  }
  next();
}

/**
 * For internal endpoints (/reports, /stores, /sync). Accepts x-api-key or a web JWT.
 * Open when INTERNAL_API_KEY is not set.
 */
export function requireInternalKey(req: Request, _res: Response, next: NextFunction): void {
  if (!config.auth.internalApiKey) {
    next();
    return;
  }

  const key = req.header("x-api-key");
  if (key && timingSafeEqual(key, config.auth.internalApiKey)) {
    next();
    return;
  }

  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() === "bearer" && token) {
    try {
      req.user = verifyToken(token);
      next();
      return;
    } catch {
    }
  }

  next(new AppError("ต้องส่ง x-api-key หรือ Authorization: Bearer <token>", "AUTH_FAILED", 401));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
