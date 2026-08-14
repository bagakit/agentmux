import { join, normalize as normalizeLocalPath, posix } from 'node:path'
import type { AppConfig, WorkspaceRecord } from '../shared/contracts.js'

/**
 * The single definition of "same physical location" for a Workspace. The schema's uniqueness refinement
 * and every write path that appends to `config.workspaces` derive their key from HERE, so the caller's
 * "already registered?" check and the schema's invariant can never disagree about which spellings of a
 * path are the same place — which is exactly how a picked-folder append reached a `save()` the schema
 * then rejected, throwing a raw zod issue array in the user's face.
 *
 * The host id is part of the key: the same path on two different hosts is two different locations. Local
 * paths are normalized with the OS normalizer, every other host is a remote POSIX path, and `join(p, '.')`
 * collapses a trailing slash the way `normalize` alone does not (`/repo/` and `/repo` are one place).
 * `hostId === 'local'` is the local-machine discriminator the rest of the main process already uses
 * (`withScratchWorkspace`, the worktree service, the appearance handler), and the schema pins
 * `id 'local' ⟺ kind 'local'` for the required local host.
 */
export function workspaceLocationKey(hostId: string, path: string): string {
  const normalized = hostId === 'local'
    ? normalizeLocalPath(join(path, '.'))
    : posix.normalize(posix.join(path, '.'))
  return `${hostId}\0${normalized}`
}

/** The record already registered at that location, or `undefined`. */
export function findWorkspaceByLocation(
  workspaces: readonly WorkspaceRecord[],
  hostId: string,
  path: string
): WorkspaceRecord | undefined {
  const key = workspaceLocationKey(hostId, path)
  return workspaces.find((item) => workspaceLocationKey(item.hostId, item.path) === key)
}

/**
 * Append `record` unless its location is already taken, returning the config to persist and the record
 * that now lives there — the freshly inserted one, or the existing occupant. `inserted` tells the caller
 * whether anything changed, so picking a folder that is already registered is a no-op-with-feedback
 * (focus what is already there) rather than a `save()` the schema would reject.
 */
export function insertOrGetWorkspace(
  config: AppConfig,
  record: WorkspaceRecord
): { config: AppConfig; workspace: WorkspaceRecord; inserted: boolean } {
  const existing = findWorkspaceByLocation(config.workspaces, record.hostId, record.path)
  if (existing) return { config, workspace: existing, inserted: false }
  return {
    config: { ...config, workspaces: [...config.workspaces, record] },
    workspace: record,
    inserted: true
  }
}
