# Mini Mailer

Mini Mailer is a simple SMTP server that forwards mail over HTTP to Mailgun, Postmark, or MailerSend. For use as an SMTP gateway on platforms (e.g. [Railway](https://railway.app)) that restrict outbound SMTP ports.

Mini Mailer does not support attachments and is designed to run on an internal network only (e.g. `mini-mailer.railway.internal`), as it does not use TLS.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/mini-mailer?referralCode=EXiHsJ)

## What it does

- Listens for SMTP connections (e.g. on port **25**).
- Requires SMTP **username + password**.
- Uses the **password** as that provider’s **API key/token**.
- Forwards each message to the right provider over HTTPS.

## Port and connection

| Setting   | Default   | Env var      |
|----------|-----------|--------------|
| Host     | `0.0.0.0` | `LISTEN_HOST` |
| Health   | `80`    | `HEALTH_PORT` |

- Use **port 25** (or your configured port) for SMTP.
- Use **port 80** (or your configured port) for the health check.

## Authentication

- **AUTH is required**: clients must send a username and password (e.g. SMTP AUTH LOGIN/PLAIN).
- The **password is used as the API key/token** for the chosen provider (see below). So you configure your app or SMTP client with:
  - **Username**: e.g. `relay@mg.yourdomain.com` or `noreply@yourdomain.com` (used for routing and, for Mailgun, domain).
  - **Password**: the API key or server token for that provider (Mailgun Sending Key, Postmark Server API Token, or MailerSend API Token).

That way you can use different credentials per domain or app by using different SMTP usernames and passwords.

## How emails are routed to providers

The relay uses the **password** to choose the provider. Based on the API key in the password field, it will detect the provider and use the corresponding API to send the email.

When Mailgun is used, the domain in the username must match the domain the API key belongs to.

For example, if you have a Mailgun API key for the domain `mg.yourdomain.com`, you can use the username `relay@mg.yourdomain.com` and the password will be the Mailgun Sending Key.

For Postmark and MailerSend, you can use any username.

## Example client configuration

Configure your app or SMTP client to use the relay like this:

- **Host**: your Mini Mailer host (e.g. `mini-mailer.railway.internal`).
- **Port**: `25` (or `LISTEN_PORT`).
- **Username**: e.g. `relay@mg.yourdomain.com` or `noreply@yourdomain.com` (used for routing and, for Mailgun, domain).
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
