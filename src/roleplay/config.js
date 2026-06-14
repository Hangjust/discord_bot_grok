const roleplayPanelCommand = '!roleplay panel';
const roleplayPanelAliasCommand = '!rp';
const roleplayCooldownCommand = '!roleplay cooldown';
const roleplayCloseCommand = '!roleplay close';
const roleplayTicketTopicPrefix = 'roleplay-ticket:';
const roleplaySessionHistoryLimit = 16;
const roleplayRateLimitWindows = Object.freeze([
  Object.freeze({ windowMs: 60 * 1000, max: 25 }),
  Object.freeze({ windowMs: 60 * 60 * 1000, max: 500 }),
  Object.freeze({ windowMs: 20 * 60 * 60 * 1000, max: 1500 }),
]);
const roleplayTicketMessageMax = 100;
const roleplayTicketCreationCooldownMs = 60 * 1000;
const roleplayDefaultLevelId = 'adventure';
const roleplayCustomPromptId = 'custom';
const roleplayTicketParentChannelId = '1512855341069635785';

const roleplayPrompts = Object.freeze([
  Object.freeze({ id: 'fantasy', label: 'Fantasy', description: 'Quest-driven fantasy with magic, lore, NPCs, and open-ended momentum.', instructions: 'Run an immersive fantasy roleplay with rich worldbuilding, quests, magic, factions, NPCs, props, consequences, and open-ended scene hooks. Keep the tone flexible: heroic, mysterious, playful, romantic, or tense when the scene calls for it. Treat the selected mode as a starting style, not a rigid cage. If the player naturally steers toward a compatible adult direction, follow the new direction smoothly while staying in bounds. Keep narration vivid but readable for Discord. Prefer concrete sensory detail, clear stakes, and scene-forward action. Let the player lead the pace, support player agency, and remember established lore and continuity. Do not force the scene back to the original mode when a compatible shift is happening.' }),
  Object.freeze({ id: 'naughty', label: 'Naughty', description: 'Flirty adult RP with tension, teasing, and fade-to-black.', instructions: 'Run an adult-only seductive roleplay with flirting, innuendo, chemistry, teasing, romantic tension, and fade-to-black intimacy. Keep the tone playful, confident, and reactive to the player. You may escalate into suggestive or NSFW-adjacent banter, but stay away from explicit erotica and do not narrate graphic sexual acts. Refuse or redirect if the user introduces minors, age ambiguity, coercion, non-consent, incest, bestiality, sexual violence, exploitation, real-person abuse, or targeted harassment. Never sexualize minors or age-ambiguous characters. Keep consent explicit, mutual, and ongoing. When the scene is best served by closing the door, do that cleanly and continue with aftermath, reactions, or a time skip instead of explicit detail. Treat this mode as a starting flavor that can soften into romance or sharpen into adult suggestiveness if the player steers there safely.' }),
  Object.freeze({ id: 'dark-humor', label: 'Dark/Humor', description: 'Morbid comedy, bleak absurdity, and twisted wit.', instructions: 'Run a dark comedy roleplay built on morbid absurdity, deadpan wit, grim jokes, bizarre coincidence, gallows humor, and bleak but playful atmosphere. The humor can be twisted, spooky, cynical, or outrageous, but it must not target protected groups, promote hatred, or become real-world harassment. Keep violence and horror stylized rather than graphic. Lean into unsettling punchlines, cosmic bad luck, cursed objects, overconfident fools, and ridiculous consequences. If the player pushes toward fantasy or adult banter that fits the joke, adapt naturally while preserving the dark-comedy voice. If the player crosses into hateful abuse or direct harassment, refuse that part and pivot back to non-targeted morbid humor or scene-building.' }),
]);

const roleplayLevels = Object.freeze([
  Object.freeze({ id: 'cozy', label: 'Cozy', description: 'Low stakes, guided, gentle pacing.', instructions: 'Use low stakes, warm tone, gentle scene openings, and forgiving outcomes.' }),
  Object.freeze({ id: 'adventure', label: 'Adventure', description: 'Balanced stakes, agency, and momentum.', instructions: 'Use medium stakes, active pacing, player agency, and occasional complications.' }),
  Object.freeze({ id: 'dramatic', label: 'Dramatic', description: 'Higher tension while staying Discord-safe.', instructions: 'Use high tension, cinematic obstacles, and stronger consequences while staying non-graphic and Discord-safe.' }),
]);

