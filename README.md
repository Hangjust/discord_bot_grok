# Configurable Discord AI Bot

This is a CommonJS Node.js bot built on `discord.js`. Each Discord server gets its own persona, channel and role access rules, response style, advanced settings, and encrypted DeepSeek API key.

The configurable AI backend runs alongside the existing Grok-compatible commands, local lore/stats, idle chatter, and private role-play ticket product. The lightweight `!nn`, `!blud`, `!funmute`, and `!ratio` utilities remain, and normal-channel commands obey the configured channel and role gates.

## How setup works

When the bot joins a server, it posts a **Set me up** embed in the system channel, or the first text channel where it can send embeds. Existing servers are reconciled once when the bot starts. The public panel has four controls, but every click, select, and modal submit is independently restricted to the server owner or a member with Discord's Administrator permission.

1. **Configure persona**
   - Character name, or `ai` for a general assistant
   - A required 100–1,500 character behavior description
   - An optional custom prompt
   - A 1–32 character wake word such as `AI`
   - Language mode: Very strict, Casual, or Let it rip
   - Discord text style: normal, bold, italic, underline, strikethrough, spoiler, or code block
   - Delivery as a normal message or an embed
2. **Channels & roles**
   - Up to 25 enabled text/announcement channels
   - Up to 25 allowed roles; an empty list means everyone
   - Up to 25 blocked roles; blocked always overrides allowed
3. **Bring your API key**
   - Private instructions and API-console link
   - API key validation through the provider's balance endpoint
   - Encrypted per-server storage; the key is never echoed or logged
4. **More settings**
   - Web search Off, explicit requests only, or automatic freshness detection
   - Brief, balanced, or detailed answers
   - 0, 5, 10, or 20 messages of short-lived channel context
   - 0, 5, 15, or 30 seconds of extra per-user cooldown

After the required persona, at least one channel, and an API key are present, members can invoke the bot in three ways:

- Start a message with the configured wake word: `AI explain this`
- Mention the bot
- Reply directly to one of the bot's messages

Server owners and administrators can mention the bot with `channelEnable` or `channelDisable` to turn AI responses on or off for the current channel. The setting is stored per server and overrides the previous hardcoded channel allowlist for normal bot responses.

Use `!setup` as the server owner or an administrator to repost the panel if it was deleted.

## Install and run

Requires Node.js 22.23+, 24.17+, or 26.3+.

```bash
npm install
```

Copy `.env.example` to `.env`, then set the Discord token and a stable encryption key. Generate the encryption key once and keep it unchanged; changing or losing it makes stored guild API keys unreadable.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Example environment:

```dotenv
DISCORD_TOKEN=your_discord_bot_token
CONFIG_ENCRYPTION_KEY=the_generated_value
GUILD_CONFIG_PATH=./data/guild-config.json
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TIMEOUT_MS=30000
```

Then start the bot:

```bash
npm start
```

The application fails before connecting when `DISCORD_TOKEN` or `CONFIG_ENCRYPTION_KEY` is missing or invalid. The old process-wide `DEEPSEEK_API_KEY` setting is no longer read; keys are supplied by each server through its admin-only setup flow.

## Discord configuration

Enable these gateway intents in the Discord developer portal and in the bot installation:

- Guilds
- Guild Messages
- Message Content (privileged intent)

Core permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History

The retained gag utilities need additional permissions only when used: Add Reactions and Manage Messages for `!ratio`, and Moderate Members for `!funmute`. The requesting member must also hold the corresponding moderation permission.

## Optional web search

Web search uses one operator-configured, fixed Brave Search endpoint. Guild administrators can choose how it is used, but cannot provide arbitrary MCP URLs or network tools.

```dotenv
WEB_SEARCH_ENABLED=true
WEB_SEARCH_API_KEY=your_brave_search_key
WEB_SEARCH_MAX_RESULTS=3
WEB_SEARCH_TIMEOUT_MS=5000
```

Search queries have secret-shaped text, Discord IDs, mentions, and URLs redacted before leaving the bot. Results are treated as untrusted context, and returned URLs are sanitized before being posted.

## Security and data behavior

- Guild API keys are encrypted with AES-256-GCM, a unique nonce, and the guild ID as authenticated data.
- Configuration writes use a temporary file, `fsync`, and atomic rename. The `data/` directory and environment files are gitignored.
- Discord modal text fields do not support password masking. A key submission is hidden from the channel, but it is visible to the submitting administrator and passes through Discord; do not share screenshots.
- Access is default-deny. Blocked roles and unselected channels are rejected before context recording, reply fetching, typing indicators, web search, key decryption, or paid AI calls.
- Conversation context is in memory, scoped by guild and channel, bounded, and expires after two hours. Access or persona changes clear the guild's old context.
- Per-user, per-guild, and global hard rate limits plus a one-request in-flight lock protect shared guild balances.
- Provider error bodies, prompts, and API keys are never logged. A `402` response is shown as: “My bot has no balance. Please add your balance to the API console.”
- Very strict output is deterministically profanity-filtered. Casual allows ordinary profanity. Let it rip allows strong language, while all modes keep a hard floor against targeted protected-class slurs and harassment.
- Removing the bot from a guild deletes that guild's stored configuration and encrypted key.

## Commands kept from the previous bot

- `grok <message>` — legacy alias for the server's configured AI trigger
- `grok new` — reset the current channel conversation
- `grok lore` — summarize the channel's local running-joke context
- `grok stats` / `grok who is @user` — local monthly word and vibe summaries
- `!grok help` — show the legacy command menu
- `!bot help` — show the server-specific wake word and help
- `!ping` — health check
- `!nn <text>` or reply with `!nn` — goblin translator
- `!blud`, `!blud off`, `!blud <text>` — blud mode controls/translator
- `!funmute @member [1-3]` — moderator-only short timeout
- `!ratio` — reply to a message; requires Manage Messages
- `!roleplay panel` or `!rp` — moderator-only private role-play ticket panel
- `!roleplay cooldown on|off` — owner/admin role-play reopen control
- `!roleplay close` — close the current role-play ticket
- `@bot channelEnable` / `@bot channelDisable` — enable or disable responses in the current channel (owner/administrator only)

## Development

```bash
npm run check
npm test
```

Tests inject fake network functions and never use the real `.env` API credentials. `npm run check` syntax-checks JavaScript in `index.js`, `scripts`, `src`, and `test`.

## Project map

- `src/setup/` — onboarding panel, admin authorization, modals, select menus, drafts, and status refresh
- `src/storage/` — validated guild configuration and AES-GCM secret storage
- `src/chat/` — access gates, triggers, limits, output rendering, and deterministic language policy
- `src/services/deepseek.js` — explicit per-guild key validation and chat requests
- `src/services/webSearch.js` — fixed-provider search, redaction, sanitization, and source formatting
- `src/events/` — ready/join/leave, interaction, command, and message routing
- `src/state/conversations.js` — bounded, guild/channel-scoped in-memory context
- `src/roleplay/` — bounded private ticket state, interactions, and per-guild-key narration
- `src/grok/` and `src/state/userProfiles.js` — compatibility triggers, lore, and bounded local profiles
