# Discord Bot

Join this Discord server to learn more about the bot and whether it fits your needs: https://discord.gg/3RV9edf5n3

A CommonJS Node.js Discord bot built with `discord.js`. It listens in configured server channels, keeps short in-memory context, and replies when someone starts a message with `grok` or directly mentions the bot.

The bot can answer through DeepSeek, maintain local channel context and monthly user summaries, run text commands, and optionally search the web through Brave Search. Each Discord server supplies its own encrypted DeepSeek and optional Brave API key through an Administrator-only setup flow.

## What The Bot Does

1. Answers `grok <message>` prompts and direct `@bot <message>` mentions with DeepSeek.
2. Keeps short in-memory conversation context per server and channel.
3. Reads messages that pass the server's configured channel and role access rules for local context and monthly word or phrase summaries.
4. Supports `grok lore`, `grok stats`, and `grok who is @user` from local memory.
5. Supports helper commands such as `!ping`, `!blud`, `!funmute`, and `!ratio`.
6. Can use Brave web search for current or source-based questions when enabled for that server.

Conversation history, profile counters, request limits, and idle-chatter state are memory-only and clear when the process restarts. Guild setup is persistent; see [Configuration storage, encryption, and backups](#configuration-storage-encryption-and-backups).

## Quick Start

1. Install dependencies.

```bash
npm install
```

2. Create a Discord application and bot in the Discord Developer Portal.
3. Enable Message Content Intent.
4. Invite the bot with both the `bot` and `applications.commands` scopes.
5. Copy `.env.example` to `.env`.
6. Set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, and a generated `GUILD_CONFIG_MASTER_KEY`.
7. Register the slash command manually. The bot does **not** auto-register commands.

```bash
npm run register-commands
```

8. Start the bot.

```bash
npm start
```

On the first run for an unconfigured server, the bot automatically posts one setup panel in the server's system channel, or the first text-based channel where it can view and send messages. An Administrator can use its button or run `/grok-config setup`. Setup validates and stores that server's DeepSeek key and, if enabled, Brave Search key.

## Create And Configure The Discord App

1. Go to the Discord Developer Portal and create an application.
2. Copy the **Application ID** from General Information to `DISCORD_APPLICATION_ID` in `.env`.
3. Open the Bot page, add a bot user, and copy its token to `DISCORD_TOKEN`.
4. On the Bot page, enable **Message Content Intent**. The bot reads normal message text, so this privileged intent is required.
5. Open OAuth2, then URL Generator.
6. Select both `bot` and `applications.commands`.
7. Give the bot the permissions listed below, open the generated URL, and add it to your server.
8. Register `/grok-config` with `npm run register-commands` after setting the required bootstrap variables.

Discord intents used by the code are `Guilds`, `GuildMessages`, `GuildMessageReactions`, and `MessageContent`.

### Registering `/grok-config`

Command registration is a separate, manual deployment step; `npm start` never registers commands.

- The registration script requires `DISCORD_TOKEN` and a numeric `DISCORD_APPLICATION_ID`.
- It registers `grok-config` globally so the command is available in every server that adds the bot. Discord may take time to propagate global command changes.
- Registration upserts only `grok-config`; it preserves unrelated application commands.

Run registration again whenever the slash-command definition changes. Do not run it merely to start the bot.

## Discord Permissions

Give the bot these server or channel permissions:

1. View Channels.
2. Send Messages.
3. Read Message History.
4. Add Reactions for `!ratio`.
5. Manage Messages for `!ratio`, because the command removes reactions from a referenced message.
6. Moderate Members for `!funmute`.

The first-run setup panel can only be posted in a channel where the bot has View Channel and Send Messages. For `!funmute`, Discord role hierarchy also matters: the bot's highest role must be above the target member's highest role, and the requester must have permission to moderate the target.

## Environment Variables

Create `.env` in the project root. `.env.example` contains every setting read by the application.

### Required bootstrap settings

- `DISCORD_TOKEN`: bot token from the Discord Developer Portal. Required to start the bot and to register commands.
- `DISCORD_APPLICATION_ID`: numeric application ID. Required by `npm run register-commands`; it is not needed merely to log in after commands are registered.
- `GUILD_CONFIG_MASTER_KEY`: base64 encoding of exactly 32 random bytes. Required at startup to encrypt and decrypt per-server provider keys.

Generate the master key locally with Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Paste the output into `.env` as `GUILD_CONFIG_MASTER_KEY`. Keep a secure backup outside the repository and alongside your configuration-data backups. If this key is lost or changed, existing encrypted DeepSeek and Brave keys cannot be decrypted; servers must be reset and configured again. `GUILD_CONFIG_MASTER_KEY_ID` labels encrypted blobs and defaults to `primary`; changing it without a migration also makes existing blobs unreadable.

### Deployment-wide provider and limit settings

- `DEEPSEEK_BASE_URL`: DeepSeek HTTPS API base URL. Default: `https://api.deepseek.com`.
- `DEEPSEEK_MODEL`: model used for all configured servers. Default: `deepseek-v4-flash`.
- `DEEPSEEK_TIMEOUT_MS`: DeepSeek request timeout, clamped to 1,000-120,000 ms. Default: `30000`.
- `DEEPSEEK_MAX_CONCURRENT_PER_GUILD`: concurrent AI requests allowed per server, clamped to 1-20. Default: `2`.
- `DEEPSEEK_MAX_REQUESTS_PER_GUILD_PER_MINUTE`: started AI requests per server per rolling minute, clamped to 1-1,000. Default: `40`.
- `DEEPSEEK_MAX_REQUESTS_PER_USER_PER_MINUTE`: started AI requests per user per server per rolling minute, clamped to 1-120. Default: `8`.
- `WEB_SEARCH_MAX_RESULTS`: Brave results requested, clamped to 1-20. Default: `3`.
- `WEB_SEARCH_TIMEOUT_MS`: runtime Brave search timeout, clamped to 1,000-30,000 ms. Default: `5000`. Brave credential validation during setup/rotation currently uses a fixed five-second timeout.

Rate-limit state is in memory and resets when the process restarts. Limits apply before a provider request starts; provider-side limits and billing rules still apply separately.

### Persistent configuration settings

- `GUILD_CONFIG_MASTER_KEY_ID`: encryption-key label. Default: `primary`.
- `GUILD_CONFIG_PATH`: JSON data-file path. Default: `./data/guild-config.json`.
- `ALLOW_LEGACY_GUILD_CONFIG`: explicit compatibility switch for old environment-based guild configuration. Default: `false`. See [Legacy environment fallback](#legacy-environment-fallback).

### Legacy-only settings

These values are not needed for normal per-server setup. They are read only when `ALLOW_LEGACY_GUILD_CONFIG=true` and a server has no stored record:

- `DEEPSEEK_API_KEY`: shared legacy DeepSeek key.
- `DISCORD_REPLY_ALLOWED_CHANNEL_IDS`: comma-separated legacy allowed channel IDs.
- `DISCORD_READ_EXCLUDED_CHANNEL_IDS`: comma-separated legacy ignored channel IDs.
- `WEB_SEARCH_ENABLED`: enables legacy Brave search.
- `WEB_SEARCH_PROVIDER`: read by the standalone legacy web-search configuration helper; only `brave` is supported. The per-server and legacy-fallback runtime paths currently use Brave directly.
- `WEB_SEARCH_API_KEY`: shared legacy Brave key.

`PROTECTED_GLAZE_USER_IDS` remains an optional deployment-wide comma-separated list used by the prompt helper in `src/grok/mentions.js`.

## Per-Server Setup And Administration

`/grok-config` is guild-only, defaults to Administrator permission in Discord, and every handler also checks the caller's Administrator permission. Responses containing status or setup controls are ephemeral where Discord supports it. Provider keys are never displayed back in status output.

Available subcommands:

- `/grok-config setup`: create or replace the server configuration. It asks whether Brave web search should be enabled, validates the entered DeepSeek key and optional Brave key with their providers, encrypts them, and initially allows the channel where setup was submitted.
- `/grok-config status`: show whether setup is stored, whether each key exists, whether web search is enabled, and the channel/role access lists without revealing secret values.
- `/grok-config channel action:<allow|ignore|remove> channel:<channel>`: move a channel into an allow or ignore list, or remove it from both.
- `/grok-config role action:<allow|ignore|remove> role:<role>`: move a role into an allow or ignore list, or remove it from both.
- `/grok-config web action:<enable|disable>`: toggle Brave Search. Enabling asks for a Brave key if none is stored.
- `/grok-config secret field:<deepseek|brave>`: validate and rotate one stored provider key.
- `/grok-config reset`: require confirmation, erase both encrypted provider keys and access lists, and immediately disable the bot for that server until setup is run again.

The automatic setup panel is posted when the server is not configured (including through legacy fallback) and has no recorded panel channel or message ID. If it cannot be posted, an Administrator can still run `/grok-config setup` in any channel where the registered command is available.

## Channel And Role Access Rules

The bot rejects DMs, bot messages, webhook messages, unconfigured servers, and messages whose server configuration cannot be loaded. For configured servers, access is evaluated before messages are added to conversations, profiles, idle-chatter state, or command handling.

Precedence is fail-closed:

1. An ignored channel denies access. For a thread, both the thread ID and its parent channel ID are checked.
2. If the allowed-channel list is nonempty, either the current channel or its thread parent must be allowed. An empty allowed-channel list allows all channels not ignored.
3. Any ignored role denies access.
4. If the allowed-role list is nonempty, the member must have at least one allowed role. An empty allowed-role list allows all roles not ignored.
5. If role restrictions exist but member-role data is unavailable, access is denied.

An ignore entry therefore wins over an allow entry. A thread inherits both allowed and ignored decisions from its parent, while a thread-specific ignore also denies that thread.

To copy Discord IDs, enable Developer Mode under Discord User Settings > Advanced, then right-click a server, channel, role, or user and choose Copy ID.

## Configuration Storage, Encryption, And Backups

Per-server configuration is stored at `GUILD_CONFIG_PATH`, which defaults to `./data/guild-config.json`. The `data/` directory and `.env` files are gitignored. Writes use a same-directory temporary file followed by rename; temporary files are created with restrictive permissions where the operating system supports them.

The JSON store is single-process only. Do not point multiple bot processes, shards, or overlapping deployments at the same `GUILD_CONFIG_PATH`; each process keeps an in-memory document and concurrent writers can overwrite one another's guild updates. Use one writer process or replace the file store with a transactional shared datastore.

The rename protects readers from partial JSON, but it is not a power-loss durability guarantee on Windows. The temporary file is flushed before replacement, yet an abrupt host or storage failure can still restore the previous directory entry after the bot reported success. Keep backups and avoid treating an acknowledged write as equivalent to durable transactional storage.

DeepSeek and Brave keys are encrypted independently with AES-256-GCM using `GUILD_CONFIG_MASTER_KEY`, the server ID, and provider field as authenticated context. The JSON file still contains non-secret metadata in plaintext, including server IDs, access-list IDs, setup-panel IDs, timestamps, revision data, and whether web search is enabled.

Back up both of these together:

1. The file at `GUILD_CONFIG_PATH`.
2. The exact `GUILD_CONFIG_MASTER_KEY` and `GUILD_CONFIG_MASTER_KEY_ID` stored securely outside the repository.

A data backup without the matching master key cannot restore provider credentials. A master key without the data file cannot restore server configuration. Stop writes or take an application-consistent copy when backing up the JSON file.

`/grok-config reset` writes a persistent unconfigured tombstone rather than deleting the server record. It removes the stored provider ciphertext and access lists and prevents legacy environment fallback from silently reactivating that server. The recorded onboarding panel metadata remains, so reset does not automatically post a second setup panel; use `/grok-config setup` to configure the server again.

## Legacy Environment Fallback

Legacy fallback is disabled unless `ALLOW_LEGACY_GUILD_CONFIG=true`. When enabled, a server with **no stored record** can use the shared `DEEPSEEK_API_KEY`, legacy channel lists, and optional Brave settings from `.env`.

This fallback is deployment-wide, not per-server, and gives every eligible server the same provider credentials. It exists only for explicit migration compatibility. A stored configuration takes precedence, and a reset tombstone also takes precedence, so fallback cannot override either one. Migrate each server through `/grok-config setup`, confirm `/grok-config status` reports `stored`, then disable and remove legacy secrets.

## Privacy And Data Disclosure

Operators should disclose the following to server members before enabling the bot:

- The bot receives Discord message content and author/channel/server metadata for messages that pass the configured access rules.
- Allowed messages can be retained temporarily in process memory for channel conversation context, monthly per-user word/phrase summaries, commands, and idle chatter. This in-memory state clears on restart.
- When a user invokes an AI response, the current request, requester attribution labels, and up to 20 recent messages from that server/channel conversation may be sent to DeepSeek. Other allowed participants' recent messages can therefore appear as untrusted context in that provider request.
- When Brave Search is enabled and a request explicitly asks for web search or appears freshness-sensitive, a redacted query derived from the request is sent to Brave Search; returned snippets and URLs may then be sent to DeepSeek with the AI request.
- During setup or secret rotation, entered API keys are sent to the corresponding provider for validation before they are encrypted and saved locally.
- Provider keys are stored encrypted, but server IDs, channel/role IDs, setup metadata, timestamps, and feature flags in the guild configuration file are not secret-encrypted.
- DeepSeek, Brave, Discord, and the host operator may retain or process data under their own policies. This project does not control those external retention policies.

Configure ignored channels and roles for private or sensitive areas. Do not allow channels whose content should never be processed or sent to external providers.

## Commands

- `grok <message>`: ask the bot anything; `grok` must be first.
- `@bot <message>`: ask by directly mentioning the bot.
- `grok lore`: summarize the current channel's local running context.
- `grok stats`: show your top monthly words and short phrases.
- `grok who is @user`: show a local monthly summary for a mentioned user.
- `grok new`: reset the current server/channel conversation.
- `!grok help`: show the Discord text-command menu.
- `!ping`: reply with `Pong!`.
- `!blud`, `!blud off`, `!blud <text>`: control blud mode or translate text.
- `!funmute @member [1 to 3]`: apply a very short timeout for moderators.
- `!ratio`: use as a reply to another message; requires Add Reactions and Manage Messages.
- `/grok-config ...`: Administrator-only persistent server setup and administration described above.

All text commands are subject to the same server channel and role access policy.

## Install, Run, And Verify

```bash
npm install
npm run check
npm test
npm start
```

`npm run check` runs `node scripts/check-syntax.js`. `npm test` runs Node's built-in test runner. `npm start` runs `node index.js` and does not register slash commands.

## Troubleshooting

- `Missing DISCORD_TOKEN in your environment.`: set `DISCORD_TOKEN` in `.env`.
- `GUILD_CONFIG_MASTER_KEY is required` or invalid-base64 errors: generate and set a base64 32-byte master key as shown above. Do not replace an existing production key unless you intentionally plan to reconfigure every server.
- `/grok-config` is missing: invite with `applications.commands`, verify `DISCORD_APPLICATION_ID`, and manually run `npm run register-commands`. Global registration can take time to propagate.
- No setup panel appeared: make sure the bot can View Channel and Send Messages in the system channel or another text-based channel, then use `/grok-config setup` manually.
- The bot is online but ignores a channel or user: inspect `/grok-config status` and the access precedence above, including a thread's parent channel and ignored roles.
- Setup or key rotation fails: the bot validates credentials against the provider; check the key, provider account, and network access. DeepSeek validation uses `DEEPSEEK_TIMEOUT_MS`; Brave validation uses a fixed five-second timeout.
- DeepSeek times out or rejects requests: check `DEEPSEEK_TIMEOUT_MS`, model/base URL, account balance, provider limits, and the bot's per-server/per-user request limits.
- Web search is disabled or incomplete: an Administrator should set a Brave key with `/grok-config secret field:brave` or enable it with `/grok-config web action:enable`.
- Stored secrets stop decrypting: restore the matching data file, master key, and key ID backup. Otherwise reset and configure the affected servers again.
- `!ratio` fails: check View Channel, Read Message History, Send Messages, Add Reactions, and Manage Messages.
- `!funmute` fails: check Moderate Members and role hierarchy for both the requester and bot.

## Project Structure

- `index.js`: loads `.env`, exposes the public API, and starts the bot when run directly.
- `scripts/register-commands.js`: manually registers `/grok-config` globally or to one guild.
- `src/events/bot.js`: creates dependencies, wires events, and logs in.
- `src/events/ready.js`: sets presence, reconciles first-run setup panels, and starts idle chatter.
- `src/interactions/`: slash-command definitions and Administrator-only guild setup handlers.
- `src/config/env.js`: deployment environment parsing.
- `src/config/guildConfigSchema.js`: persistent document schema and normalization.
- `src/services/guildConfigService.js`: stored configuration, legacy fallback, and runtime provider resolution.
- `src/security/secretCipher.js`: AES-256-GCM provider-key encryption.
- `src/storage/guildConfigStore.js`: JSON loading and atomic persistence.
- `src/discord/accessPolicy.js`: channel, thread-parent, and role access precedence.
- `src/services/requestGate.js`: in-memory per-server and per-user AI limits.
- `src/services/deepseek.js` and `src/services/webSearch.js`: provider requests, timeouts, sanitization, and safe errors.
- `src/state/`: guild-scoped in-memory conversations, profiles, idle chatter, and command state.
- `test/`: regression and focused configuration, access, interaction, provider, and encryption tests.

## Safety Notes For Contributors

Keep `.env`, provider keys, the master key, and runtime data out of commits. Preserve the manual command-registration boundary: startup must not register or overwrite application commands. Prompt, help, formatting, presence, and interaction text may have exact tests, so update tests when intentional wording changes require it.
