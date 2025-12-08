// Root site manifest (kind 15128) - replaceable event with NO d tag
// Used for the root site at: <npub>.nsite-host.com
export const NSITE_ROOT_SITE_KIND = 15128 as number;

// Identifier-specific site manifest (kind 35128) - addressable event WITH d tag
// Used for identifier sites at: <identifier>.<npub>.nsite-host.com
export const NSITE_MANIFEST_KIND = 35128 as number;

// Legacy individual file events (kind 34128) - deprecated, kept for backward compatibility
export const NSITE_FILE_KIND = 34128 as number;
