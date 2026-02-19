import { addressToMailbox } from "../helpers/index.js";
import PostalMime from "postal-mime";
import { request } from "undici";

export async function sendViaPostmark(rawMime: Buffer, token: string) {
  const url = "https://api.postmarkapp.com/email";

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
    From: fromMailbox.name ? `${fromMailbox.name} <${fromMailbox.email}>` : fromMailbox.email,
    To: toList.map(x => x.email).join(","),
    Subject: subject,
  };

  if (ccList.length) payload.Cc = ccList.map(x => x.email).join(",");
  if (bccList.length) payload.Bcc = bccList.map(x => x.email).join(",");
  if (html) payload.HtmlBody = html;
  if (text) payload.TextBody = text;

  const res = await request(url, {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Postmark HTTP ${res.statusCode}: ${body}`);
  }

  return { status: res.statusCode, body: body };
}
