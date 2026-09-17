import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import { deriveFocusProjectLanes, retainedWorktreeFacts } from '../src/renderer/src/lib/focus-project-lanes'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
it('retains completed and terminal-only projects while distinguishing live Agent Run counts', () => {
  const rows = [{ id: 'a', workspaceId: 'alpha', workspaceName: 'Alpha', workspacePath: _hygiene_fixturePath("alpha"), liveAgent: true }, { id: 'done', workspaceId: 'alpha', workspaceName: 'Alpha', workspacePath: _hygiene_fixturePath("alpha"), liveAgent: false }, { id: 'terminal', workspaceId: 'beta', workspaceName: 'Beta', workspacePath: _hygiene_fixturePath("beta"), liveAgent: false }] as FocusContext[]
  const lanes = deriveFocusProjectLanes(rows)
  expect(lanes.map(lane => ({ workspaceId: lane.workspaceId, labels: lane.labels, active: lane.activeAgentIds, contexts: lane.contextIds }))).toEqual([
    { workspaceId: 'alpha', labels: ['Alpha'], active: ['a'], contexts: ['a', 'done'] }, { workspaceId: 'beta', labels: ['Beta'], active: [], contexts: ['terminal'] }
  ])
})
it('preserves a known checkout association when Git no longer lists the checkout', () => {
  const before = retainedWorktreeFacts([], { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), branches: [{ name: 'feature', worktreePath: _hygiene_fixturePath("checkout"), workspaceId: 'checkout', isCurrent: false }] })
  expect(before).toEqual([{ hostId: 'local', repoPath: _hygiene_fixturePath("repo"), path: _hygiene_fixturePath("checkout"), branch: 'feature', removed: false }])
  expect(retainedWorktreeFacts(before, { kind: 'git-repository', hostId: 'local', repoPath: _hygiene_fixturePath("repo"), branches: [{ name: 'feature', worktreePath: null, workspaceId: null, isCurrent: false }] })).toEqual([{ ...before[0], removed: true }])
})
