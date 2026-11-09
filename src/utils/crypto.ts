import { createCipheriv, createDecipheriv, randomBytes, scrypt, scryptSync } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;

// Must match the salt used by gmv-max-telegram-bot, otherwise existing tokens cannot be decrypted.
const KEY_SALT = "gmv-max-telegram-bot";

function getKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. It must be the same value as in gmv-max-telegram-bot's .env"
    );
  }
  return scryptSync(secret, KEY_SALT, 32);
}

/** Output format: "<iv>:<authTag>:<ciphertext>", base64. Same as the bot. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(encoded: string): string {
  return decryptWithKey(encoded, getKey());
}

function decryptWithKey(encoded: string, key: Buffer): string {
  const [ivB64, authTagB64, ciphertextB64] = encoded.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted secret");
  }

  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Resolve one asynchronously derived key for a bounded batch, without blocking the Auto loop. */
export async function decryptSecretBatch(values: readonly string[]): Promise<(string | null)[]> {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY_REQUIRED");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(secret, KEY_SALT, 32, (error, value) => error ? reject(error) : resolve(value));
  });
  try { return values.map(value => { try { return decryptWithKey(value, key); } catch { return null; } }); }
  finally { key.fill(0); }
}
