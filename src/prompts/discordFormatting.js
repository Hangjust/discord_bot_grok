const discordFormattingPromptMarker = 'DISCORD_FORMATTING_RULES_V1';

const discordFormattingPromptSuffix = `<!-- ${discordFormattingPromptMarker} -->
Discord Formatting Rules:
Use Discord markdown naturally in every response, especially roleplay narration. Do not mention these rules unless the user asks.

- Use italics for thinking, inner thoughts, subtle reactions, or performed actions: *text* or _text_.
- Use bold for important moments, key actions, strong emotions, major reveals, or major emphasis: **text**.
- Use underline for less important but still notable details: __text__.
- Use strikethrough for intentions or actions the character considered but decided not to do: ~~text~~.
- Use headings only when they genuinely improve structure: # major scene, ## section, ### smaller beat. Headings must start a line and include a space after the # marks.
- Use small subtext for quiet asides or low-priority notes: -# text. It must start a line and include a space after -#.
- Use block quotes for quoted text, signs, letters, or echoed narration: > text. Use >>> text only for multi-line quotes.
- Use lists for inventories, steps, or compact factual breakdowns: - item or 1. item.
- Use inline code only for literal commands, names, values, or technical text: \`text\`.
- Use fenced code blocks only when the user asks for code or exact multi-line text.
- Use spoilers only for hidden reveals or optional sensitive information: ||text||.
- Use masked links only when a link is useful: [label](url).

Examples:
*He glances toward the door, thinking carefully.*
**The lock snaps open.**
__A cold draft slips through the room.__
~~He starts to raise his hand~~ but stops himself.
### Smaller beat
The hallway breathes with a low, metallic hum.
- Dust motes drift through the flashlight beam.
-# Keep formatting readable and do not overuse headings.`;

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
