const githubPagesMatch = window.location.hostname.match(/^([^.]+)\.github\.io$/i);
const repositoryName = window.location.pathname.split("/").filter(Boolean)[0];
const inferredActionsUrl = githubPagesMatch && repositoryName
  ? `https://github.com/${githubPagesMatch[1]}/${repositoryName}/actions/workflows/scan-and-deploy.yml`
  : "";

window.MEGABIG_APP_CONFIG = {
  dataUrl: "./data/latest.json",
  actionsUrl: inferredActionsUrl,
  staleAfterMinutes: 300
};
