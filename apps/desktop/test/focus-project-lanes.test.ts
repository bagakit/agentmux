import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
it('retains completed and terminal-only projects while distinguishing live Agent Run counts', () => {
  const rows = [{ id: 'a', workspaceId: 'alpha', workspaceName: 'Alpha', workspacePath: _hygiene_fixturePath("alpha"), liveAgent: true }, { id: 'done', workspaceId: 'alpha', workspaceName: 'Alpha', workspacePath: _hygiene_fixturePath("alpha"), liveAgent: false }, { id: 'terminal', workspaceId: 'beta', workspaceName: 'Beta', workspacePath: _hygiene_fixturePath("beta"), liveAgent: false }] as FocusContext[]
  expect(deriveFocusProjectLanes(rows)).toEqual([{ workspaceId: 'alpha', name: 'Alpha', path: _hygiene_fixturePath("alpha"), activeAgentIds: ['a'] }, { workspaceId: 'beta', name: 'Beta', path: _hygiene_fixturePath("beta"), activeAgentIds: [] }])
})