const roleplayCustomIds = Object.freeze({ openButton: 'roleplay:open', promptButtonPrefix: 'roleplay:prompt:', modalSubmitPrefix: 'roleplay:modal:', personNameInput: 'roleplay:person-name', promptInput: 'roleplay:prompt-input', improvedAiInput: 'roleplay:improved-ai-input', levelInput: 'roleplay:level-input', closeButton: 'roleplay:close' });

function getRoleplayPrompt(promptId) { return roleplayPrompts.find((prompt) => prompt.id === promptId) ?? null; }
function getRoleplayLevel(levelId) { return roleplayLevels.find((level) => level.id === levelId) ?? null; }
function isRoleplayPanelCommand(content) {
  const normalized = String(content ?? '').trim().toLowerCase();
  return normalized === roleplayPanelCommand || normalized === roleplayPanelAliasCommand;
}
function parseRoleplayCooldownCommand(content) {
  const normalized = String(content ?? '').trim().toLowerCase();
  if (normalized === roleplayCooldownCommand) return '';
  if (!normalized.startsWith(`${roleplayCooldownCommand} `)) return null;
  const status = normalized.slice(roleplayCooldownCommand.length).trim();
  if (status === 'on' || status === 'off') return status;
  return '';
}
function isRoleplayCloseCommand(content) { return String(content ?? '').trim().toLowerCase() === roleplayCloseCommand; }
function normalizeRoleplayPromptInput(input) {
  const promptText = String(input ?? '').trim().slice(0, 500);
  const normalized = promptText.toLowerCase();
  const prompt = roleplayPrompts.find((item) => item.id.toLowerCase() === normalized || item.label.toLowerCase() === normalized) ?? null;
  return { promptId: prompt?.id ?? roleplayCustomPromptId, promptText: prompt?.label ?? promptText };
}
function normalizeRoleplayLevelInput(input) {
  const normalized = String(input ?? '').trim().toLowerCase();
  return roleplayLevels.find((level) => level.id.toLowerCase() === normalized || level.label.toLowerCase() === normalized)?.id ?? null;
}
function normalizeRoleplayImprovedAiInput(input) {
  const normalized = String(input ?? '').trim().toLowerCase();
  return normalized === 'yes' || normalized === 'y' || normalized === 'true' || normalized === 'on' || normalized === 'improved';
}
function isValidRoleplaySetupPromptId(promptId) { return promptId === roleplayCustomPromptId || Boolean(getRoleplayPrompt(promptId)); }
function buildRoleplayPromptButtonCustomId(promptId) { return `${roleplayCustomIds.promptButtonPrefix}${promptId}`; }
function parseRoleplayPromptButtonCustomId(customId) {
  const value = String(customId ?? '');
  const promptId = value.startsWith(roleplayCustomIds.promptButtonPrefix) ? value.slice(roleplayCustomIds.promptButtonPrefix.length) : '';
  return isValidRoleplaySetupPromptId(promptId) ? promptId : '';
}
function buildRoleplayModalCustomId(promptId) { return `${roleplayCustomIds.modalSubmitPrefix}${promptId}`; }
function parseRoleplayModalCustomId(customId) {
  const value = String(customId ?? '');
  const promptId = value.startsWith(roleplayCustomIds.modalSubmitPrefix) ? value.slice(roleplayCustomIds.modalSubmitPrefix.length) : '';
  return isValidRoleplaySetupPromptId(promptId) ? promptId : '';
}

module.exports = { buildRoleplayModalCustomId, buildRoleplayPromptButtonCustomId, getRoleplayLevel, getRoleplayPrompt, isRoleplayCloseCommand, isRoleplayPanelCommand, isValidRoleplaySetupPromptId, normalizeRoleplayImprovedAiInput, normalizeRoleplayLevelInput, normalizeRoleplayPromptInput, parseRoleplayCooldownCommand, parseRoleplayModalCustomId, parseRoleplayPromptButtonCustomId, roleplayCloseCommand, roleplayCooldownCommand, roleplayCustomIds, roleplayCustomPromptId, roleplayDefaultLevelId, roleplayLevels, roleplayPanelAliasCommand, roleplayPanelCommand, roleplayPrompts, roleplayRateLimitWindows, roleplaySessionHistoryLimit, roleplayTicketCreationCooldownMs, roleplayTicketMessageMax, roleplayTicketParentChannelId, roleplayTicketTopicPrefix };
