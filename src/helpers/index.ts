import pino from "pino";
import type { Address } from "postal-mime";

export const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

export function addressToMailbox(addr: Address): { email: string; name?: string } | null {
  if ("address" in addr && addr.address) return { email: addr.address, name: addr.name || undefined };
  return null;
}

export function formatAddressList(addrs: Address[] | undefined): string {
  if (!addrs?.length) return "";
  return addrs.map(formatAddress).filter(Boolean).join(", ");
}

export function formatAddress(addr: Address | undefined): string {
  if (!addr) return "";
  if ("address" in addr && addr.address) return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
  if ("group" in addr && addr.group) return addr.group.map(m => m.name ? `${m.name} <${m.address}>` : m.address).join(", ");
  return "";
}

export function smtpError(code: number, message: string) {
  const err: any = new Error(message);
  err.responseCode = code;
  return err;
}

export function domainFromAuthUser(authUser: string): string {
  const u = authUser.trim();
  return u.includes("@") ? u.split("@").pop()! : u;
}
