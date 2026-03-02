# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]






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

