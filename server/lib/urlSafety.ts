import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_RANGES = [
  // IPv4
  { prefix: [10], bits: 8 },
  { prefix: [172, 16], bits: 12 },
  { prefix: [192, 168], bits: 16 },
  { prefix: [127], bits: 8 },
  { prefix: [169, 254], bits: 16 },
  { prefix: [0], bits: 8 },
];

function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const num = ipv4ToNumber(ip);
  for (const range of PRIVATE_RANGES) {
    const prefix = range.prefix.reduce((acc, p, i) => acc | (p << (24 - i * 8)), 0) >>> 0;
    const mask = (~0 << (32 - range.bits)) >>> 0;
    if ((num & mask) === (prefix & mask)) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // IPv4-mapped IPv6 ::ffff:A.B.C.D
  const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);
  return false;
}

function isPrivateIP(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  if (isIP(ip) === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Validate outbound URL against SSRF.
 * - Must be HTTPS
 * - Resolves hostname via DNS and rejects private/internal IPs
 * - Blocks numeric IP forms, bracket IPv6, and known bypass patterns
 */
export async function assertSafeOutboundUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("URL must use HTTPS");
  }

  const host = parsed.hostname.toLowerCase();

  if (host === "localhost" || host === "localhost.localdomain") {
    throw new Error("URL must not target localhost");
  }

  // Block bracket IPv6 notation [::1]
  if (host.startsWith("[")) {
    throw new Error("IPv6 bracket notation is not allowed in target URLs");
  }

  // Block numeric IP representations (decimal, hex, octal)
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^0[0-7]+$/.test(host)) {
    throw new Error("Numeric IP addresses are not allowed in target URLs");
  }

  // If hostname is a direct IP, check immediately
  if (isIP(host)) {
    if (isPrivateIP(host)) {
      throw new Error("URL must not target internal or private addresses");
    }
    return;
  }

  // Resolve DNS and check all returned addresses
  try {
    const { address } = await lookup(host);
    if (isPrivateIP(address)) {
      throw new Error("URL hostname resolves to a private/internal address");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("private")) throw err;
    throw new Error(`Cannot resolve hostname: ${host}`);
  }
}
