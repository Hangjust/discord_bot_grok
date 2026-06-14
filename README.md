# Discord Bot

This repository contains a CommonJS Node.js Discord bot built with `discord.js`. The bot presents itself as a Grok-style chat/fact-checking bot for a specific server: it watches allowed channels, keeps short in-memory conversation context, and responds to `grok` prompts or direct mentions.

The bot also includes several server gag/utility commands, including goblin/blud text translators, a very short timeout command, ratio reactions, lightweight local lore, monthly user word/phrase summaries, and isolated roleplay ticket sessions.

## Main Features

- `grok <message>` or `@bot <message>`: ask the bot to answer or fact-check using DeepSeek.
- `grok lore`, `grok stats`, and `grok who is @user`: summarize local in-memory channel/user context.
- `grok new`: reset the current channel conversation.
- `!grok help`: show the Discord-facing command menu.
- `!ping`: quick health check.
- `!nn <text>` or reply with `!nn`: translate text into goblin mode.
- `!blud`, `!blud off`, `!blud <text>`: enable, disable, or translate with blud mode.
- `!funmute @member [1-3]`: moderator-only gag timeout for 1 to 3 seconds.
- `!ratio`: react to a referenced message for ratio behavior.
- `!roleplay panel` or `!rp`: post a simple roleplay panel with an `Open RP` button. The button privately asks the user to choose Fantasy, Naughty, Dark/Humor, or Custom. Presets ask for the person name plus optional extra context like scenery, vibe, or situation; Custom asks for the custom prompt, Improved AI yes/no, and Cozy/Adventure/Dramatic level before creating a private ticket channel. Tickets echo the chosen setup in a `text` code block before narration starts; presets only show name and added context, while Custom also shows the custom idea, Improved AI choice, and RP level. When Improved AI is enabled, the generated prompt is echoed in a `text` code block before the bot continues with the scene. When model credentials are configured, the narrator studies `roleplay/reference.md` as structure-only inspiration, derives a fresh private guide for the selected setup, and sends the first scene message automatically.
- `!roleplay close`: close the current roleplay ticket from inside that ticket.

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file with the Discord and model credentials:

```bash
DISCORD_TOKEN=your_discord_bot_token
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

Run the bot:

```bash
npm start
```

## Development Commands

```bash
npm run check
npm test
```

`npm run check` runs Node syntax checks over `index.js`, `scripts`, `src`, and `test`. `npm test` runs the built-in Node test suite.

## Project Map For Agents

- `index.js`: loads `.env`, exports the public API, and starts the bot when run directly.
- `src/publicApi.js`: central export surface used by tests and external callers.
- `src/events/bot.js`: creates the Discord client, wires events, and logs in with `DISCORD_TOKEN`.
- `src/events/messageCreate.js`: main message router for commands, Grok prompts, roleplay ticket handling, conversation memory, and replies.
- `src/events/interactionCreate.js`: Discord component interaction router for roleplay buttons, modals, and close buttons.
- `src/config/constants.js`: channel allow/block lists, command names, rate limits, profile limits, and fixed prompt text.
- `src/config/env.js`: environment variable reads for Discord and DeepSeek.
- `src/services/deepseek.js`: Grok/normal DeepSeek payload construction, API call, and error handling.
- `src/roleplay/*`: isolated roleplay ticket config, interactions, sessions, tickets, roleplay rate limits, safe replies, and roleplay-only DeepSeek payloads.
- `src/services/webSearch.js`: web-search helper/service code for safe query building, result normalization, and source formatting.
- `src/state/*`: in-memory conversation, user profile, idle chatter, and rate-limit state.
- `src/grok/*`: Grok trigger parsing, lore/profile replies, and mention text building.
- `src/commands/*`: individual command parsers and handlers.
- `test/index.test.js`: regression tests for public behavior.

## Agent Notes

- The bot stores runtime state in memory only; restarting the process clears conversations, roleplay ticket/session state, monthly profile counters, rate limits, and idle chatter state.
- Replies are restricted by channel IDs in `src/config/constants.js`. Roleplay tickets use their own local reply helpers after ticket recognition.
- Keep secrets out of code. Use `.env` for `DISCORD_TOKEN` and `DEEPSEEK_API_KEY`.
- The project uses CommonJS modules and the built-in Node test runner. Match the existing style unless the user asks for a broader refactor.
- Prefer changing command-specific files in `src/commands`, service-specific files in `src/services`, or roleplay-specific files in `src/roleplay` before editing the large message router.
