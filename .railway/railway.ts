import { defineRailway, github, project, service, volume } from "railway/iac";

// Other repositories in this project export their own partial, so this file
// must declare only this repository's resources.
export const partial = "rijksmuseum-mcp-plus";

export default defineRailway(() => {
  const rijksmuseumMcpPlusVolume = volume("rijksmuseum-mcp-plus-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 10000 });
  const rijksmuseumMcpPlus = service("rijksmuseum-mcp-plus", {
    source: github("kintopp/rijksmuseum-mcp-plus", { branch: "main", checkSuites: false }),
    build: { buildCommand: "npm run build", buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["src/**", "apps/**", "package.json", "package-lock.json", "tsconfig.json"] },
    start: "node dist/index.js",
    healthcheck: "/health",
    healthcheckTimeout: 360,
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { limitOverride: { containers: { cpu: 24, memoryBytes: 5000000000 } }, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3 },
    volumeMounts: { "/data": rijksmuseumMcpPlusVolume },
  });

  return project("endearing-warmth", {
    variables: { managed: false },
    resources: [rijksmuseumMcpPlus, rijksmuseumMcpPlusVolume],
  });
});
