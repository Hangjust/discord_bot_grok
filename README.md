# Discord Bot

Join this Discord server to understand a little bit more about what the bot can do and if it fits your needs: https://discord.gg/3RV9edf5n3

A small CommonJS Node.js Discord bot built with `discord.js`. It listens in configured server channels, keeps short in memory context, and replies when someone starts a message with `grok` or directly mentions the bot.

The bot can answer through DeepSeek, keep local channel context, summarize local user activity, run a few text commands, and optionally search the web through Brave Search.

## What The Bot Does

1. Answers `grok <message>` prompts and direct `@bot <message>` mentions with DeepSeek.
2. Keeps short in memory conversation context per channel.
3. Reads non excluded server messages for local context and monthly word or phrase summaries.
4. Supports `grok lore`, `grok stats`, and `grok who is @user` from local memory.
5. Supports helper commands like `!ping`, `!blud`, `!funmute`, and `!ratio`.
6. Can use Brave web search for current or source based questions when web search is enabled.

Runtime state is memory only. Restarting the process clears conversation history, local profile counters, rate limits, and idle chatter state.

## Quick Start

1. Install dependencies.

```bash
npm install
```

2. Create a Discord app and bot in the Discord Developer Portal.
3. Enable the Message Content Intent for the bot.
4. Invite the bot to your server with the `bot` scope.
5. Create a `.env` file in the project root.
6. Add your Discord bot token and DeepSeek API key.
7. Put at least one channel ID in `DISCORD_REPLY_ALLOWED_CHANNEL_IDS`.
8. Start the bot.

```bash
npm start
```

When startup works, the process logs the Discord account it signed in as.

## Create And Configure The Discord App

1. Go to the Discord Developer Portal.
2. Create a new application.
3. Open the Bot page and add a bot user.
4. Copy the bot token and save it as `DISCORD_TOKEN` in `.env`.
5. On the Bot page, enable Message Content Intent. This project reads normal message text, so the bot needs that privileged intent.
6. Open OAuth2, then URL Generator.
7. Select the `bot` scope.
8. Select `applications.commands` only if you later add slash commands. This project does not define slash commands right now.
9. Give the bot the permissions it needs, then open the generated invite URL and add it to your server.

Discord intents used by the code are `Guilds`, `GuildMessages`, `GuildMessageReactions`, and `MessageContent`.

## Discord Permissions

Give the bot these server or channel permissions:

1. View Channels.
2. Send Messages.
3. Read Message History.
4. Add Reactions for `!ratio`.
5. Manage Messages for `!ratio`, because the command removes reactions from a referenced message.
6. Moderate Members for `!funmute`.

For `!funmute`, Discord role hierarchy also matters. The bot's highest role must be above the target member's highest role, and the requester must have permission to moderate the target.

## Environment Variables

Create `.env` in the project root. Use placeholder values like these, not real values from this README.

```env
DISCORD_TOKEN=your_discord_bot_token_here
DEEPSEEK_API_KEY=your_deepseek_api_key_here

DISCORD_READ_EXCLUDED_CHANNEL_IDS=
DISCORD_REPLY_ALLOWED_CHANNEL_IDS=123456789012345678,234567890123456789
PROTECTED_GLAZE_USER_IDS=

DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash

WEB_SEARCH_ENABLED=false
WEB_SEARCH_PROVIDER=brave
WEB_SEARCH_API_KEY=
WEB_SEARCH_MAX_RESULTS=3
WEB_SEARCH_TIMEOUT_MS=5000
```

`DISCORD_TOKEN` is required. It is the bot token from the Discord Developer Portal.

`DEEPSEEK_API_KEY` is required. The bot needs it before it can call DeepSeek for `grok` replies.

`DISCORD_READ_EXCLUDED_CHANNEL_IDS` is optional. Add a comma separated list of channel IDs the bot should ignore while reading passive context.

`DISCORD_REPLY_ALLOWED_CHANNEL_IDS` is optional by type, but important in normal use. Add a comma separated list of channel IDs where replies and idle chatter should work. If a channel is not listed, the bot may read it for context unless excluded, but it will not reply there.

`PROTECTED_GLAZE_USER_IDS` is optional. Add a comma separated list of user IDs that should be treated as protected by the prompt helper in `src/grok/mentions.js`.

`DEEPSEEK_BASE_URL` is optional. It defaults to `https://api.deepseek.com`.

`DEEPSEEK_MODEL` is optional. It defaults to `deepseek-v4-flash`.

`WEB_SEARCH_ENABLED` is optional. Set it to `true` to allow web search for current or source based requests.

`WEB_SEARCH_PROVIDER` is optional. The only supported provider in this codebase is `brave`.

`WEB_SEARCH_API_KEY` is optional until web search is enabled. Brave search requires `WEB_SEARCH_ENABLED=true` and a key in `WEB_SEARCH_API_KEY`.

`WEB_SEARCH_MAX_RESULTS` is optional. It defaults to `3` and is capped by the code.

`WEB_SEARCH_TIMEOUT_MS` is optional. It defaults to `5000`.

## How Channel And User IDs Work

