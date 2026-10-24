import { addressToMailbox, localPartFromAuthUser } from "../helpers/index.js";
import { request } from "undici";
import type { Email } from "postal-mime";

export const SENDGRID_API_KEY_REGEX = /^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const SENDGRID_USERNAME_REGEX = /^sendgrid(?:-eu)?$/i;

type Mailbox = { email: string; name?: string };

export function isSendGridProvider(usernameLocalPart: string, apiToken: string): boolean {
  return SENDGRID_USERNAME_REGEX.test(usernameLocalPart) || SENDGRID_API_KEY_REGEX.test(apiToken);
}

export function getSendGridHost(authUser: string): string {
  const usernameLocalPart = localPartFromAuthUser(authUser);
  if (/^sendgrid-eu$/i.test(usernameLocalPart)) return "api.eu.sendgrid.com";
  if (/^sendgrid$/i.test(usernameLocalPart)) return "api.sendgrid.com";
  return process.env.SENDGRID_EU === "1" ? "api.eu.sendgrid.com" : "api.sendgrid.com";
}

export async function sendViaSendGrid(parsed: Email, authUser: string, token: string) {
  const host = getSendGridHost(authUser);
  const url = `https://${host}/v3/mail/send`;

  const fromMailbox = parsed.from && addressToMailbox(parsed.from);
  if (!fromMailbox) throw new Error("SendGrid requires From");

  // SendGrid rejects a personalization that lists the same address more than once across to/cc/bcc.
  const seen = new Set<string>();
  const unique = (mailbox: Mailbox | null): mailbox is Mailbox => {
    if (!mailbox) return false;
    const key = mailbox.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const toList = (parsed.to ?? []).map(addressToMailbox).filter(unique);
  const ccList = (parsed.cc ?? []).map(addressToMailbox).filter(unique);
  const bccList = (parsed.bcc ?? []).map(addressToMailbox).filter(unique);

  if (toList.length === 0) throw new Error("SendGrid requires at least one To");

  const text = parsed.text ?? undefined;
  const html = parsed.html ?? undefined;
  if (!text && !html) throw new Error("SendGrid requires a text or HTML body");

  const personalization: any = { to: toList };
  if (ccList.length) personalization.cc = ccList;
  if (bccList.length) personalization.bcc = bccList;

  // SendGrid requires text/plain to come before text/html in the content array.
  const content: { type: string; value: string }[] = [];
  if (text) content.push({ type: "text/plain", value: text });
  if (html) content.push({ type: "text/html", value: html });

  const payload: any = {
    personalizations: [personalization],
    from: fromMailbox,
    // SendGrid rejects an empty subject unless a template supplies one.
    subject: parsed.subject || "(no subject)",
    content,
  };

  const replyTo = parsed.replyTo?.map(addressToMailbox).find((x): x is Mailbox => x != null);
  if (replyTo) payload.reply_to = replyTo;

  const res = await request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`SendGrid HTTP ${res.statusCode}: ${body}`);
  }

  // SendGrid returns 202 with an empty body; the message id is in the X-Message-Id header.
  const messageId = res.headers["x-message-id"];
  return { status: res.statusCode, body, messageId: Array.isArray(messageId) ? messageId[0] : messageId };
}
