const fs = require('node:fs');
const path = require('node:path');
const { logRoleplayError } = require('./logging');

const roleplayReferencePath = path.join(__dirname, '..', '..', 'roleplay', 'reference.md');
let isRoleplayReferenceKnownMissing = false;

function loadRoleplayReferenceText() {
  if (isRoleplayReferenceKnownMissing) return '';

  try {
    return fs.readFileSync(roleplayReferencePath, 'utf8').trim();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      isRoleplayReferenceKnownMissing = true;
    } else {
      logRoleplayError('Roleplay reference guide could not be read.', error);
    }
    return '';
  }
}

function formatRoleplayReferenceForPrompt(referenceText) {
  return String(referenceText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\d+:\s*<user>:/i.test(line))
    .map((line) => line.replace(/^<name>:\s*/i, '').replace(/<scene>/gi, 'the scene').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim())
    .filter(Boolean)
    .join('\n');
}

function buildRoleplayReferenceGuidePrompt(referenceText = loadRoleplayReferenceText()) {
  const trimmedReference = formatRoleplayReferenceForPrompt(referenceText);
  if (!trimmedReference) {
    return [
      'REFERENCE-DERIVED ROLEPLAY GUIDE:',
      'No local roleplay reference file is available. Silently create a fresh private scene guide from the selected person, prompt, and level before narrating, then output only continuous story prose.',
      'END REFERENCE-DERIVED ROLEPLAY GUIDE.',
    ].join('\n');
  }

  return [
    'REFERENCE-DERIVED ROLEPLAY GUIDE:',
    'Study the full local roleplay reference below only to understand pacing, in-character answers, gentle scene beats, placeholder-aware narration, and lore consistency. The local reference is not an output format.',
    'Before each reply, silently create a NEW private reference guide for the selected person, selected prompt or mode, and selected level. Use that new guide for tone, opening, lore, and likely player questions, but never print the guide.',
    'Do not copy, quote, reuse, mention, or canonize Eldoria, Shadowfangs, the glade, or any exact wording from the local reference, even if the player asks for those exact things.',
    'The local reference is inspiration only. The actual scene must be newly generated from the roleplay metadata and custom prompt as continuous story prose, not labeled Q&A, fields, metadata, placeholders, or template sections.',
    '',
    'LOCAL ROLEPLAY REFERENCE FOR INSPIRATION ONLY:',
    trimmedReference,
    'END LOCAL ROLEPLAY REFERENCE FOR INSPIRATION ONLY.',
    'END REFERENCE-DERIVED ROLEPLAY GUIDE.',
  ].join('\n');
}

module.exports = { buildRoleplayReferenceGuidePrompt, formatRoleplayReferenceForPrompt, loadRoleplayReferenceText, roleplayReferencePath };
