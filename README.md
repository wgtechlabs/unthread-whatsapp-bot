# Unthread WhatsApp Bot

WhatsApp customer support integration for [Unthread](https://unthread.io) via Twilio.

Customers message a WhatsApp business number, messages flow into Unthread as tickets, and agent replies are sent back to WhatsApp.

## Architecture

```
Customer (WhatsApp) → Twilio → Bot → Unthread (ticket created)
                                          ↓
Agent replies in Unthread → Webhook Server → Redis Queue → Bot → Twilio → Customer (WhatsApp)
```

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- PostgreSQL database
- Twilio account with WhatsApp sandbox (or approved number)
- Unthread API key
- Redis for platform storage/cache
- Redis for webhook queue (used by `wgtechlabs/unthread-webhook-server`)

### Install

```bash
bun install
```

### Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### Run

```bash
# Development (with hot reload)
bun dev

# Production
bun start
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/twilio` | Twilio WhatsApp incoming messages |
| POST | `/webhooks/unthread` | Direct Unthread webhook fallback (optional) |
| GET | `/health` | Health check |

### Twilio Sandbox Setup

1. Go to Twilio Console > Messaging > WhatsApp Sandbox
2. Set the webhook URL to `https://your-domain.com/webhooks/twilio`
3. Method: POST

### Unthread Webhook Setup

1. Run `wgtechlabs/unthread-webhook-server` with `TARGET_PLATFORM=whatsapp`
2. In Unthread, configure a webhook pointing to your webhook-server endpoint:
   `https://your-domain.com/unthread-webhook`
3. Subscribe to `message_created` events

## Storage

Uses [Nuvex](https://github.com/wgtechlabs/nuvex) for multi-layer storage (Memory + Redis + PostgreSQL). Customer-to-conversation mappings are persisted across restarts via PostgreSQL, with Redis used for both platform caching and webhook queue consumption.
