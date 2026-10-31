// Small crypto and id helpers (Web Crypto only, no Node APIs).
export const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64decode(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lowercase UUIDv7: 48-bit millisecond timestamp, then random bits. Passes the template's UUID_PATTERN. */
export function uuidv7(nowMs: number, rnd: Uint8Array = randomBytes(10)): string {
  const ts = Math.floor(nowMs).toString(16).padStart(12, "0").slice(-12);
  const r = Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("");
  const variant = ((parseInt(r.slice(4, 6), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${r.slice(0, 3)}-${variant}${r.slice(6, 8)}-${r.slice(8, 20)}`;
}

/** Creation time (ms since epoch) encoded in a UUIDv7, or null when the id is not one. */
export function uuidv7Time(id: string): number | null {
  if (!UUID_V7.test(id)) return null;
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
