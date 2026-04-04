import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ZyntraClient } from "zyntramail-api";

type ProviderName = "mailgun" | "postmark" | "mailersend";

type ProviderConfig = {
  name: ProviderName;
  username: string;
  apiKey: string;
};

type ProviderCase = {
  label: "username-match" | "api-key-match";
  username: string;
};

type TestResult = {
  provider: ProviderName;
  label: ProviderCase["label"];
  success: boolean;
  message: string;
  durationMs: number;
};

type ZyntraEmail = {
  subject?: string;
  body?: string;
  html?: string;
  textAsHtml?: string;
  to?: string | string[] | Array<{ email?: string; address?: string }>;
};

type ZyntraEmailPreview = {
  uuid: string;
  subject: string;
};

const SMTP_HOST = mustEnv("SMTP_HOST");
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "2525");
mustEnv("ZYNTRA_API_KEY");
const ZYNTRA_TEAM_ID = mustEnv("ZYNTRA_TEAM_ID");
const ZYNTRA_WAIT_TIMEOUT_MS = Number(process.env.ZYNTRA_WAIT_TIMEOUT_MS ?? "30000");
const ZYNTRA_INITIAL_DELAY_MS = Number(process.env.ZYNTRA_INITIAL_DELAY_MS ?? "2000");
const ZYNTRA_RETRY_DELAY_MS = Number(process.env.ZYNTRA_RETRY_DELAY_MS ?? "5000");
const TEST_SUMMARY_FILE = process.env.TEST_SUMMARY_FILE;

const zyntra = new ZyntraClient();

const providers: ProviderConfig[] = [
  {
    name: "mailgun",
    username: mustEnv("TEST_MAILGUN_USERNAME"),
    apiKey: mustEnv("TEST_MAILGUN_API_KEY"),
  },
  {
    name: "postmark",
    username: mustEnv("TEST_POSTMARK_USERNAME"),
    apiKey: mustEnv("TEST_POSTMARK_API_KEY"),
  },
  {
    name: "mailersend",
    username: mustEnv("TEST_MAILERSEND_USERNAME"),
    apiKey: mustEnv("TEST_MAILERSEND_API_KEY"),
  },
];

async function main() {
  const results: TestResult[] = [];

  for (const provider of providers) {
    for (const testCase of providerCases(provider)) {
      results.push(await runCase(provider, testCase));
    }
  }

  const summary = renderSummary(results);
  console.log("");
  console.log(summary.console);

  if (TEST_SUMMARY_FILE) {
    await writeFile(TEST_SUMMARY_FILE, summary.markdown, "utf8");
  }

  if (results.some((result) => !result.success)) {
    process.exitCode = 1;
  }
}

