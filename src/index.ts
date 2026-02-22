import { createServer } from "node:http";
import { connect } from "node:net";
import { SMTPServer, SMTPServerOptions } from "smtp-server";
import PostalMime from "postal-mime";
import { formatAddress, formatAddressList, smtpError, log } from "./helpers/index.js";
import { sendViaPostmark } from "./providers/postmark.js";
import { sendViaMailerSend } from "./providers/mailersend.js";
import { sendViaMailgun } from "./providers/mailgun.js";

type Provider = "mailersend" | "postmark" | "mailgun";

function pickProvider(apiToken: string): Provider {
  const mailgunRex = new RegExp(`^[a-f0-9]{32}-[a-f0-9]{8}-[a-f0-9]{8}$`);
  const postmarkRex = new RegExp(`^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$`);
  if (apiToken.startsWith("mlsn.")) return "mailersend";
  if (postmarkRex.test(apiToken)) return "postmark";
  if (mailgunRex.test(apiToken)) return "mailgun";
  throw new Error("Invalid API token");
}

const LISTEN_HOST = process.env.LISTEN_HOST ?? "0.0.0.0";
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "80");
const SMTP_PORTS = [25, 2525, 587] as const;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(
      { host, port, timeout: HEALTH_CHECK_TIMEOUT_MS },
      () => {
        socket.destroy();
        resolve(true);
      }
    );
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const healthServer = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    const host = LISTEN_HOST === "0.0.0.0" ? "127.0.0.1" : LISTEN_HOST;
    const results = await Promise.all(
      SMTP_PORTS.map(async (port) => ({ port, up: await isPortOpen(host, port) }))
    );
    const smtp: Record<number, boolean> = {};
    let allUp = true;
    for (const { port, up } of results) {
      smtp[port] = up;
      if (!up) allUp = false;
    }
    const status = allUp ? "ok" : "degraded";
    const statusCode = allUp ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status, smtp }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const serverOptions = {
  banner: "Mini Mailer",
  allowInsecureAuth: true,
  ...(process.env.RAILWAY_PRIVATE_DOMAIN ? { name: process.env.RAILWAY_PRIVATE_DOMAIN } : {}),
  
  onAuth(auth, session, callback) {
    if (!auth.username || !auth.password) return callback(smtpError(535, "Authentication required"));

    return callback(null, { user: { username: auth.username, password: auth.password } });
  },

  // Capture the full message in a buffer
  async onData(stream, session, callback) {
    try {
      const sessionUser = session.user as { username?: string; password?: string } | string | undefined;
      const authUser =
        typeof sessionUser === "object" && sessionUser?.username != null
          ? sessionUser.username
          : typeof sessionUser === "string"
            ? sessionUser
            : "unknown";
      const apiToken = typeof sessionUser === "object" && sessionUser != null ? sessionUser.password : undefined;
      const provider = pickProvider(String(apiToken));

      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));

      stream.on("end", async () => {
        const rawMime = Buffer.concat(chunks);

        const parsed = await PostalMime.parse(rawMime);

        log.info(
          {
            port: session.localPort,
            provider,
            authUser,
            from: formatAddress(parsed.from),
            to: formatAddressList(parsed.to),
            subject: parsed.subject,
            size: rawMime.length,
          },
          "received message"
        );

        if (!apiToken) throw new Error("API token is required");

        // Route to provider (password is used as provider API token)
        try {
          let result: any;
          if (provider === "postmark") result = await sendViaPostmark(rawMime, apiToken);
          else if (provider === "mailersend") result = await sendViaMailerSend(rawMime, apiToken);
          else result = await sendViaMailgun(rawMime, parsed, authUser, apiToken);

          log.info({ provider, result, port: session.localPort }, "forwarded message");
          callback(); // 250 OK
        } catch (e: any) {
          log.error({ provider, err: String(e?.message ?? e), port: session.localPort }, "forward failed");

          // If provider is down / timeout / 5xx, prefer 451 (transient) so SMTP client retries
          // If provider rejects (4xx), can treat as permanent 550
          const msg = String(e?.message ?? e);
          const transient = msg.includes("HTTP 5") || msg.includes("ETIMEDOUT") || msg.includes("ECONN");
          callback(smtpError(transient ? 451 : 550, msg));
        }
      });
    } catch (e: any) {
      callback(smtpError(451, String(e?.message ?? e)));
    }
  },
} as SMTPServerOptions;

for (const port of SMTP_PORTS) {
  const server = new SMTPServer(serverOptions);
  server.listen(port, LISTEN_HOST, () => log.info({ host: LISTEN_HOST, port }, `Mini Mailer listening on SMTP port ${port}`));
  server.on("error", (err) => log.error({ err: err.message, port }, "SMTP error"));
}

healthServer.listen(HEALTH_PORT, LISTEN_HOST, () => log.info({ host: LISTEN_HOST, port: HEALTH_PORT }, "Health check HTTP server listening"));