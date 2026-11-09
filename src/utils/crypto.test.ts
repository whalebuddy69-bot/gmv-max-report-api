import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, decryptSecretBatch, encryptSecret } from "./crypto";

describe("encryptSecret / decryptSecret round-trip", () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "vitest-only-key-not-a-real-secret";
  });

  it("decryptSecret(encryptSecret(x)) returns x unchanged", () => {
    const plaintext = "act.example_access_token_value_123";
    const encoded = encryptSecret(plaintext);

    // "<iv>:<authTag>:<ciphertext>", all base64.
    expect(encoded.split(":")).toHaveLength(3);

    expect(decryptSecret(encoded)).toBe(plaintext);
  });

  it("uses a fresh random IV each call, so two encryptions of the same text differ", () => {
    const a = encryptSecret("same-plaintext");
    const b = encryptSecret("same-plaintext");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-plaintext");
    expect(decryptSecret(b)).toBe("same-plaintext");
  });

  it("decrypts a read-only batch with the same key and rejects malformed entries individually", async () => {
    await expect(decryptSecretBatch([encryptSecret("one"), "invalid", encryptSecret("two")])).resolves.toEqual(["one", null, "two"]);
  });
});
