// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM } from './helpers/composer-dom-fixture'

// The production Store and rich input, rather than an incomplete hand-built SSR Store,
// prove that the Launcher reads its own stable Region draft when it remounts.
const dom = composerDOM()
const originalLauncher = useLauncherState.getState()
const regionId = 'region:launcher-tab'
beforeEach(() => {
  useLauncherState.setState({ sections: { workspace: { agents: 'expanded' } } })
  useAppStore.setState({ tabs: { 'launcher-tab': createWorkbenchTab('launcher-tab', { regionId, kind: 'launcher', workspaceId: 'workspace' }) },
    activeWorkspaceId: 'workspace', agentComposerDrafts: {}, recoveryCandidates: [], executorDetections: {} })
})
afterEach(async () => { await act(async () => useLauncherState.setState(originalLauncher, true)) })
async function mount() { await dom.render(createElement(NewTabSurface, { tabGroupId: 'pane', tabId: 'launcher-tab', regionId, visible: false })) }

describe('Launcher input is bound to the original Store draft', () => {
  it('renders the draft stored under its Region across an actual unmount/remount', async () => {
    await act(async () => useAppStore.setState({ agentComposerDrafts: { [regionId]: 'remembered across remount' } }))
    await mount()
    expect(dom.container.querySelector('.tiptap')?.textContent).toBe('remembered across remount')
    await dom.render(null)
    await mount()
    expect(dom.container.querySelector('.tiptap')?.textContent).toBe('remembered across remount')
  })
  it('shows an empty editable input when its Region has no saved draft, retaining another Region draft', async () => {
    await act(async () => useAppStore.setState({ agentComposerDrafts: { 'another-region': 'Other independent task' } }))
    await mount()
    expect(dom.container.querySelector('.tiptap')?.getAttribute('contenteditable')).toBe('true')
    expect(dom.container.querySelector('.tiptap')?.textContent).toBe('')
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ 'another-region': 'Other independent task' })
  })
})
