# Mini Mailer

Mini Mailer is a simple SMTP server that forwards mail over HTTP to Mailgun, Postmark, or MailerSend. For use as an SMTP gateway on platforms (e.g. [Railway](https://railway.app)) that restrict outbound SMTP ports.

Mini Mailer does not support attachments and is designed to run on an internal network only (e.g. `mini-mailer.railway.internal`), as it does not use TLS.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/mini-mailer?referralCode=EXiHsJ)

## What it does

- Listens for SMTP connections (e.g. on port **25**, **2525**, or **587**).
- Requires SMTP **username + password**.
- Uses the **username** first, then the **password**, to choose the provider.
- Forwards each message to the right provider over HTTPS.

## Port and connection

| Setting   | Default   | Env var      |
|----------|-----------|--------------|
| Host     | `0.0.0.0` | `LISTEN_HOST` |
| Health   | `80`    | `HEALTH_PORT` |

- Use **port 25**, **2525**, or **587** (or your configured port) for SMTP.
- Use **port 80** (or your configured port) for the health check.

## Authentication

- **AUTH is required**: clients must send a username and password (e.g. SMTP AUTH LOGIN/PLAIN).
- The **password is used as the API key/token** for the chosen provider (see below). So you configure your app or SMTP client with:
  - **Username**: e.g. `mailgun@mg.yourdomain.com`, `mailgun-eu@mg.yourdomain.com`, `mailersend@yourdomain.com`, or `postmark@yourdomain.com`. The local part can be used to force the provider; for Mailgun the domain is also used as the sending domain.
  - **Password**: the API key or server token for that provider (Mailgun Sending Key, Postmark Server API Token, or MailerSend API Token).

That way you can use different credentials per domain or app by using different SMTP usernames and passwords.

## How emails are routed to providers

The relay chooses the provider in this order:

1. If the **username local part** matches a provider, that provider wins.
2. Otherwise, it falls back to the **password** and detects the provider from the API key/token pattern.

Supported username local parts:

- `mailersend@...` -> MailerSend
- `postmark@...` -> Postmark
- `mailgun@...` -> Mailgun US API
- `mailgun-eu@...` -> Mailgun EU API

When Mailgun is used, the domain in the username must match the domain the API key belongs to.

For example, if you have a Mailgun API key for the domain `mg.yourdomain.com`, you can use the username `mailgun@mg.yourdomain.com` or `mailgun-eu@mg.yourdomain.com`, and the password will be the Mailgun Sending Key.

If Mailgun is detected from the API key instead of the username, Mini Mailer uses `MAILGUN_EU` to choose the Mailgun region:

- `MAILGUN_EU=1` uses `https://api.eu.mailgun.net`
- unset or any other value uses `https://api.mailgun.net`

For Postmark and MailerSend, the domain part of the username is ignored.

## Example client configuration

Configure your app or SMTP client to use the relay like this:

- **Host**: your Mini Mailer host (e.g. `mini-mailer.railway.internal`).
- **Port**: `25`, `2525`, or `587`.
- **Username**: e.g. `mailgun@mg.yourdomain.com`, `mailgun-eu@mg.yourdomain.com`, `mailersend@yourdomain.com`, or `postmark@yourdomain.com`.
- **Password**: the corresponding provider API key or token (Mailgun Sending Key, Postmark Server API Token, or MailerSend API Token).
- **Encryption**: none

## Health check

A small HTTP server runs for readiness/liveness probes (e.g. Railway). It listens on `HEALTH_PORT` (default `80`).

- **GET `/health`** or **GET `/`** → `200` and `{"status":"ok"}`.

Configure your platform to use path `/health` on the service’s HTTP port so the health check succeeds when the process is up.

## Running the app

```bash
npm install
npm run build
npm run start
```

Or for development:

```bash
npm run dev
```

Optional env vars (for logging and listen address):

- `LOG_LEVEL` – e.g. `info`, `debug`
- `LISTEN_HOST` – default `0.0.0.0`
- `HEALTH_PORT` – default `80` (HTTP health check).
- `SMTP_PORTS` – comma-separated SMTP listen ports, defaults to `25,2525,587`
- `DEFAULT_API_KEY` – when set, allows unauthenticated SMTP clients and uses this API key/token as the provider credential.
- `MAILGUN_EU` – set to `1` to use Mailgun's EU API when Mailgun is selected by API key rather than by a `mailgun` / `mailgun-eu` username.

## End-to-end test

Run the MailSlurp end-to-end suite with:

```bash
npm run test:e2e
```

Required env vars:

- `SMTP_HOST` – Mini Mailer host to test against
- `SMTP_PORT` – Mini Mailer SMTP port, defaults to `2525`
- `MAILSLURP_API_KEY` – MailSlurp API key
- `TEST_MAILGUN_USERNAME` – SMTP username for Mailgun, e.g. `mailgun@mg.example.com`
- `TEST_MAILGUN_API_KEY` – Mailgun API key
- `TEST_POSTMARK_USERNAME` – SMTP username for Postmark, e.g. `postmark@test.example.com`
- `TEST_POSTMARK_API_KEY` – Postmark server token
- `TEST_POSTMARK_FROM` – verified Postmark sender address
- `TEST_MAILERSEND_USERNAME` – SMTP username for MailerSend, e.g. `mailersend@test.example.com`
- `TEST_MAILERSEND_API_KEY` – MailerSend API key
- `TEST_MAILERSEND_FROM` – verified MailerSend sender address
