import { addressToMailbox } from "../helpers/index.js";
import PostalMime from "postal-mime";
import { request } from "undici";

export async function sendViaMailerSend(rawMime: Buffer, token: string) {
  const url = "https://api.mailersend.com/v1/email";

  const parsed = await PostalMime.parse(rawMime);

  const fromMailbox = parsed.from && addressToMailbox(parsed.from);
  if (!fromMailbox) throw new Error("MailerSend requires From");

  const toList = (parsed.to ?? []).map(addressToMailbox).filter((x): x is { email: string; name?: string } => x != null);
  const ccList = (parsed.cc ?? []).map(addressToMailbox).filter((x): x is { email: string; name?: string } => x != null);
  const bccList = (parsed.bcc ?? []).map(addressToMailbox).filter((x): x is { email: string; name?: string } => x != null);

  if (toList.length === 0) throw new Error("MailerSend requires at least one To");

  const subject = parsed.subject ?? "";
  const html = parsed.html ?? undefined;
  const text = parsed.text ?? undefined;

  const payload: any = {
    from: fromMailbox,
    to: toList,
    subject,
  };

  if (ccList.length) payload.cc = ccList;
  if (bccList.length) payload.bcc = bccList;
  if (html) payload.html = html;
  if (text) payload.text = text;

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
    throw new Error(`MailerSend HTTP ${res.statusCode}: ${body}`);
  }

  return { status: res.statusCode, body };
}