Discord IDs are long numeric strings. The bot uses them to know where it can read, where it can reply, and which users need special handling.

1. Open Discord User Settings.
2. Go to Advanced.
3. Enable Developer Mode.
4. Right click a channel or user.
5. Click Copy ID.
6. Paste the ID into `.env`.

Use commas for more than one ID:

```env
DISCORD_REPLY_ALLOWED_CHANNEL_IDS=123456789012345678,234567890123456789
```

Do not include spaces unless you want to make the file harder to read. The code trims values, but clean lists are easier to maintain.

## Commands

`grok <message>` asks the bot anything. The word `grok` must be first.

`@bot <message>` asks by directly mentioning the bot.

`grok lore` summarizes the current channel's local running context.

`grok stats` shows your top monthly words and short phrases.

`grok who is @user` gives a local monthly summary for a mentioned user.

`grok new` resets the current channel conversation.

`!grok help` shows the Discord command menu.

`!ping` replies with `Pong!`.

`!blud` turns on blud mode for the channel conversation. `!blud off` turns it off. `!blud <text>` translates the text.

`!funmute @member [1 to 3]` applies a very short timeout for moderators. It needs Moderate Members permission and working role hierarchy.

`!ratio` works when used as a reply to another message. It needs Add Reactions and Manage Messages.

This project does not register slash commands.

## Change The Prompt Or Personality

The main edit points are small and direct.

`src/services/deepseek.js` contains the main persona or system prompt and the generation settings sent to DeepSeek, including model, max tokens, temperature, streaming, and thinking settings.

`src/prompts/discordFormatting.js` adds Discord formatting guidance to model responses.

`src/commands/help.js` contains the text shown by `!grok help`.

`src/config/constants.js` contains command names, fixed prompt text, fixed limits, channel and user ID parsing, and other constants.

`src/config/env.js` contains DeepSeek defaults such as `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL`.

After changing prompt, help, presence, or formatting text, expect tests to need updates if they assert exact wording or payload contents.

## Install And Run Locally

Install once:

```bash
npm install
```

Run the bot:

```bash
npm start
```

`npm start` runs `node index.js`. The entry file loads `.env`, imports the public API, and starts `startBot()` only when `index.js` is run directly.

## Development Checks

Run the syntax check:

```bash
npm run check
```

Run the test suite:

```bash
npm test
```

`npm run check` runs `node scripts/check-syntax.js`. `npm test` runs Node's built in test runner.

## Troubleshooting

If startup says `Missing DISCORD_TOKEN in your environment.`, add `DISCORD_TOKEN` to `.env` and restart the process.

If the bot says it needs `DEEPSEEK_API_KEY`, add `DEEPSEEK_API_KEY` to `.env` and restart the process.

If the bot is online but does not reply in a channel, add that channel ID to `DISCORD_REPLY_ALLOWED_CHANNEL_IDS`. Replies and idle chatter only work in allowed channels.

If the bot cannot see normal message text, enable Message Content Intent in the Discord Developer Portal and restart the bot.

If `!ratio` fails, check that the bot can view the channel, read message history, send messages, add reactions, and manage messages.

If `!funmute` fails, check Moderate Members permission and role hierarchy. The bot cannot time out members whose roles are above or equal to the bot's highest role.

If web search says it is disabled or missing a key, set `WEB_SEARCH_ENABLED=true`, keep `WEB_SEARCH_PROVIDER=brave`, add `WEB_SEARCH_API_KEY`, then restart the process.

If DeepSeek returns rate limit, billing, or request errors, check your DeepSeek account, model name, account balance, and prompt size.

## Project Structure

`index.js` loads `.env`, exports the public API, and starts the bot when run directly.

`src/publicApi.js` is the central export surface used by tests and outside callers.

`src/events/bot.js` creates and wires the bot events, then logs in with `DISCORD_TOKEN`.

`src/discord/client.js` creates the Discord client and declares the Gateway intents.

`src/events/messageCreate.js` routes normal messages, commands, mentions, context updates, and DeepSeek replies.

`src/events/ready.js` sets presence and starts idle chatter timers.

`src/config/env.js` reads Discord and DeepSeek environment variables.

`src/config/constants.js` stores channel lists, user lists, command names, limits, and fixed constants.

`src/services/deepseek.js` builds the DeepSeek payload, sends chat completion requests, and formats API failures.

`src/services/webSearch.js` handles Brave search config, safe query building, result cleanup, and source formatting.

`src/prompts/discordFormatting.js` adds Discord formatting guidance to the main prompt.

`src/commands/` contains individual command handlers.

`src/grok/` contains trigger parsing, mention text building, lore replies, and user summary replies.

`src/state/` contains in memory conversations, user profile summaries, idle chatter, and rate limit state.

`test/index.test.js` contains regression tests for public behavior.

## Safety Notes For Contributors

Keep secrets out of code and commits. Put local tokens and API keys in `.env` only.

Edit only the pieces you mean to change. Prompt, help, formatting, and presence text often have exact tests.

The current bot uses normal message commands. If you add slash commands later, you will need new command registration code and the `applications.commands` invite scope.
