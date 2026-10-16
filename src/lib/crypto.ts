import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
  scrypt as scryptCallback,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

/**
 * AES-256-GCM encryption for integration credentials at rest.
 * Key comes from ENCRYPTION_KEY (base64, 32 bytes) with a version marker
 * (ENCRYPTION_KEY_VERSION) so keys can be rotated.
 */

const FALLBACK_KEY_VERSION = 1;

function getKey(version = FALLBACK_KEY_VERSION): Buffer {
  const envName = version === FALLBACK_KEY_VERSION ? "ENCRYPTION_KEY" : `ENCRYPTION_KEY_V${version}`;
  const secret = process.env[envName];
  if (!secret) {
    throw new Error(
      `${envName} is not configured. Set a 32-byte base64 key in the environment (see .env.example).`
    );
  }
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) {
    throw new Error(`${envName} must decode to exactly 32 bytes.`);
  }
  return key;
}

export function currentKeyVersion(): number {
  const v = Number(process.env.ENCRYPTION_KEY_VERSION ?? FALLBACK_KEY_VERSION);
  return Number.isInteger(v) && v > 0 ? v : FALLBACK_KEY_VERSION;
}

export function encryptSecret(plaintext: string): { cipher: string; keyVersion: number } {
  const keyVersion = currentKeyVersion();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(keyVersion), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: Buffer.concat([iv, tag, data]).toString("base64"),
    keyVersion,
  };
}

export function decryptSecret(cipherB64: string, keyVersion = FALLBACK_KEY_VERSION): string {
  const raw = Buffer.from(cipherB64, "base64");
  if (raw.length < 28) throw new Error("Invalid ciphertext.");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(keyVersion), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function last4(value: string): string {
  return value.slice(-4);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---- Password hashing (scrypt from node:crypto; no native deps) ----

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

// Async on purpose: scrypt allocates ~16 MB and blocks for tens of
// milliseconds; running it synchronously on unauthenticated server actions
// (register, reset) would stall the single event loop per request.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  if (!/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p)) return false;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  // The parameters come from the stored string, so bound them before handing
  // them to scrypt: reject anything that isn't a plausible honest hash
  // (hashPassword writes N=16384, r=8, p=1) instead of crashing on invalid
  // values or burning CPU/memory on oversized ones.
  const N_isPow2 = N >= 2 ** 10 && N <= 2 ** 22 && (N & (N - 1)) === 0;
  if (!N_isPow2 || R < 1 || R > 64 || P < 1 || P > 8) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
  try {
    const actual = await scrypt(password, salt, expected.length, { N, r: R, p: P });
    return safeEqual(actual.toString("hex"), expected.toString("hex"));
  } catch {
    return false;
  }
}

export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must include upper case, lower case, and a digit.";
  }
  const common = ["password", "12345678", "qwerty", "letmein", "welcome"];
  if (common.some((c) => password.toLowerCase().includes(c))) {
    return "Password looks too common. Choose a stronger one.";
  }
  return null;
}
