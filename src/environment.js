function buildEnvironmentConfig() {
  return {
    workingDir: process.cwd(),
    date: new Date().toISOString(),
    environment: `Node.js ${process.version} on ${process.platform}`,
    structure: [],
    isGitRepo: false,
    currentBranch: '',
    mainBranch: '',
    gitStatus: '',
    recentCommits: [],
  };
}

module.exports = {
  buildEnvironmentConfig,
};
