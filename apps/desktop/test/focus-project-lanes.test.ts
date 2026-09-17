import { expect, it } from 'vitest'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
it('retains completed and terminal-only projects while distinguishing live Agent Run counts', () => {
  const rows = [{ id: 'a', workspaceId: 'alpha', workspaceName: 'Alpha', workspacePath: '/alpha', liveAgent: true }, { id: 'done', workspaceId: 'alpha', workspaceName: 'Alpha', workspacePath: '/alpha', liveAgent: false }, { id: 'terminal', workspaceId: 'beta', workspaceName: 'Beta', workspacePath: '/beta', liveAgent: false }] as FocusContext[]
  expect(deriveFocusProjectLanes(rows)).toEqual([{ workspaceId: 'alpha', name: 'Alpha', path: '/alpha', activeAgentIds: ['a'] }, { workspaceId: 'beta', name: 'Beta', path: '/beta', activeAgentIds: [] }])
})
