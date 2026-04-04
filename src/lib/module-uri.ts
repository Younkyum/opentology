/**
 * Shared module URI normalization — single source of truth for
 * converting file paths to urn:module: URIs.
 */

const SOURCE_EXT_RE = /\.[tj]sx?$/;

export function stripSourceExtension(filePath: string): string {
  return filePath.replace(SOURCE_EXT_RE, '');
}

export function normalizeModuleUri(filePath: string): string {
  return `urn:module:${stripSourceExtension(filePath)}`;
}
