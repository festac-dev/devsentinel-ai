import { describe, it, expect, beforeAll } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  passwordPolicyError,
  hashToken,
  safeEqual,
} from "@/lib/crypto";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.ENCRYPTION_KEY_VERSION = "1";
});

describe("AES-256-GCM credential encryption", () => {
  it("round-trips a secret", () => {
    const secret = "sk-test-abcdef123456";
    const { cipher, keyVersion } = encryptSecret(secret);
    expect(keyVersion).toBe(1);
    expect(decryptSecret(cipher, keyVersion)).toBe(secret);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a.cipher).not.toBe(b.cipher);
  });

  it("rejects tampered ciphertext", () => {
    const { cipher, keyVersion } = encryptSecret("secret");
    const raw = Buffer.from(cipher, "base64");
    raw[raw.length - 1]! ^= 0xff;
    expect(() => decryptSecret(raw.toString("base64"), keyVersion)).toThrow();
  });

  it("rejects the wrong key", () => {
    const { cipher, keyVersion } = encryptSecret("secret");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => decryptSecret(cipher, keyVersion)).toThrow();
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });
});

describe("password hashing", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const hash = await hashPassword("CorrectHorse1");
    expect(await verifyPassword("CorrectHorse1", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("CorrectHorse1", "garbage")).toBe(false);
  });

  it("salts: same password produces different hashes", async () => {
    expect(await hashPassword("CorrectHorse1")).not.toBe(await hashPassword("CorrectHorse1"));
  });

  it("rejects corrupt or hostile stored-hash parameters instead of crashing", async () => {
    const real = await hashPassword("CorrectHorse1");
    const [, , , , saltB64, hashB64] = real.split("$");
    const rewrite = (n: string, r: string, p: string) => `scrypt$${n}$${r}$${p}$${saltB64}$${hashB64}`;
    expect(await verifyPassword("CorrectHorse1", "scrypt$abc$8$1$bad$bad")).toBe(false);
    expect(await verifyPassword("CorrectHorse1", rewrite("99999999999999999999", "8", "1"))).toBe(false);
    expect(await verifyPassword("CorrectHorse1", rewrite("15", "8", "1"))).toBe(false); // not a power of two
    expect(await verifyPassword("CorrectHorse1", rewrite("16384", "8000000", "1"))).toBe(false);
    expect(await verifyPassword("CorrectHorse1", rewrite("16384", "8", "999999"))).toBe(false);
    expect(await verifyPassword("CorrectHorse1", real.replace(saltB64, Buffer.alloc(2).toString("base64")))).toBe(false);
    expect(await verifyPassword("CorrectHorse1", real.replace(hashB64, Buffer.alloc(1).toString("base64")))).toBe(false);
    expect(await verifyPassword("CorrectHorse1", rewrite("1048576", "64", "8"))).toBe(false); // oversized-but-valid → bounded out
    expect(await verifyPassword("CorrectHorse1", real)).toBe(true);
  });
});

describe("password policy", () => {
  it("enforces length and character classes", () => {
    expect(passwordPolicyError("short")).toBeTruthy();
    expect(passwordPolicyError("alllowercase1")).toBeTruthy();
    expect(passwordPolicyError("NOLOWERCASE1")).toBeTruthy();
    expect(passwordPolicyError("NoDigitsHere")).toBeTruthy();
    expect(passwordPolicyError("MyPassword1")).toBeTruthy(); // contains "password"
    expect(passwordPolicyError("Str0ngPassphrase")).toBeNull();
  });
});

describe("token helpers", () => {
  it("hashes tokens deterministically and compares safely", () => {
    const t = "abc123";
    expect(hashToken(t)).toBe(hashToken(t));
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});
