function logRoleplayError(operation, error, context = {}) {
  console.error(operation, {
    name: error?.name,
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined,
    code: typeof error?.code === 'string' ? error.code : undefined,
    guildId: context.guildId,
    channelId: context.channelId,
  });
}

module.exports = { logRoleplayError };
