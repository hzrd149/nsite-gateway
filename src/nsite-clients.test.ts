import {
  getNsiteDeployClientReference,
  NSITE_DEPLOY_CLIENTS,
} from "./nsite-clients.ts";

Deno.test("nsite deploy client map starts with nsyte", () => {
  const firstKey = [...NSITE_DEPLOY_CLIENTS.keys()][0];
  if (firstKey !== "nsyte") {
    throw new Error(`Expected first client to be nsyte, got ${firstKey}`);
  }

  const nsyte = NSITE_DEPLOY_CLIENTS.get("nsyte");
  if (nsyte?.href !== "https://nsyte.run") {
    throw new Error(`Expected nsyte href to be https://nsyte.run`);
  }
});

Deno.test("getNsiteDeployClientReference links known clients", () => {
  const client = getNsiteDeployClientReference("nsyte");
  if (
    client?.tag !== "nsyte" || client.name !== "nsyte" ||
    client.href !== "https://nsyte.run"
  ) {
    throw new Error(`Expected nsyte client reference with href`);
  }
});

Deno.test("getNsiteDeployClientReference preserves unknown client tags", () => {
  const client = getNsiteDeployClientReference(" custom-cli ");
  if (
    client?.tag !== "custom-cli" || client.name !== "custom-cli" ||
    client.href !== undefined
  ) {
    throw new Error(`Expected unknown client tag to be preserved without href`);
  }
});
