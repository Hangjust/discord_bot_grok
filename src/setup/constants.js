const setupCustomIds = Object.freeze({
  personaOpen: 'setup:persona:open',
  personaModal: 'setup:persona:details',
  personaCharacter: 'setup:persona:character',
  personaBehavior: 'setup:persona:behavior',
  personaPrompt: 'setup:persona:prompt',
  personaTrigger: 'setup:persona:trigger',
  personaProfanity: 'setup:persona:profanity',
  personaStyle: 'setup:persona:style',
  personaFormat: 'setup:persona:format',
  personaSave: 'setup:persona:save',
  personaCancel: 'setup:persona:cancel',

  accessOpen: 'setup:access:open',
  accessChannels: 'setup:access:channels',
  accessRoles: 'setup:access:roles',
  accessBlockedRoles: 'setup:access:blocked-roles',
  accessSave: 'setup:access:save',
  accessCancel: 'setup:access:cancel',

  apiKeyOpen: 'setup:key:open',
  apiKeyPaste: 'setup:key:paste',
  apiKeyModal: 'setup:key:submit',
  apiKeyValue: 'setup:key:value',
  apiKeyRemove: 'setup:key:remove',

  advancedOpen: 'setup:advanced:open',
  advancedWebSearch: 'setup:advanced:web-search',
  advancedLength: 'setup:advanced:length',
  advancedContext: 'setup:advanced:context',
  advancedCooldown: 'setup:advanced:cooldown',
  advancedSave: 'setup:advanced:save',
  advancedCancel: 'setup:advanced:cancel',
});

const personaLimits = Object.freeze({
  characterNameMin: 1,
  characterNameMax: 80,
  behaviorMin: 100,
  behaviorMax: 1500,
  customPromptMax: 2000,
  triggerWordMin: 1,
  triggerWordMax: 32,
});

const setupDraftTtlMs = 15 * 60 * 1000;

module.exports = {
  personaLimits,
  setupCustomIds,
  setupDraftTtlMs,
};
