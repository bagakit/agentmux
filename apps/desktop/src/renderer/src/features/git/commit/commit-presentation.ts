import type { GitBranchChange } from '../../../../../shared/git-contracts'

export function presentCommitMessage(message: string) {
  const separator = message.indexOf('\n')
  const firstLine = (separator < 0 ? message : message.slice(0, separator)).replace(/\r$/, '')
  const body = separator < 0 ? '' : message.slice(separator + 1)
  const conventional = /^([a-z][a-z0-9-]*)(?:\(([^\s()]+)\))?(!)?: (\S.*)$/u.exec(firstLine)
  return {
    heading: conventional?.[4] ?? firstLine,
    body,
    type: conventional?.[1] ?? null,
    scope: conventional?.[2] ?? null,
    breaking: Boolean(conventional?.[3])
  }
}

export function commitAuthorInitials(author: string) {
  const words = author.trim().split(/\s+/u)
  const first = Array.from(words[0] ?? '').slice(0, words.length > 1 ? 1 : 2).join('')
  const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0] ?? '' : ''
  return (first + last).toUpperCase() || '?'
}

export function summarizeCommitChanges(entries: readonly GitBranchChange[]) {
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, 'type-changed': 0 }
  for (const entry of entries) counts[entry.change] += 1
  const kinds = ['added', 'modified', 'deleted', 'renamed', 'type-changed'] as const
  return kinds.map(change => ({ change, count: counts[change] })).filter(summary => summary.count > 0)
}