async function runCase(provider: ProviderConfig, testCase: ProviderCase): Promise<TestResult> {
  const startedAt = Date.now();
  const testId = `${provider.name}-${testCase.label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const to = `${ZYNTRA_TEAM_ID}.minimailer@zyntramail.com`;
  const from = fromAddressFor(provider, testCase.username);
  const subject = `[MiniMailer E2E] ${provider.name} ${testCase.label} ${testId}`;
  const body = `MiniMailer E2E ${provider.name} ${testCase.label} ${testId}`;
  const prefix = `${provider.name}/${testCase.label}`;

  console.log(`${color("cyan")}Running${color("reset")} ${prefix}`);

  try {
    await sendSmtpMessage({
      host: SMTP_HOST,
      port: SMTP_PORT,
      username: testCase.username,
      password: provider.apiKey,
      from,
      to,
      subject,
      body,
    });

    const email = await getLastEmailWithTimeout(to, subject, ZYNTRA_WAIT_TIMEOUT_MS);

    assert(
      email.subject === subject,
      `${prefix}: expected subject "${subject}", got "${email.subject ?? ""}"`
    );
    assert(
      emailBodyIncludes(email, body),
      `${prefix}: expected body to include "${body}"`
    );
    assert(
      recipientIncludes(email.to, to),
      `${prefix}: expected recipient "${to}" not found`
    );

    const durationMs = Date.now() - startedAt;
    console.log(`${color("green")}PASS${color("reset")} ${prefix} (${durationMs}ms)`);
    return { provider: provider.name, label: testCase.label, success: true, message: "ok", durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = String((error as { message?: string } | undefined)?.message ?? error);
    console.log(`${color("red")}FAIL${color("reset")} ${prefix} (${durationMs}ms)`);
    console.log(`${color("red")}${message}${color("reset")}`);
    return { provider: provider.name, label: testCase.label, success: false, message, durationMs };
  }
}

function providerCases(provider: ProviderConfig): ProviderCase[] {
  return [
    { label: "username-match", username: provider.username },
    { label: "api-key-match", username: neutralUsername(provider.username) },
  ];
}

function neutralUsername(username: string): string {
  if (!username.includes("@")) return "relay";
  const [, domain] = username.split("@", 2);
  return `relay@${domain}`;
}

function fromAddressFor(provider: ProviderConfig, username: string): string {
  if (provider.name === "mailgun") {
    return username.includes("@") ? username : `mailgun@${username}`;
  }
  return mustEnv(`TEST_${provider.name.toUpperCase()}_FROM`);
}

async function getLastEmailWithTimeout(inbox: string, expectedSubject: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: unknown;

  await sleep(ZYNTRA_INITIAL_DELAY_MS);

  while (Date.now() < deadline) {
    attempt += 1;

    try {
      return await getMatchingEmail(inbox, expectedSubject);
    } catch (error) {
      lastError = error;

      if (!isRetryableZyntraError(error)) {
        throw error;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      const delayMs = Math.min(ZYNTRA_RETRY_DELAY_MS, remainingMs);
      console.log(
        `Zyntra email not ready for "${expectedSubject}" on attempt ${attempt}; retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(
    `Timed out waiting for Zyntra email after ${timeoutMs}ms${formatErrorSuffix(lastError)}`
  );
}

async function getMatchingEmail(inbox: string, expectedSubject: string) {
  const previews = (await debugZyntraCall("getEmails", { inbox, expectedSubject }, () =>
    zyntra.getEmails(inbox)
  )) as ZyntraEmailPreview[];
  const preview = previews[0];

  if (!preview) {
    throw new Error(`No email found yet for inbox "${inbox}"`);
  }

  const email = (await debugZyntraCall(
    "getEmailById",
    { inbox, expectedSubject, messageUuid: preview.uuid, previewSubject: preview.subject },
    () => zyntra.getEmailById(preview.uuid)
  )) as ZyntraEmail;

  try {
    if (preview.subject !== expectedSubject) {
      throw new Error(`Fetched different email subject "${preview.subject}" while waiting for "${expectedSubject}"`);
    }

    return email;
  } finally {
    await debugZyntraCall(
      "deleteEmail",
      { inbox, expectedSubject, messageUuid: preview.uuid, previewSubject: preview.subject },
      () => zyntra.deleteEmail(preview.uuid)
    );
  }
}

function isRetryableZyntraError(error: unknown) {
  const message = String((error as { message?: string } | undefined)?.message ?? error).toLowerCase();
  return (
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("no email") ||
    message.includes("different email subject")
  );
}

function formatErrorSuffix(error: unknown) {
  if (error == null) return "";
  return `; last error: ${String((error as { message?: string } | undefined)?.message ?? error)}`;
}

