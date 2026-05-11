export type NsiteDeployClient = {
  readonly name: string;
  readonly href: string;
};

export type NsiteDeployClientReference = {
  readonly tag: string;
  readonly name: string;
  readonly href?: string;
};

/**
 * Known nsite deploy clients keyed by the value published in the manifest
 * `client` tag. Add new client links here to make status pages link them.
 */
export const NSITE_DEPLOY_CLIENTS = new Map<string, NsiteDeployClient>([
  ["nsyte", { name: "nsyte", href: "https://nsyte.run" }],
]);

function normalizeClientTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function getNsiteDeployClientReference(
  clientTag: string | undefined,
): NsiteDeployClientReference | undefined {
  const tag = clientTag?.trim();
  if (!tag) return undefined;

  const client = NSITE_DEPLOY_CLIENTS.get(normalizeClientTag(tag));
  if (client) {
    return { tag, name: client.name, href: client.href };
  }

  return { tag, name: tag };
}
