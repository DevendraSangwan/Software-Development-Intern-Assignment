# Mitra Mail — Email Scheduler

A TypeScript email scheduling app with a Next.js dashboard, Express API, PostgreSQL persistence, BullMQ/Redis delayed jobs, Ethereal SMTP, Elasticsearch search, a live Bull Board view, and Slack rate-limit alerts.

## Requirements

- Node.js 20+
- Docker and Docker Compose (for PostgreSQL, Redis, and Elasticsearch)
- A generated Ethereal test SMTP account
- A Slack app with OAuth credentials to enable Slack alerts

## Run locally

1. Install dependencies and start the infrastructure:

   ```bash
   npm install
   docker compose up -d
   ```

2. Create an Ethereal account and copy the printed SMTP settings:

   ```bash
   npm run smtp:ethereal
   ```

   Ethereal is a fake SMTP service: messages are captured at [ethereal.email/messages](https://ethereal.email/messages), not delivered to real recipients.

3. Copy `.env.example` to `.env` and set `SMTP_USER` and `SMTP_PASS`. Keep the local PostgreSQL/Redis/Elasticsearch defaults for Docker Compose. For Slack, create a Slack app with a bot token scope of `chat:write`, `channels:read`, and `groups:read`. Enable OAuth & Permissions, add `http://localhost:4000/api/slack/callback` as a redirect URL, then set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`. Generate a 32-byte key with `openssl rand -hex 32` and set it as `TOKEN_ENCRYPTION_KEY`.

4. Create the database tables and start the API, worker, and web app:

   ```bash
   npm run db:push
   npm run dev
   ```

   Open the dashboard at [http://localhost:3000](http://localhost:3000). The live BullMQ dashboard is at [http://localhost:4000/admin/queues](http://localhost:4000/admin/queues). The queue dashboard and API are intentionally unauthenticated for this local demo; protect them behind authentication before public deployment.

## Scheduling and delivery behavior

- The API writes an email and its tenant/sender to PostgreSQL, then adds a BullMQ delayed job whose stable job ID is the email's database ID. A worker restart reconciles scheduled database records back into Redis. BullMQ's persisted delayed jobs survive worker restarts.
- The worker concurrency is configured by `WORKER_CONCURRENCY` (default `5`).
- A Redis Lua script atomically reserves a per-sender send slot across workers and instances. `MAX_EMAILS_PER_HOUR_PER_SENDER` defaults to `200` sends per UTC hour; `MIN_SEND_INTERVAL_MS` defaults to `2000` ms between all sends globally. Both are configurable. A reservation consumes quota when a send is attempted, including SMTP attempts that fail.
- At the hourly limit, BullMQ moves the job into the next UTC hour window; the email remains scheduled and is not discarded. A Redis key de-duplicates the alert per sender/hour. If Slack is connected and a channel is selected, the worker makes a real `chat.postMessage` request at the moment the limit is reached. Without a Slack connection, sending continues to be rate limited and no notification is attempted. Connecting Slack later takes effect without restarting the app.
- Slack OAuth uses a short-lived, one-time state stored in PostgreSQL. The bot token is encrypted at rest with AES-256-GCM; `TOKEN_ENCRYPTION_KEY` must be a 64-character hex string. After OAuth, select a channel the bot has joined in the dashboard.
- Failed SMTP attempts use BullMQ exponential backoff and are marked failed after `EMAIL_JOB_ATTEMPTS` (default `5`). Search is tenant-filtered and indexes recipient, sender, subject, body, status, and schedule/sent times.
- The SMTP protocol cannot provide exactly-once delivery: a process crash after the SMTP server accepts a message but before PostgreSQL records it as sent can result in a retry. The persistent email ID is included as an SMTP header to aid tracing; this is an at-least-once delivery design rather than a claim of impossible SMTP exactly-once semantics.

## API

- `GET /api/health`
- `GET/POST /api/senders`
- `GET /api/emails?q=...&status=...` — Elasticsearch-backed search when `q` is non-empty; otherwise the latest 100 DB records. `status` can be `all` (default), `scheduled` (including emails currently sending), `sent`, or `failed`.
- `POST /api/emails` — JSON fields: `senderId`, `recipient`, `subject`, `textBody`, and ISO-8601 `scheduledAt`.
- `GET /api/slack/connect` — start Slack OAuth.
- `GET /api/slack/status`, `GET /api/slack/channels`, `POST /api/slack/channel`, and `DELETE /api/slack`.

All API data currently belongs to the `TENANT_ID` configured for this demo deployment. Add application authentication and derive tenant identity from the authenticated principal before exposing the service to multiple customers.
# Software-Development-Intern-Assignment
