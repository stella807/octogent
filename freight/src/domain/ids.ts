import { randomUUID } from "node:crypto";

/** Prefixed ids keep foreign keys readable in the database and in logs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/** Human-facing shipment reference, e.g. "SHP-7Q4KD2". */
export function newReference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `SHP-${out}`;
}
