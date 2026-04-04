import FormData from "form-data";
import { formatAddressList, domainFromAuthUser, localPartFromAuthUser } from "../helpers/index.js";
import { request } from "undici";
import type { Email } from "postal-mime";

export const MAILGUN_API_KEY_REGEX = /^[a-f0-9]{32}-[a-f0-9]{8}-[a-f0-9]{8}$/i;
export const MAILGUN_USERNAME_REGEX = /^mailgun(?:-eu)?$/i;

export function isMailgunProvider(usernameLocalPart: string, apiToken: string): boolean {
  return MAILGUN_USERNAME_REGEX.test(usernameLocalPart) || MAILGUN_API_KEY_REGEX.test(apiToken);
}

export function getMailgunHost(authUser: string): string {
  const usernameLocalPart = localPartFromAuthUser(authUser);
  if (/^mailgun-eu$/i.test(usernameLocalPart)) return "api.eu.mailgun.net";
  if (/^mailgun$/i.test(usernameLocalPart)) return "api.mailgun.net";
  return process.env.MAILGUN_EU === "1" ? "api.eu.mailgun.net" : "api.mailgun.net";
}

export async function sendViaMailgun(rawMime: Buffer, parsed: Email, authUser: string, key: string) {
  const domain = domainFromAuthUser(authUser);
  const host = getMailgunHost(authUser);
  const url = `https://${host}/v3/${encodeURIComponent(domain)}/messages.mime`;

  const to = formatAddressList(parsed.to).trim();
  if (!to) throw new Error("Could not determine 'To' header for Mailgun");

  const form = new FormData();
  form.append("to", to);
  form.append("message", rawMime, {
    filename: "message.eml",
    contentType: "message/rfc822",
  });

  const auth = Buffer.from(`api:${key}`).toString("base64");
  const headers = {
    ...form.getHeaders(),
    Authorization: `Basic ${auth}`,
  };

  const res = await request(url, {
    method: "POST",
    headers,
    body: form,
  });

  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Mailgun HTTP ${res.statusCode}: ${text}`);
  }

  return { status: res.statusCode, body: text };
}
