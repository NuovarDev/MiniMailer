import "dotenv/config";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  MailSlurp,
  MatchOptionFieldEnum,
  MatchOptionShouldEnum,
  type Email,
  type InboxDto,
  type MatchOptions,
} from "mailslurp-client";

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

const SMTP_HOST = mustEnv("SMTP_HOST");
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "2525");
const MAILSLURP_API_KEY = mustEnv("MAILSLURP_API_KEY");
const MAILSLURP_WAIT_TIMEOUT_MS = Number(process.env.MAILSLURP_WAIT_TIMEOUT_MS ?? "60000");
const TEST_SUMMARY_FILE = process.env.TEST_SUMMARY_FILE;

const mailslurp = new MailSlurp({ apiKey: MAILSLURP_API_KEY });

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
  let inbox: InboxDto | undefined;

  try {
    inbox = await debugMailSlurpCall("createInbox", { scope: "suite" }, () => mailslurp.createInbox());

    for (const provider of providers) {
      for (const testCase of providerCases(provider)) {
        results.push(await runCase(provider, testCase, inbox));
      }
    }
  } finally {
    if (inbox?.id) {
      await cleanupMailSlurp("deleteInbox", { scope: "suite", inboxId: inbox.id }, () => mailslurp.deleteInbox(inbox!.id));
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

async function runCase(provider: ProviderConfig, testCase: ProviderCase, inbox: InboxDto): Promise<TestResult> {
  const startedAt = Date.now();
  const prefix = `${provider.name}/${testCase.label}`;
  const testId = `${provider.name}-${testCase.label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const subject = `[MiniMailer E2E] ${provider.name} ${testCase.label} ${testId}`;
  const body = `MiniMailer E2E ${provider.name} ${testCase.label} ${testId}`;
  let email: Email | undefined;

  console.log(`${color("cyan")}Running${color("reset")} ${prefix}`);

  try {
    const to = inbox.emailAddress;
    if (!to) throw new Error(`${prefix}: MailSlurp inbox missing email address`);

    await sendSmtpMessage({
      host: SMTP_HOST,
      port: SMTP_PORT,
      username: testCase.username,
      password: provider.apiKey,
      from: fromAddressFor(provider, testCase.username),
      to,
      subject,
      body,
    });

    email = await debugMailSlurpCall(
      "waitForMatchingFirstEmail",
      { prefix, inboxId: inbox.id, to, subject },
      () =>
        mailslurp.waitController.waitForMatchingFirstEmail({
          inboxId: inbox.id,
          timeout: MAILSLURP_WAIT_TIMEOUT_MS,
          unreadOnly: true,
          matchOptions: subjectMatchOptions(subject),
        })
    );

    assert(email.subject === subject, `${prefix}: expected subject "${subject}", got "${email.subject ?? ""}"`);
    assert((email.body ?? "").includes(body), `${prefix}: expected body to include "${body}"`);
    assert(email.to.some((recipient) => recipient.toLowerCase() === to.toLowerCase()), `${prefix}: expected recipient "${to}" not found`);

    const durationMs = Date.now() - startedAt;
    console.log(`${color("green")}PASS${color("reset")} ${prefix} (${durationMs}ms)`);
    return { provider: provider.name, label: testCase.label, success: true, message: "ok", durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = await formatMailSlurpError(error);
    console.log(`${color("red")}FAIL${color("reset")} ${prefix} (${durationMs}ms)`);
    console.log(`${color("red")}${message}${color("reset")}`);
    return { provider: provider.name, label: testCase.label, success: false, message, durationMs };
  } finally {
    if (email?.id) {
      await cleanupMailSlurp("deleteEmail", { prefix, emailId: email.id }, () => mailslurp.deleteEmail(email!.id));
    }
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

function subjectMatchOptions(subject: string): MatchOptions {
  return {
    matches: [
      {
        field: MatchOptionFieldEnum.SUBJECT,
        should: MatchOptionShouldEnum.EQUAL,
        value: subject,
      },
    ],
  };
}

async function debugMailSlurpCall<T>(
  operation: string,
  context: Record<string, string>,
  fn: () => Promise<T>
) {
  try {
    return await fn();
  } catch (error) {
    const message = await formatMailSlurpError(error);
    const contextText = Object.entries(context)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    console.log(`${color("yellow")}MAILSLURP DEBUG${color("reset")} ${operation} failed ${contextText}`);
    console.log(`${color("yellow")}MAILSLURP DEBUG${color("reset")} error=${message}`);
    throw new Error(`[${operation}] ${message}`);
  }
}

async function cleanupMailSlurp(
  operation: string,
  context: Record<string, string>,
  fn: () => Promise<void>
) {
  try {
    await fn();
  } catch (error) {
    const message = await formatMailSlurpError(error);
    const contextText = Object.entries(context)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    console.log(`${color("yellow")}MAILSLURP DEBUG${color("reset")} cleanup ${operation} failed ${contextText}`);
    console.log(`${color("yellow")}MAILSLURP DEBUG${color("reset")} error=${message}`);
  }
}

async function formatMailSlurpError(error: unknown) {
  const err = error as { message?: string; status?: number; text?: () => Promise<string> } | undefined;
  const message = String(err?.message ?? error);
  const status = typeof err?.status === "number" ? `status=${err.status} ` : "";
  const body = typeof err?.text === "function" ? await safeErrorBody(err.text) : "";
  return `${status}${message}${body ? ` body=${truncate(body, 1000)}` : ""}`;
}

async function safeErrorBody(textFn: () => Promise<string>) {
  try {
    return await textFn();
  } catch {
    return "";
  }
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

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...<truncated>`;
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
