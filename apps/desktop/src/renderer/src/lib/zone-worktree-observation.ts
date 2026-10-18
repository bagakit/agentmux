import type { AgentMuxZoneFact } from '@agentmux/core/control'
import type { GitDirectoryObservation, GitWorktreeEntry, GitWorktreesResult } from '@agentmux/git/types'

type Ready = Extract<GitWorktreesResult, { kind: 'ready' }>
export function worktreeAtPath(entry: GitWorktreeEntry, path: string): boolean {
  return entry.path === path || entry.aliases.includes(path)
}
export function worktreeZones(entry: GitWorktreeEntry, hostId: string, zones: readonly AgentMuxZoneFact[]) {
  return zones.filter(zone => zone.kind !== 'unknown' && zone.hostId === hostId && zone.directoryPath !== null && worktreeAtPath(entry, zone.directoryPath))
}
export function unrepresentedWorktrees(snapshot: Ready, zones: readonly AgentMuxZoneFact[], directories: readonly GitDirectoryObservation[]): number | null {
  if (snapshot.warnings.length) return null
  // An unresolved saved resource may be an alias of a native directory. Do not invent an exact difference.
  if (zones.some(zone => zone.kind === 'unknown' || zone.hostId === null || zone.directoryPath === null ||
    (zone.hostId === snapshot.hostId && !snapshot.worktrees.some(entry => worktreeAtPath(entry, zone.directoryPath!)) &&
      !directories.some(value => value.path === zone.directoryPath && value.kind !== 'unavailable')))) return null
  return snapshot.worktrees.filter(entry => worktreeZones(entry, snapshot.hostId, zones).length === 0).length
}
export function directoryStatus(directory: GitDirectoryObservation | undefined): string | null {
  return directory?.kind === 'missing' ? 'Directory not found' : directory?.kind === 'not-directory' ? 'Not a directory'
    : directory?.kind === 'unavailable' ? 'Directory check unavailable' : null
}
export function worktreeKind(entry: GitWorktreeEntry): string {
  return entry.kind === 'main' ? 'Main worktree' : entry.kind === 'bare' ? 'Bare repository' : 'Worktree'
}
