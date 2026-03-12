# Unthread WhatsApp Bot 📱 [![made by](https://img.shields.io/badge/made%20by-WG%20Tech%20Labs-0060a0.svg?logo=github&longCache=true&labelColor=181717&style=flat-square)](https://github.com/wgtechlabs) [![official](https://img.shields.io/badge/official-Unthread%20Extension-FF5241.svg?logo=whatsapp&logoColor=white&labelColor=181717&style=flat-square)](https://unthread.com)

[![banner](https://ghrb.waren.build/banner?header=Unthread+WhatsApp+Bot+%F0%9F%93%B1&subheader=Official+Unthread+support+bot+for+WhatsApp+via+Twilio&bg=013B84-016EEA&color=FFFFFF)](https://github.com/wgtechlabs/unthread-whatsapp-bot)

[![release workflow](https://img.shields.io/github/actions/workflow/status/wgtechlabs/unthread-whatsapp-bot/release.yml?style=flat-square&logo=github&label=release&labelColor=181717)](https://github.com/wgtechlabs/unthread-whatsapp-bot/actions/workflows/release.yml) [![container workflow](https://img.shields.io/github/actions/workflow/status/wgtechlabs/unthread-whatsapp-bot/container.yml?branch=dev&style=flat-square&logo=github&labelColor=181717&label=container)](https://github.com/wgtechlabs/unthread-whatsapp-bot/actions/workflows/container.yml) [![sponsors](https://img.shields.io/badge/sponsor-%E2%9D%A4-%23db61a2.svg?&logo=github&logoColor=white&labelColor=181717&style=flat-square)](https://github.com/sponsors/wgtechlabs) [![version](https://img.shields.io/github/release/wgtechlabs/unthread-whatsapp-bot.svg?logo=github&labelColor=181717&color=default&style=flat-square&label=version)](https://github.com/wgtechlabs/unthread-whatsapp-bot/releases) [![star](https://img.shields.io/github/stars/wgtechlabs/unthread-whatsapp-bot.svg?&logo=github&labelColor=181717&color=yellow&style=flat-square)](https://github.com/wgtechlabs/unthread-whatsapp-bot/stargazers) [![license](https://img.shields.io/github/license/wgtechlabs/unthread-whatsapp-bot.svg?&logo=github&labelColor=181717&style=flat-square)](https://github.com/wgtechlabs/unthread-whatsapp-bot/blob/main/license)

**Official Unthread Extension** — The Unthread WhatsApp Bot connects your WhatsApp Business number with Unthread's powerful ticket management system via Twilio. Customers message your WhatsApp number, messages flow into Unthread as tickets, and agent replies are sent back to WhatsApp — with automatic system notifications for ticket creation and status changes.

This bot is designed for businesses managing customer support through WhatsApp — optimized for professional support workflows with seamless bidirectional communication between your team and customers.

## 🤗 Special Thanks

<!-- markdownlint-disable MD033 -->
| <div align="center">💎 Platinum Sponsor</div> |
|:-------------------------------------------:|
| <a href="https://unthread.com"><img src="https://raw.githubusercontent.com/wgtechlabs/unthread-discord-bot/main/.github/assets/sponsors/platinum_unthread.png" width="250" alt="Unthread"></a> |
| <div align="center"><a href="https://unthread.com" target="_blank"><b>Unthread</b></a><br/>Streamlined support ticketing for modern teams.</div> |
<!-- markdownlint-enable MD033 -->

## 🤔 How It Works

```
Customer (WhatsApp) → Twilio → Bot → Unthread (ticket created)
                                          ↓
Agent replies in Unthread → Webhook Server → Redis Queue → Bot → Twilio → Customer (WhatsApp)
```

### Inbound Flow

1. Customer sends a WhatsApp message
2. Twilio forwards to the bot's webhook endpoint
3. Bot resolves or creates an Unthread customer (using phone-based identity)
4. Bot resolves or creates a conversation (ticket) with the initial message
5. A "Support Ticket Created" system message is sent to the customer with their ticket number

### Outbound Flow

1. The companion [unthread-webhook-server](https://github.com/wgtechlabs/unthread-webhook-server) receives Unthread events and pushes them to a Redis queue
2. Bot continuously polls the Redis queue
3. Agent replies (`message_created`) are forwarded to the customer via Twilio
4. Status changes (`conversation_updated`) trigger system notifications (closed, on hold, resumed)

### System Messages

Customers receive automatic notifications for ticket lifecycle events:

- **Ticket Created** — confirmation with ticket number when a new conversation is opened
- **Ticket Closed** — notification when a ticket is closed or resolved
- **Ticket On Hold** — notification when a ticket is placed on hold
- **Ticket Resumed** — notification when a ticket moves back to active from hold

## ✨ Key Features

- **Seamless Ticket Creation**: Incoming WhatsApp messages automatically create Unthread support tickets
- **Bidirectional Communication**: Agent replies in Unthread are forwarded back to the customer via WhatsApp
- **System Notifications**: Automatic WhatsApp messages for ticket lifecycle events (created, closed, on hold, resumed)
- **Customer Management**: Automatic customer profile creation using phone-based identity
- **Multi-layer Storage**: [Nuvex](https://github.com/wgtechlabs/nuvex)-powered persistence (Memory + Redis + PostgreSQL)
- **Webhook Queue Processing**: Redis-based queue consumption from [unthread-webhook-server](https://github.com/wgtechlabs/unthread-webhook-server)
- **Health Monitoring**: Built-in health check endpoint with storage diagnostics
- **Docker Ready**: Full-stack `docker-compose.yml` with all required services

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- PostgreSQL database
- Twilio account with WhatsApp sandbox (or approved number)
- Unthread API key
- Redis for platform storage/cache
- Redis for webhook queue (used by [unthread-webhook-server](https://github.com/wgtechlabs/unthread-webhook-server))

### Installation

```bash
git clone https://github.com/wgtechlabs/unthread-whatsapp-bot.git
cd unthread-whatsapp-bot
bun install
```

### Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

#### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Runtime environment. Accepts `dev`/`development` or `prod`/`production`; controls Log Engine verbosity | `development` |
| `PORT` | Application port | `3000` |
| `TWILIO_ACCOUNT_SID` | Twilio account ID | — |
| `TWILIO_AUTH_TOKEN` | Twilio authentication token | — |
| `TWILIO_WHATSAPP_NUMBER` | Twilio WhatsApp business number | `whatsapp:+14155238886` |
| `UNTHREAD_API_KEY` | Unthread API key | — |
| `UNTHREAD_API_URL` | Unthread API endpoint | `https://api.unthread.io/api` |
| `UNTHREAD_SLACK_CHANNEL_ID` | Target Slack channel for tickets | — |
| `UNTHREAD_WEBHOOK_SECRET` | Webhook secret (optional) | — |
| `POSTGRES_URL` | PostgreSQL connection string | — |
| `REDIS_URL` | Redis for platform caching (optional) | `redis://localhost:6379` |
| `WEBHOOK_REDIS_URL` | Redis for webhook queue | `redis://localhost:6380` |

### Run

```bash
# Development (with hot reload)
bun dev

# Production
bun start
```

Logging behavior is handled by `@wgtechlabs/log-engine` based on `NODE_ENV`:

- `dev` or `development` enables debug logs
- `prod` or `production` shows info-and-above logs

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/twilio` | Twilio WhatsApp incoming messages |
| GET | `/health` | Health check (status, version, storage health) |

### Twilio Sandbox Setup

1. Go to Twilio Console > Messaging > WhatsApp Sandbox
2. Set the webhook URL to `https://your-domain.com/webhooks/twilio`
3. Method: POST

### Unthread Webhook Setup

1. Run [unthread-webhook-server](https://github.com/wgtechlabs/unthread-webhook-server) with `TARGET_PLATFORM=whatsapp`
2. In Unthread, configure a webhook pointing to your webhook-server endpoint:
   `https://your-domain.com/unthread-webhook`
3. Subscribe to `message_created` and `conversation_updated` events

### 🐳 Docker Quick Reference

A `docker-compose.yml` is provided with the full stack:

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f server

# Reset everything (fresh start with clean databases)
docker compose down -v && docker compose up -d
```

> **💡 Tip**: Use `docker compose down -v` to completely reset your local environment. This is safe for development and useful after version upgrades or when you need a clean slate.

Services included:

| Service | Description | Port |
|---------|-------------|------|
| `server` | WhatsApp bot | 3000 |
| `webhook-server` | Unthread webhook server | 3001 |
| `postgres-platform` | PostgreSQL 17 | 5432 |
| `redis-platform` | Redis 8 (platform cache) | 6379 |
| `redis-webhook` | Redis 8 (webhook queue) | 6380 |

## 🏗️ Architecture

This bot is built with **TypeScript** on the **Bun** runtime for enhanced performance, type safety, and developer experience.

### Technology Stack

- **TypeScript**: For type safety and better code maintainability
- **Bun**: Fast all-in-one JavaScript runtime
- **Express.js**: HTTP server for Twilio webhook ingestion
- **Twilio SDK**: WhatsApp message delivery

**Storage & Performance:**
- **PostgreSQL**: Primary database via [Nuvex](https://github.com/wgtechlabs/nuvex) multi-layer storage
- **Redis**: High-performance caching and webhook queue consumption

**Infrastructure:**
- **Docker Compose**: Complete local development environment with all services
- **Health Monitoring**: Built-in health check endpoint with storage diagnostics

## 💬 Community Discussions

Join our community discussions to get help, share ideas, and connect with other users:

- 📣 **[Announcements](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/announcements)**: Official updates from the maintainer
- 📸 **[Showcase](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/showcase)**: Show and tell your implementation
- 💖 **[Wall of Love](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/wall-of-love)**: Share your experience with the bot
- 🛟 **[Help & Support](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/help-support)**: Get assistance from the community
- 🧠 **[Ideas](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/ideas)**: Suggest new features and improvements

## 🛟 Help & Support

Need help? Check our [Help & Support](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/help-support) discussions or [create a new issue](https://github.com/wgtechlabs/unthread-whatsapp-bot/issues/new/choose).

## 🎯 Contributing

**Important**: All pull requests must be submitted to the `dev` branch. PRs to `main` will be automatically rejected.

Contributions are welcome! Your code must pass `bun run typecheck` before merging.

## 💖 Sponsors

Like this project? **Leave a star**! ⭐⭐⭐⭐⭐

There are several ways you can support this project:

- [Become a sponsor](https://github.com/sponsors/wgtechlabs) and get some perks! 💖
- [Buy me a coffee](https://buymeacoffee.com/wgtechlabs) if you just love what I do! ☕

## ⭐ GitHub Star Nomination

Found this project helpful? Consider nominating me **(@warengonzaga)** for the [GitHub Star program](https://stars.github.com/nominate/)! This recognition supports ongoing development of this project and [my other open-source projects](https://github.com/warengonzaga?tab=repositories). GitHub Stars are recognized for their significant contributions to the developer community — your nomination makes a difference and encourages continued innovation!

## 📃 License

This project is licensed under the [GNU General Public License v3.0](https://opensource.org/licenses/GPL-3.0). See the [LICENSE](LICENSE) file for the full license text.

## 📝 Author

This project is created by **[Waren Gonzaga](https://github.com/warengonzaga)** under [WG Technology Labs](https://github.com/wgtechlabs), with the help of awesome [contributors](https://github.com/wgtechlabs/unthread-whatsapp-bot/graphs/contributors).

[![contributors](https://contrib.rocks/image?repo=wgtechlabs/unthread-whatsapp-bot)](https://github.com/wgtechlabs/unthread-whatsapp-bot/graphs/contributors)

---

💻 with ❤️ by [Waren Gonzaga](https://warengonzaga.com) under [WG Technology Labs](https://wgtechlabs.com), and [Him](https://www.youtube.com/watch?v=HHrxS4diLew&t=44s) 🙏
