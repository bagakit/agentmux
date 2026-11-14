// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
it('the original remote Files callback opens the owned project, inserts into the current draft and obeys visibility retirement', async () => {
  const session = composerSession(), remote = { ...session, hostId: 'remote-files', control: { ...session.control, hostId: 'remote-files' } }
  useAppStore.setState({ sessions: [remote], config: { ...composerConfig,
    workspaces: composerConfig.workspaces.map(workspace => ({ ...workspace, hostId: remote.hostId })) } })
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockResolvedValue(null)
  const read = vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ name: 'original.ts', path: 'original.ts', isDirectory: false }])
  await dom.render(<AgentSessionComposer sessionId={session.id} />)
  const editor = dom.container.querySelector('.tiptap')
  await act(async () => useAppStore.setState({ sessions: [{ ...remote, updatedAt: 2 }], agentComposerDrafts: { [session.id]: 'Current original draft' } }))
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  expect(read).toHaveBeenCalledExactlyOnceWith('workspace', '')
  expect(choose).not.toHaveBeenCalled()
  const file = document.querySelector<HTMLButtonElement>('[data-reference-path="original.ts"]')
  expect(file).not.toBeNull()
  await act(async () => file!.click())
  expect(dom.draft()).toContain('Current original draft'); expect(dom.draft()).toContain('original.ts')
  expect(document.querySelector('.launcher-file-references')).toBeNull()
  expect(dom.container.querySelector('.tiptap')).toBe(editor)
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  expect(document.querySelector('.launcher-file-references')).not.toBeNull()
  await dom.render(<AgentSessionComposer sessionId={session.id} visible={false} />)
  expect(document.querySelector('.launcher-file-references')).toBeNull()
  await dom.render(<AgentSessionComposer sessionId={session.id} />)
  expect(document.querySelector('.launcher-file-references')).toBeNull()
  expect(dom.container.querySelector('.tiptap')).toBe(editor)
  expect(useAppStore.getState().sessions[0]?.control).toEqual(remote.control)
})