async function debugZyntraCall<T>(
  operation: string,
  context: Record<string, string>,
  fn: () => Promise<T>
) {
  try {
    return await fn();
  } catch (error) {
    const errorMessage = String((error as { message?: string; stack?: string } | undefined)?.message ?? error);
    const contextText = Object.entries({
      teamId: ZYNTRA_TEAM_ID,
      ...context,
    })
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    console.log(`${color("yellow")}ZYNTRA DEBUG${color("reset")} ${operation} failed ${contextText}`);
    console.log(`${color("yellow")}ZYNTRA DEBUG${color("reset")} error=${errorMessage}`);
    throw new Error(`[${operation}] ${errorMessage}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recipientIncludes(recipients: ZyntraEmail["to"], expected: string) {
  if (!recipients) return false;

  const recipientList = Array.isArray(recipients) ? recipients : recipients.split(",").map((value) => value.trim());

  return recipientList.some((recipient) => {
    if (typeof recipient === "string") return recipient.toLowerCase() === expected.toLowerCase();
    return (recipient.email ?? recipient.address ?? "").toLowerCase() === expected.toLowerCase();
  });
}

function emailBodyIncludes(email: ZyntraEmail, expected: string) {
  return [email.body, email.html, email.textAsHtml].some((value) => value?.includes(expected));
}

function renderSummary(results: TestResult[]) {
  const passed = results.filter((result) => result.success);
  const failed = results.filter((result) => !result.success);
  const lines = [
    `${color(failed.length === 0 ? "green" : "red")}Summary${color("reset")} ${passed.length}/${results.length} passed`,
    ...results.map((result) => {
      const status = result.success ? `${color("green")}PASS${color("reset")}` : `${color("red")}FAIL${color("reset")}`;
      return `${status} ${result.provider}/${result.label} (${result.durationMs}ms)${result.success ? "" : ` - ${result.message}`}`;
    }),
  ];

  const markdown = [
    "## Mini Mailer E2E Summary",
    "",
    `Passed ${passed.length}/${results.length}`,
    "",
    ...results.map((result) => `- ${result.success ? "PASS" : "FAIL"} \`${result.provider}/${result.label}\` (${result.durationMs}ms)${result.success ? "" : ` - ${result.message}`}`),
  ].join("\n");

  return { console: lines.join("\n"), markdown };
}

function color(name: "reset" | "red" | "green" | "cyan" | "yellow") {
  const codes = {
    reset: "\u001b[0m",
    red: "\u001b[31m",
    green: "\u001b[32m",
    cyan: "\u001b[36m",
    yellow: "\u001b[33m",
  };
  return codes[name];
}

async function sendSmtpMessage(input: {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  to: string;
  subject: string;
  body: string;
}) {
  const socket = new Socket();
  const lines: string[] = [];

  socket.setEncoding("utf8");

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(input.port, input.host, () => resolve());
  });

  try {
    await readResponse(socket, lines);
    await sendCommand(socket, "EHLO localhost", lines);

    const authPayload = Buffer.from(`\u0000${input.username}\u0000${input.password}`).toString("base64");
    await sendCommand(socket, `AUTH PLAIN ${authPayload}`, lines, 235);
    await sendCommand(socket, `MAIL FROM:<${input.from}>`, lines);
    await sendCommand(socket, `RCPT TO:<${input.to}>`, lines);
    await sendCommand(socket, "DATA", lines, 354);

    const message = [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      input.body,
      ".",
    ].join("\r\n");

    socket.write(`${message}\r\n`);
    const dataResponse = await readResponse(socket, lines);
    assert(dataResponse.startsWith("250 "), `SMTP DATA failed: ${dataResponse}`);
    await sendCommand(socket, "QUIT", lines, 221);
  } finally {
    socket.destroy();
  }
}

async function sendCommand(socket: Socket, command: string, lines: string[], expectedCode = 250) {
  socket.write(`${command}\r\n`);
  const response = await readResponse(socket, lines);
  const code = parseInt(response.slice(0, 3), 10);
  assert(code === expectedCode, `SMTP command failed for "${command}": ${response}`);
}

async function readResponse(socket: Socket, lines: string[]) {
  while (true) {
    const line = await readLine(socket, lines);
    if (/^\d{3} /.test(line)) return line;
  }
}

async function readLine(socket: Socket, lines: string[]) {
  if (lines.length > 0) return lines.shift()!;

  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: string) => {
      const normalized = chunk.replace(/\r/g, "");
      lines.push(...normalized.split("\n").filter(Boolean));
      cleanup();
      resolve(lines.shift()!);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("SMTP socket closed unexpectedly"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function mustEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
