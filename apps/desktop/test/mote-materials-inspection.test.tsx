import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileReadParams, FileReadResult } from '@agentmux/core'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { defaultAgent, defaultTab, customMoteId, customTab, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-original-editor': true }) }))
let app: MoteAppFixture
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path = rootPath + '/my-original-material.md', revision = 'sha256:' + 'c'.repeat(64)
const details = () => app.container.querySelector<HTMLElement>('[data-mote-details]')!
const button = (name: string) => [...details().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
const readResult = (params: FileReadParams, content = '# Saved material\nSource: my own observation.'): FileReadResult => ({
  resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + rootPath, path },
  result: { status: 'read', document: { path, content, revision } } })
beforeEach(() => {
  app = createMoteApp(); useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ path, name: 'my-original-material.md', isDirectory: false, isSymlink: false, ignored: false }])
  vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async () => { await app.dispose() })
async function inspect() { await moteClick(button('Inspect saved materials')); await moteClick(details().querySelector<HTMLButtonElement>('.mote-details__note')!) }

describe('Profile inspection consumes the original public File domain', () => {
  it('reads only a selected file through the typed seam, keeps its revision and opens correction through original Editor', async () => {
    const read = vi.spyOn(api.files, 'readPublic').mockImplementation(async params => readResult(params))
    const privateRead = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path, content: '# Original editor content', revision } })
    const write = vi.spyOn(api.files, 'write'); await app.mount(); expect(read).not.toHaveBeenCalled()
    await inspect(); expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![0]).toMatchObject({ path: 'my-original-material.md', expectedResource: { hostId: 'local', workspaceId: SCRATCH_WORKSPACE_ID, workspacePath: _hygiene_fixturePath("topics") } })
    expect(privateRead).not.toHaveBeenCalled(); expect(details().textContent).toContain('Source: my own observation.'); expect(details().textContent).toContain('Agent use is not confirmed')
    expect([...details().querySelectorAll('[title]')].some(node => node.getAttribute('title') === revision)).toBe(true)
    const before = useAppStore.getState(); await moteClick(button('Correct or remove a detail in editor'))
    expect(privateRead).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, path); expect(write).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
  it('keeps last confirmed content and its original reference when rereading becomes unknown; retry is a read', async () => {
    const read = vi.spyOn(api.files, 'readPublic').mockImplementationOnce(async params => readResult(params))
      .mockResolvedValue({ resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'Original resource observation is unavailable' } })
    const write = vi.spyOn(api.files, 'write'); await app.mount(); await inspect()
    await act(async () => useAppStore.setState({ workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: 1 } })); await settleMoteApp()
    expect(details().textContent).toContain('Original resource observation is unavailable'); expect(details().textContent).toContain('Last confirmed saved content')
    expect(details().textContent).toContain('Source: my own observation.'); expect(details().textContent).toContain(path)
    await moteClick(button('Retry')); expect(read).toHaveBeenCalledTimes(3); expect(write).not.toHaveBeenCalled()
  })
  it('rejects a late A read after A to B to A even when the original name and path return', async () => {
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    const read = vi.spyOn(api.files, 'readPublic').mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
      .mockResolvedValue({ resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'Current read unavailable' } })
    await app.mount(); await inspect()
    await act(async () => useAppStore.getState().openScratchTopic(customMoteId, SCRATCH_WORKSPACE_ID, { tabId: customTab.id })); await settleMoteApp()
    await act(async () => useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { tabId: defaultTab.id })); await settleMoteApp()
    await inspect(); await act(async () => finish(readResult(captured, 'OLD A SECRET'))); await settleMoteApp()
    expect(details().textContent).not.toContain('OLD A SECRET'); expect(details().textContent).toContain('Current read unavailable'); expect(read).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.stop).not.toHaveBeenCalled()
  })
  it('rejects a late file read after selecting another file and returning inside the same Mote', async () => {
    const another = rootPath + '/another-original-file.md'
    vi.mocked(api.files.readDirectory).mockResolvedValue([path, another].map(path => ({ path, name: path.split('/').at(-1)!, isDirectory: false, isSymlink: false, ignored: false })))
    let finish!: (value: FileReadResult) => void, captured!: FileReadParams
    const read = vi.spyOn(api.files, 'readPublic').mockImplementationOnce(params => { captured = params; return new Promise(resolve => { finish = resolve }) })
      .mockResolvedValue({ resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'Current file read unavailable' } })
    await app.mount(); await inspect()
    const notes = [...details().querySelectorAll<HTMLButtonElement>('.mote-details__note')]
    await moteClick(notes[1]!); await moteClick(notes[0]!)
    await act(async () => finish(readResult(captured, 'STALE FILE SECRET'))); await settleMoteApp()
    expect(details().textContent).not.toContain('STALE FILE SECRET'); expect(details().textContent).toContain('Current file read unavailable'); expect(read).toHaveBeenCalledTimes(3)
  })
})
