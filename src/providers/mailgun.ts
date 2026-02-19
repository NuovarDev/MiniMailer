import FormData from "form-data";
import { formatAddressList, log, domainFromAuthUser } from "../helpers/index.js";
import { request } from "undici";
import type { Email } from "postal-mime";

export async function sendViaMailgun(rawMime: Buffer, parsed: Email, authUser: string, key: string) {
  const domain = domainFromAuthUser(authUser);
  log.info({ domain, authUser }, "Sending email via Mailgun");

  const url = `https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages.mime`;

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
