/**
 * Password hashing with scrypt from node:crypto.
 *
 * Stored as `scrypt$N$r$p$salt$hash`, so the cost parameters travel with the
 * hash and can be raised later without locking anyone out.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must exceed 128 * N * r, which is 16 MiB at these parameters.
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: n, r, p, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const expectedKey = Buffer.from(expected, "base64");
  let key: Buffer;
  try {
    key = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  } catch {
    return false;
  }
  if (key.length !== expectedKey.length) return false;
  return timingSafeEqual(key, expectedKey);
}
