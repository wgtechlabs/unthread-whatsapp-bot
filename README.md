# Unthread WhatsApp Bot 📱

> [!WARNING]
> **Maintenance mode:** Sponsorship for this project has ended, and maintainer time is limited. No new features or improvements are planned. Security and bug fixes will continue until this integration is archived. It may be archived later, but it is not archived now.

<p align="center">
  <a href="https://github.com/wgtechlabs/unthread-whatsapp-bot"><img src="https://ghrb.waren.build/banner?header=Unthread+WhatsApp+Bot+%F0%9F%93%B1&subheader=Official+Unthread+support+bot+for+WhatsApp+via+Twilio&bg=013B84-016EEA&color=FFFFFF" alt="Unthread WhatsApp Bot 📱 repository banner"></a>
</p>

<p align="center">
  <strong>Official Unthread Extension for WhatsApp support via Twilio.</strong>
</p>

<p align="center">
  [![made by](https://img.shields.io/badge/made%20by-WG%20Tech%20Labs-0060a0.svg?logo=github&longCache=true&labelColor=181717&style=flat-square)](https://github.com/wgtechlabs) [![official](https://img.shields.io/badge/official-Unthread%20Extension-FF5241.svg?logo=whatsapp&logoColor=white&labelColor=181717&style=flat-square)](https://unthread.com)<br>
  [![build flow workflow](https://img.shields.io/github/actions/workflow/status/wgtechlabs/unthread-whatsapp-bot/build-flow.yml?branch=dev&style=flat-square&logo=github&labelColor=181717&label=build%20flow)](https://github.com/wgtechlabs/unthread-whatsapp-bot/actions/workflows/build-flow.yml) [![sponsors](https://img.shields.io/badge/sponsor-%E2%9D%A4-%23db61a2.svg?&logo=github&logoColor=white&labelColor=181717&style=flat-square)](https://github.com/sponsors/wgtechlabs) [![version](https://img.shields.io/github/release/wgtechlabs/unthread-whatsapp-bot.svg?logo=github&labelColor=181717&color=default&style=flat-square&label=version)](https://github.com/wgtechlabs/unthread-whatsapp-bot/releases) [![star](https://img.shields.io/github/stars/wgtechlabs/unthread-whatsapp-bot.svg?&logo=github&labelColor=181717&color=yellow&style=flat-square)](https://github.com/wgtechlabs/unthread-whatsapp-bot/stargazers) [![license](https://img.shields.io/github/license/wgtechlabs/unthread-whatsapp-bot.svg?&logo=github&labelColor=181717&style=flat-square)](https://github.com/wgtechlabs/unthread-whatsapp-bot/blob/main/license)
</p>

## 💎 Sponsors & Partners

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://railway.com"><picture><source media="(prefers-color-scheme: dark)" srcset="./.github/assets/sponsors/railway-logotype-light.svg"><img src="./.github/assets/sponsors/railway-logotype-dark.svg" width="150" alt="Railway logo"></picture></a>
      <p>Cloud platform for deploying and hosting apps, databases, and infrastructure.</p>
    </td>
    <td width="50%" align="center">
      <a href="https://www.docker.com"><img src="./.github/assets/sponsors/docker-logo.svg" width="150" alt="Docker logo"></a>
      <p>Platform for building, sharing, and running containerized applications.</p>
    </td>
  </tr>
</table>

## ✨ Features

- Converts inbound WhatsApp messages into Unthread conversations
- Sends agent replies from Unthread back to WhatsApp
- Sends automatic status system messages (created, closed, on hold, resumed)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/CveS2G)

## 🤔 How It Works

```text
Customer (WhatsApp) -> Twilio -> Bot -> Unthread
                                      |
Agent (Unthread) <- Webhook Server <- Redis Queue <- Bot
```

- Inbound path: Twilio calls `POST /webhooks/twilio`, then the bot resolves/creates customer + conversation in Unthread.
- Outbound path: [unthread-webhook-server](https://github.com/wgtechlabs/unthread-webhook-server) pushes Unthread events to Redis, then this bot forwards replies to WhatsApp.
- File support: inbound and outbound attachments are supported through media proxy links.

## 🚀 Quick Start

### Prerequisites

- Node.js 22, 24, or 26 (default runtime: Node.js 26)
- Bun 1.x
- Twilio account with WhatsApp sandbox or approved number
- Unthread API key and channel ID
- PostgreSQL
- Redis for webhook queue (required for outbound events)
- Redis for platform cache (optional, recommended)

### 1) Install

```bash
git clone https://github.com/wgtechlabs/unthread-whatsapp-bot.git
cd unthread-whatsapp-bot
bun install
```

### 2) Configure

```bash
cp .env.example .env
```

Required variables:

| Variable | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_WHATSAPP_NUMBER` | Sender WhatsApp number (for example `whatsapp:+14155238886`) |
| `TWILIO_WEBHOOK_URL` | Public webhook URL for signature validation |
| `UNTHREAD_API_KEY` | Unthread API key |
| `UNTHREAD_SLACK_CHANNEL_ID` | Unthread target channel |
| `POSTGRES_URL` | PostgreSQL connection string |

Important optional variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `dev` | `dev`, `development`, `prod`, `production`, `test`, `staging` |
| `PORT` | `3000` | App port |
| `REDIS_URL` | empty | Platform cache via Nuvex |
| `WEBHOOK_REDIS_URL` | empty | Required for webhook queue consumer |
| `WEBHOOK_QUEUE_NAME` | `unthread-events` | Queue name used by webhook server |
| `UNTHREAD_WEBHOOK_SECRET` | empty | Optional webhook secret |
| `SLACK_TEAM_ID` | empty | Optional, auto-detected for Slack file downloads |
| `PUBLIC_BASE_URL` | derived from `TWILIO_WEBHOOK_URL` | Base URL for media token links |
| `MEDIA_TOKEN_TTL_SECONDS` | `600` | Media proxy token TTL in seconds |
| `MAX_ATTACHMENT_SIZE_BYTES` | `16777216` | Max inbound attachment size |

Unthread API base URL is fixed internally to `https://api.unthread.io/api`.

### 3) Run

```bash
# development
bun dev

# production
bun start
```

### 4) Point Twilio to the webhook

In Twilio WhatsApp Sandbox, set:

- URL: `https://your-domain.com/webhooks/twilio`
- Method: `POST`

### 5) Run webhook ingestion for outbound replies

Run [unthread-webhook-server](https://github.com/wgtechlabs/unthread-webhook-server) with `TARGET_PLATFORM=whatsapp`, then in Unthread subscribe to:

- `message_created`
- `conversation_updated`

## 🔌 Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/webhooks/twilio` | Inbound Twilio WhatsApp webhook |
| `GET` | `/media/:token` | Short-lived media proxy for Twilio |
| `GET` | `/health` | App, version, and storage health |

## 🐳 Docker Quick Start

Docker images use Node.js 26 Alpine as the base runtime (with Bun installed for the app toolchain).

```bash
docker compose up -d
docker compose logs -f server
```

Reset local data:

```bash
docker compose down -v && docker compose up -d
```

## ✅ Validate Changes

```bash
bun run lint
bun run typecheck
bun run test
```

## 💬 Community Discussions

Join our community discussions to get help, share ideas, and connect with other users:

- 📣 **[Announcements](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/announcements)**: Official updates from the maintainer
- 📸 **[Showcase](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/showcase)**: Show and tell your implementation
- 💖 **[Wall of Love](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/wall-of-love)**: Share your experience with the bot
- 🛟 **[Help & Support](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/help-support)**: Get assistance from the community
- 🧠 **[Ideas](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/ideas)**: Feature requests and improvements are not planned during maintenance mode

## 🛟 Help & Support

Need help? Check our [Help & Support](https://github.com/wgtechlabs/unthread-whatsapp-bot/discussions/categories/help-support) discussions or [create a new issue](https://github.com/wgtechlabs/unthread-whatsapp-bot/issues/new/choose).

## 🎯 Contributing

**Important**: All pull requests must be submitted to the `dev` branch. PRs to `main` will be automatically rejected.

Security and bug-fix contributions are welcome during maintenance mode. Your code must pass `bun run typecheck` before merging.

## 💖 Support the Project

Like this project? **Leave a star**! ⭐⭐⭐⭐⭐

There are several ways you can support this project:

- [Become a sponsor](https://github.com/sponsors/wgtechlabs) and get some perks! 💖
- [Buy me a coffee](https://buymeacoffee.com/wgtechlabs) if you just love what I do! ☕

## ⭐ GitHub Star Nomination

Found this project helpful? Consider nominating me **(@warengonzaga)** for the [GitHub Star program](https://stars.github.com/nominate/)! This recognition supports continued maintenance of this integration and [my other open-source projects](https://github.com/warengonzaga?tab=repositories). GitHub Stars are recognized for their significant contributions to the developer community — your nomination makes a difference and helps keep maintenance work visible.

## 📃 License

This project is licensed under the [GNU General Public License v3.0](https://opensource.org/licenses/GPL-3.0). See the [LICENSE](LICENSE) file for the full license text.

## 📝 Author

This project is created by **[Waren Gonzaga](https://github.com/warengonzaga)** under [WG Technology Labs](https://github.com/wgtechlabs), with the help of awesome [contributors](https://github.com/wgtechlabs/unthread-whatsapp-bot/graphs/contributors).

[![contributors](https://contrib.rocks/image?repo=wgtechlabs/unthread-whatsapp-bot)](https://github.com/wgtechlabs/unthread-whatsapp-bot/graphs/contributors)

---

💻 with ❤️ by [Waren Gonzaga](https://warengonzaga.com) under [WG Technology Labs](https://wgtechlabs.com), and [Him](https://www.youtube.com/watch?v=HHrxS4diLew&t=44s) 🙏
