const discordFormattingPromptMarker = 'DISCORD_FORMATTING_RULES_V1';

const discordFormattingPromptSuffix = `<!-- ${discordFormattingPromptMarker} -->
Discord Formatting Rules:
Use Discord markdown sparingly and only when it makes the answer clearer. For short answers, prefer plain text and do not add headings, sections, decorative asides, or extra lines. Do not mention these rules unless the user asks.`;

function appendDiscordFormattingPrompt(promptText) {
  const text = String(promptText ?? '');

  if (text.includes(discordFormattingPromptMarker)) {
    return text;
  }

  return `${text}\n\n${discordFormattingPromptSuffix}`;
}

module.exports = {
  appendDiscordFormattingPrompt,
  discordFormattingPromptMarker,
  discordFormattingPromptSuffix,
};
