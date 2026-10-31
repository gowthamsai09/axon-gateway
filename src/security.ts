// Detects secrets sent where they must not be (spec 7.6, 13.3 rule 6). Never echoes what it found.
const KEY_NAMES = new Set([
  "xllmkey", "llmkey", "apikey", "key", "secret", "apisecret", "token", "accesstoken",
  "authorization", "bearer", "password", "xapikey",
]);
const KEY_VALUE = /(?:\bsk-[A-Za-z0-9_-]{16,}|\bhf_[A-Za-z0-9]{16,}|\baxn_[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,})/;

export function detectKeyInBody(value: unknown): boolean {
  let nodes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (++nodes > 2000 || depth > 6) return false;
    if (typeof v === "string") return KEY_VALUE.test(v);
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    if (v !== null && typeof v === "object") {
      return Object.entries(v).some(
        ([k, x]) => KEY_NAMES.has(k.toLowerCase().replace(/[^a-z0-9]/g, "")) || walk(x, depth + 1),
      );
    }
    return false;
  };
  return walk(value, 0);
}
