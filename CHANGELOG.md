# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [1.2.3] - 2026-04-15

### Security

- add Dockerfile HEALTHCHECK instruction (#4) (#5)

## [1.2.2] - 2026-04-15

### Changed

- security hardening and deduplication (#3)

## [1.2.1] - 2026-04-14

### Security

- enforce Twilio webhook signature validation (#2)

## [1.2.0] - 2026-03-12

### Added

- introduce WhatsApp store service abstraction

### Changed

- ignore `.codex` and `.vscode` directories
- add fallback email forwarding and hardcode unthread API URL
- add WhatsApp identity resolution, email support, and ticket status messaging
- replace placeholder banner with live dynamic banner image
- add storage diagnostics logging on startup (#1)
- add persistence verification and write failure guards
- align outbound and system messages with new store
- refactor storage to use whatsapp-store
- return friendlyId and status from conversation lookup
- extend types for ticket status and store records
- improve event data extraction and simplify ticket message
- harden webhook error handling and ticket number input types
- respond before sending post-webhook system messages
- refactor ticket confirmation handling and improve logging
- send ticket confirmation via inline TwiML response

## [1.1.1] - 2026-03-06

### Changed

- add project license

### Removed

- delete session timer service and all integration points

## [1.1.0] - 2026-03-06

### Added

- add whatsapp session expiry warning system
- add customer notification helpers

### Changed

- send system messages for ticket and status events
- expose friendlyId from resolveConversation
- add friendlyId to UnthreadConversation
- ignore .contributerc.json

## [1.0.5] - 2026-03-02

### Changed

- enhance customer resolution with caching

## [1.0.4] - 2026-03-02

### Changed

- enhance API request logging and error handling
- enhance error handling for Twilio WhatsApp message sending
- enhance conversation handling and recovery logic
- add *.http to .gitignore to exclude HTTP files

## [1.0.3] - 2026-02-25

### Changed

- align Unthread API calls with telegram and discord bot patterns
- include initial message body when creating Unthread conversation

## [1.0.2] - 2026-02-25

### Changed

- improve error handling in Twilio webhook route

## [1.0.1] - 2026-02-24

### Changed

- refactor event handling to remove UnthreadWebhookEvent type
- add unthread webhook queue integration
- add Dockerfile compose and dockerhub flow

### Removed

- eliminate unthread webhook route and related code
- eliminate UnthreadWebhookEvent interface from types
- eliminate unthread webhook route and related logging

## [1.0.0] - 2026-02-23

### Added

- whatsapp bot scaffold with twilio and unthread integration
- initial commit

### Changed

- add release and container build workflows
- integrate @wgtechlabs/nuvex sdk from npm registry
- replace console calls with log-engine
- migrate from node/tsx to bun runtime
- exclude .claude directory from version control

