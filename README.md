# Unthread WhatsApp Bot

WhatsApp customer support integration for Unthread via Twilio.

Customers message a WhatsApp business number, messages flow into Unthread as tickets, and agent replies are sent back to WhatsApp.

## Architecture

```
Customer (WhatsApp) → Twilio → Bot → Unthread (ticket created)
                                          ↓
Agent replies in Unthread → Webhook → Bot → Twilio → Customer (WhatsApp)
```

## Setup

### Prerequisites

- Node.js 20+
- Twilio account with WhatsApp sandbox (or approved number)
- Unthread API key

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### Run

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/twilio` | Twilio WhatsApp incoming messages |
| POST | `/webhooks/unthread` | Unthread webhook (agent replies) |
| GET | `/health` | Health check |

### Twilio Sandbox Setup

1. Go to Twilio Console > Messaging > WhatsApp Sandbox
2. Set the webhook URL to `https://your-domain.com/webhooks/twilio`
3. Method: POST

### Unthread Webhook Setup

1. In Unthread, configure a webhook pointing to `https://your-domain.com/webhooks/unthread`
2. Subscribe to `message_created` events

## Customer Mapping

- WhatsApp phone number is always captured
- Customers are created with dummy email: `{phone}@whatsapp.user`
- Customer names are prefixed with `[WhatsApp]`
- If a customer provides their email, it can be matched to an existing Unthread profile (future enhancement)
