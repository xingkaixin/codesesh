/**
 * What a project identity is, independent of how it is discovered or displayed.
 *
 * The same facts used to be restated in five places: the kind union here, a kind
 * Set and `kind:key` encoding in the Node resolver, another `getProjectIdentityKey`
 * in the session index, a private group key in analytics, and a third copy in the
 * web adapter. Adding a kind meant editing all of them, and nothing failed if one
 * was missed.
 *
 * This module owns the closed set, the identity key, and identity comparison.
 * Discovering identities from the filesystem lives in `projects/identity.ts`;
 * encoding them into URLs lives in the web adapter. Both sit outside this one.
 */

/**
 * Every kind of project identity, most specific first. The order is documentation,
 * not behavior. These values appear in SQLite rows and API responses, so they
 * cannot be renamed without a migration.
 */
export const PROJECT_IDENTITY_KINDS = [
  "git_remote",
  "git_common_dir",
  "manifest_path",
  "synthetic",
  "path",
  "loose",
] as const;

export type ProjectIdentityKind = (typeof PROJECT_IDENTITY_KINDS)[number];

export interface ProjectIdentityRef {
  kind: ProjectIdentityKind;
  key: string;
}

const KIND_LOOKUP = new Set<string>(PROJECT_IDENTITY_KINDS);

export function isProjectIdentityKind(value: string): value is ProjectIdentityKind {
  return KIND_LOOKUP.has(value);
}

/**
 * Stable key for grouping and lookup. This is not a URL: route encoding is a
 * separate adapter, and conflating the two would put an escaped key in storage.
 */
export function getProjectIdentityKey(identity: ProjectIdentityRef): string {
  return `${identity.kind}:${identity.key}`;
}

export function matchesProjectIdentity(
  identity: ProjectIdentityRef | null | undefined,
  expected: ProjectIdentityRef,
): boolean {
  return identity?.kind === expected.kind && identity.key === expected.key;
}

/** Key for one agent's slice of a project. */
export function getProjectAgentKey(projectIdentityKey: string, agentName: string): string {
  return `${projectIdentityKey}\0${agentName.toLowerCase()}`;
}
