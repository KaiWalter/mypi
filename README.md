# pi Telegram bot bridge

A small Telegram bot that routes messages into a per-chat pi agent session using the pi SDK.

## What it does

- creates one pi session per Telegram chat
- keeps conversation state across bot restarts
- supports `/start`, `/help`, `/reset`, and `/session`
- uses pi's normal auth, model registry, tools, extensions, prompts, and `AGENTS.md`

## Security

This bot can expose pi's filesystem and shell tools through Telegram.

At minimum, you should:

- set `TELEGRAM_ALLOWED_CHAT_IDS`
- run it in a dedicated working directory/container
- start with `PI_TOOL_MODE=readonly`
- only enable write/bash access if you trust every allowed chat

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather)
2. Copy `.env.example` to `.env`
3. Fill in `TELEGRAM_BOT_TOKEN`
4. Optionally set `TELEGRAM_ALLOWED_CHAT_IDS` to your personal chat id
5. Install dependencies:

```bash
npm install
```

6. Make sure pi can authenticate with a model provider.
   You can either:

- use your normal `~/.pi/agent/auth.json`
- or export provider env vars like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, etc.

7. Run the bot:

```bash
npm run start
```

## Commands

- `/start` - welcome message
- `/help` - usage help
- `/reset` - start a fresh pi session for the current Telegram chat
- `/session` - show the current session file

## Important env vars

- `TELEGRAM_BOT_TOKEN` - required
- `TELEGRAM_ALLOWED_CHAT_IDS` - recommended allowlist
- `PI_CWD` - working directory for pi tools and resource discovery
- `PI_AGENT_DIR` - pi config directory, defaults to `~/.pi/agent`
- `PI_MODEL` - optional `provider/model` override
- `PI_THINKING_LEVEL` - `off|minimal|low|medium|high|xhigh`
- `PI_TOOL_MODE` - `readonly` or `coding`
- `STATE_DIR` - where chat-to-session mapping is stored

## Notes

- With `PI_TOOL_MODE=readonly`, the bot uses pi's read-only tools.
- With `PI_TOOL_MODE=coding`, the bot uses read/write/bash/edit tools.
- Project-local pi extensions in `.pi/extensions/` are discovered automatically from `PI_CWD`.
- Session files are persisted and reused per Telegram chat.

## Finding your Telegram chat id

Message the bot once, then temporarily run without `TELEGRAM_ALLOWED_CHAT_IDS`. The bot logs rejected chat ids when access is denied after you enable an allowlist.
