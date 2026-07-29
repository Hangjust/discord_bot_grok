# Discord AI commands and server setup

This guide covers global command registration, text triggers, API credentials,
access policy, and server/channel prompt documents.

## Registering commands

The bot owns exactly two global application commands:

- `/ai-help`
- `/ai-setup`

On every successful Discord `ready` event, the bot upserts those commands by
name in a stable order. This is non-destructive: it does not bulk-replace the
application command list, remove stale commands, or modify unrelated commands
owned by the same Discord application.

The same upsert can be run manually:

```sh
npm run register-commands
```

Manual registration requires `DISCORD_TOKEN` and a numeric
`DISCORD_APPLICATION_ID`. It uses a bot token, never a user token. The bot also
compares the configured application ID with the application authenticated by
the token at startup and logs a secret-free mismatch diagnostic.

Global commands propagate asynchronously. After registration, refresh Discord
if the command picker is stale. If commands are still missing, confirm:

- The token and application ID belong to the same application.
- That exact bot application is installed in the server.
- The install includes the `applications.commands` and `bot` scopes.
- Member and channel integration permissions do not hide commands.
- `npm run smoke-commands` reports both owned definitions as matching.

The smoke check performs only a global-command `GET`. It reports missing or
mismatched owned commands without printing the token, and never creates,
updates, or deletes commands.

## Help and text invocation

Type exactly `help`, `<trigger> help`, `!AI-help`, or `/ai-help`. Matching for
the exclamation-mark alias is case-insensitive but otherwise exact. Help is
available to every server member and does not depend on AI channel or role
access policy. Text help posts embeds in the channel; slash help replies
privately. Slash help is unavailable in direct messages.

The default trigger is `AI`, so normal requests look like `AI explain this`.
Trigger matching is case-insensitive, starts at the beginning of the message,
and requires a word boundary. Mentioning the bot also works. Administrators can
change the trigger, for example:

```text
/ai-setup trigger value:llm
```

After that change, `llm explain this` and `llm help` work. `!AI-help` remains
the fixed help alias.

All help paths use the same compact two-embed guide: the AI Command Center and
a short administrator setup card. AI help requires Manage Messages permission.
Configuration changes remain administrator-only.

## Long-term member memory

The bot archives every permitted user message and each AI reply in
`USER_MEMORY_PATH` (default `./data/user-memory.ndjson`). Memory is isolated by
server and attributed by stable Discord user ID, so display-name changes do not
merge people and two users are never treated as one speaker. Channels and
threads in the same server share this memory.

For each AI request, only the current member and other members relevant by
Discord mention or remembered name are retrieved. Recent and query-relevant
excerpts are sent to the configured AI provider as explicitly untrusted context. Repeated humor
or rude-to-bot wording may be summarized as heuristic behavior signals, never
as verified personal facts.

`AI new` resets only the short-lived exact-channel conversation. It does not
erase the long-term transcript. Protect and back up `USER_MEMORY_PATH` as
sensitive user data; the file is runtime data excluded from Git.

## `/ai-setup`

`/ai-setup` is server-only. `/ai-setup status` requires Manage Messages;
every configuration-changing subcommand requires Administrator:

```text
/ai-setup status
/ai-setup api provider:deepseek|gemma4 [web-search:true|false]
/ai-setup channel action:allow|ignore|remove channel:<channel>
/ai-setup role action:allow|ignore|remove role:<role>
/ai-setup web action:enable|disable
/ai-setup prompt action:status|set|export|clear scope:server|channel [channel] [text|file]
/ai-setup trigger value:<1-24 ASCII letters, numbers, "_" or "-">
/ai-setup reset
!AI name <new name>
!AI pfp
!AI pfp reset
```

- `status` privately shows safe booleans, counts, and configuration sources.
- `api` opens a private modal for either a DeepSeek key or a Gemini API key.
  Selecting `gemma4` routes this server to Google's `gemma-4-26b-a4b-it`
  model through the Gemini API. Selecting web search also requests a Brave
  Search key. Keys are validated and encrypted at rest.
- `channel` and `role` maintain mutually exclusive allow and ignore lists.
- `web` enables or disables Brave web search.
- `prompt` manages server or exact-channel behavior using direct text, a private
  modal, or a Markdown attachment.
- `trigger` changes the text call word without exposing provider settings.
- `!AI name <new name>` changes the bot nickname only in the current server.
- `!AI pfp` changes the bot avatar only in the current server when exactly one
  PNG, JPEG, WebP, or GIF is attached. The image may be at most 6 MiB.
- `!AI pfp reset` removes the server-specific avatar and restores the bot's
  normal global profile picture in that server.
  Both server-profile commands are restricted to the server owner or members
  with Discord Administrator permission. The stable `!AI` prefix still works
  if the normal chat trigger is customized.
- `reset` requires confirmation and clears credentials, access lists, custom
  prompts, and the custom trigger. The trigger returns to `AI`.

## Prompt operations and precedence

Prompt actions are `status`, `set`, `export`, and `clear`. Select `server` or
`channel` scope. An omitted channel target defaults to the current channel.
Explicit targets may be server text channels, announcement channels, or
threads. A thread is an exact channel distinct from its parent.

The effective behavior is selected, not concatenated:

1. An exact-channel document, when present.
2. The server document, when present.
3. The built-in behavior.

`status` reports metadata without revealing behavior text. `set` accepts either
direct Markdown text, a Markdown attachment, or private modal input. `export`
privately downloads the effective behavior as `AGENTS.md`. `clear` removes only
the selected scope.

Administrator behavior replaces the configurable persona and style section. It
cannot disable immutable truthfulness, safety, protected-class, harm,
harassment, mention-blocking, requester/context isolation, web-context,
attribution, or Discord-formatting rules.

## Input and storage rules

- Content is trimmed only at its outer boundary; internal Markdown and spacing
  are preserved.
- Normalized content must be non-empty and at most 4,000 characters.
- An upload must have a case-insensitive `.md` filename, use a secure Discord
  attachment URL, contain strict UTF-8, and be at most 64 KiB.
- Redirects, invalid URLs, invalid UTF-8, timeouts, failed downloads, empty
  files, and oversized content are rejected before configuration changes.
- `text` and `file` are mutually exclusive. Supplying neither opens the modal.
- Submitted behavior is stored as text and is not logged.

Setting identical normalized content and clearing an absent document are
no-ops. A real channel change invalidates only that exact channel conversation.
A real server change invalidates channels that use server or built-in behavior;
exact-channel overrides remain intact.

## Schema-v4 migration and recovery

At startup, older configuration is normalized to schema v4. Schema v2 added
prompt documents; schema v3 added the configurable trigger and audit metadata;
schema v4 adds the encrypted Gemini key and active AI-provider selection.
Existing encrypted DeepSeek credentials, prompts, access policy, onboarding
state, tombstones, timestamps, revisions, and unrelated guild metadata are
preserved.

Migration writes a complete temporary document and atomically renames it before
publishing migrated state in memory. If writing fails, the original file is
unchanged and a later initialization can retry.

Before a production upgrade:

1. Stop every process that writes guild configuration.
2. Back up `GUILD_CONFIG_PATH` (default `./data/guild-config.json`) and protect
   it as a secret.
3. Start one bot process and review its logs.
4. Register commands, allow propagation, and run `npm run smoke-commands`.

If migration fails, keep the bot stopped and preserve the original file. Fix
filesystem permissions or space, then retry. Newer-than-supported or malformed
schemas are rejected instead of guessed at.
