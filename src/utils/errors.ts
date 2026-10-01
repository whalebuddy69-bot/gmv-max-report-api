export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "NOT_FOUND", 404, details);
  }
}

export class TokenExpiredError extends AppError {
  constructor(advertiserId: string, apiMessage?: string) {
    super(
      `Access token ของ advertiser ${advertiserId} ใช้ไม่ได้แล้ว (หมดอายุหรือถูกเพิกถอน), ` +
        `ต้อง re-authorize ก่อนแล้วค่อยสั่งรายงานใหม่ (ปุ่ม "ขอสิทธิ์ร้านนี้" บนเว็บ หรือ /authorize ผ่าน gmv-max-telegram-bot)` +
        (apiMessage ? ` [TikTok: ${apiMessage}]` : ""),
      "TIKTOK_TOKEN_EXPIRED",
      401,
      { advertiserId }
    );
  }
}

export class TikTokApiError extends AppError {
  constructor(
    readonly endpoint: string,
    readonly apiCode: number,
    apiMessage: string,
    readonly requestId?: string
  ) {
    super(`TikTok API ${endpoint} ตอบกลับ code=${apiCode}: ${apiMessage}`, "TIKTOK_API_ERROR", 502, {
      endpoint,
      apiCode,
      requestId,
    });
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}
