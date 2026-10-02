import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div /> }))
import { LauncherSecondarySurfaces } from '../src/renderer/src/components/LauncherSecondarySurfaces'
import { useLauncherState, type LauncherSection, type LauncherSectionMode } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), initialLauncher = useLauncherState.getState()
const sectionModes: Record<LauncherSection, LauncherSectionMode> = { agents: 'expanded', terminal: 'collapsed', browser: 'expanded', note: 'expanded' }
function Utility({ id = 'input', visible = true }: { id?: string; visible?: boolean }) {
  const [sections, setSections] = useState(sectionModes)
  return <div data-owner={id}><LauncherSecondarySurfaces workspace={composerConfig.workspaces[0]} tabGroupId="group" launcherRef={{ tabId: 'launcher', regionId: id }} launcherId={`region:${id}`} sections={sections}
    onSectionChange={(section, mode) => setSections(value => ({ ...value, [section]: mode }))} warmSession={null} warmPending={false} terminalThemeId="graphite" terminalFontSize={12} visible={visible} busy={null}
    onRun={async (_kind, action) => { await action() }} /></div>
}
beforeEach(() => {
  const tab = createWorkbenchTab('launcher', { regionId: 'input', kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({ tabs: { launcher: tab }, layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }, activeWorkspaceId: 'workspace', openFile: vi.fn().mockResolvedValue(true) })
  useLauncherState.setState({ drafts: { 'region:input': { browser: 'localhost:4310/retained', note: 'Complete note\nSecond line' } }, sections: {}, persistenceIssue: null })
})
afterEach(async () => { await act(async () => useLauncherState.setState(initialLauncher, true)) })
async function activate(owner: string, label: string) {
  const button = dom.container.querySelector<HTMLButtonElement>(`[data-owner="${owner}"] [aria-label="${label}"]`)
  expect(button).not.toBeNull(); await act(async () => { button!.focus(); button!.click() })
}
function focusLabel() { return document.activeElement?.getAttribute('aria-label') }
async function saveBody() {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-owner="input"] button')].find(node => node.textContent?.includes('Save & open note'))!
  expect(button).toBeDefined(); await act(async () => { button.focus(); button.click() })
}

describe('Launcher utility intent and local focus', () => {
  it('returns Browser collapse to its own expand action while retaining the address', async () => {
    await dom.render(<Utility />); await activate('input', 'Collapse Browser')
    expect(focusLabel()).toBe('Expand Browser'); expect(useLauncherState.getState().drafts['region:input']!.browser).toBe('localhost:4310/retained')
  })
  it('waits for the finite Browser exit before focusing its expand action', async () => {
    await dom.render(<Utility />)
    dom.container.querySelector<HTMLElement>('[data-section="browser"]')!.style.setProperty('--dur-enter', '40ms')
    await activate('input', 'Collapse Browser')
    expect(dom.container.querySelector('[aria-label="Expand Browser"]')).toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(focusLabel()).toBe('Expand Browser')
  })
  it('lets a later focus choice win over the Browser exit', async () => {
    await dom.render(<><input aria-label="Current work" /><Utility /></>)
    dom.container.querySelector<HTMLElement>('[data-section="browser"]')!.style.setProperty('--dur-enter', '40ms')
    await activate('input', 'Collapse Browser')
    const current = dom.container.querySelector<HTMLInputElement>('input[aria-label="Current work"]')!; current.focus()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(document.activeElement).toBe(current)
  })
  it('returns close to the correct local restore when another Launcher also has a restore action', async () => {
    await dom.render(<><Utility id="other" /><Utility /></>)
    await activate('other', 'Close Note'); await activate('input', 'Close Note')
    expect(focusLabel()).toBe('Restore Note'); expect(document.activeElement?.closest('[data-owner]')?.getAttribute('data-owner')).toBe('input')
    expect(useLauncherState.getState().drafts['region:input']!.note).toBe('Complete note\nSecond line')
  })
  it('does not focus a hidden Launcher after a section preference changes', async () => {
    await dom.render(<><input aria-label="Current work" /><Utility visible={false} /></>)
    const current = dom.container.querySelector<HTMLInputElement>('input[aria-label="Current work"]')!; current.focus()
    await dom.click('[aria-label="Close Note"]'); expect(document.activeElement).toBe(current)
  })
  it.each(['header', 'body'] as const)('%s saves the complete draft through the real file owner and reveals the same written Note', async origin => {
    const write = vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved' })
    await dom.render(<Utility />)
    if (origin === 'header') await activate('input', 'Save and open note draft'); else await saveBody()
    expect(write).toHaveBeenCalledOnce(); const [workspaceId, request] = write.mock.calls[0]!
    expect(workspaceId).toBe('workspace'); expect(request.expectedRevision).toBeNull()
    expect(JSON.parse(request.content)).toMatchObject({ schema: 'agentmux.note.v1', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Complete note' }, { type: 'hardBreak' }, { type: 'text', text: 'Second line' }] }] } })
    const open = vi.mocked(useAppStore.getState().openFile)
    expect(open).toHaveBeenCalledOnce(); expect(open.mock.calls[0]!.slice(0, 4)).toEqual([request.path, 'group', undefined, 'workspace'])
    expect(open.mock.calls[0]![5]).toMatchObject({ displayWorkspaceId: 'workspace', resource: { hostId: 'local', path: _hygiene_fixturePath("repo") } })
    expect(useLauncherState.getState().drafts['region:input']!.note).toBe('')
  })
  it('preserves edits made while the header save is pending', async () => {
    let finish!: (value: { status: 'written'; revision: string }) => void
    vi.spyOn(api.files, 'write').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await dom.render(<Utility />); await activate('input', 'Save and open note draft')
    await act(async () => useLauncherState.getState().setDraft('region:input', 'note', 'A newer complete edit'))
    await act(async () => finish({ status: 'written', revision: 'saved' }))
    expect(useLauncherState.getState().drafts['region:input']!.note).toBe('A newer complete edit')
  })
  it('offers one explicit blank action for an empty expanded Note and writes an empty Note', async () => {
    const write = vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved' })
    useLauncherState.getState().setDraft('region:input', 'note', '')
    await dom.render(<Utility />)
    const actions = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.includes('Create blank note') || button.getAttribute('aria-label') === 'Create blank note')
    expect(actions).toHaveLength(1); await act(async () => actions[0]!.click())
    expect(write).toHaveBeenCalledOnce(); expect(JSON.parse(write.mock.calls[0]![1].content).content.content).toMatchObject([{ type: 'paragraph' }])
  })
})
