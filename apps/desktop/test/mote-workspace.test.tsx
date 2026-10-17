// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileReadParams, FileReadResult } from '@agentmux/core'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { defaultAgent, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'

vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-original-editor': true }) }))

let app: MoteAppFixture
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const noteNames = ['design-options.md', 'release-questions.txt']
const revision = 'sha256:' + 'd'.repeat(64)
const panel = () => {
  const node = app.container.querySelector<HTMLElement>('[data-mote-details]')
  expect(node, 'The real App must expose the exact Mote workface').not.toBeNull()
  return node!
}
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = panel().querySelector<T>(selector)
  expect(found, 'Expected a usable workface control: ' + selector).not.toBeNull()
  return found!
}
const button = (name: string) => {
  const found = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === name || item.textContent === name)
  expect(found, 'Expected the original action: ' + name).toBeDefined()
  return found!
}
const rows = () => [...panel().querySelectorAll<HTMLButtonElement>('[aria-label="Mote ideas"] .mote-details__note')]
const body = () => panel().querySelector('.mote-details__prose')?.textContent
const readResult = (params: FileReadParams): FileReadResult => ({
  resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + rootPath, path: rootPath + '/' + params.path },
  result: { status: 'read', document: { path: rootPath + '/' + params.path, content: '# Saved ' + params.path + '\nOriginal saved body for ' + params.path + '.', revision } }
})
async function input(selector: string, value: string) {
  const element = node<HTMLInputElement | HTMLTextAreaElement>(selector)
  await act(async () => {
    element.focus()
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settleMoteApp()
}
async function ideas() { await moteClick(button('Ideas')) }
async function openFirst() { await ideas(); const list = rows(); expect(list).toHaveLength(2); await moteClick(list[0]!) }

beforeEach(() => {
  app = createMoteApp()
  useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue(noteNames.map(name => ({ path: rootPath + '/' + name, name, isDirectory: false, isSymlink: false, ignored: false })))
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => readResult(params))
  vi.spyOn(api.files, 'observe').mockResolvedValue()
  vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async () => { await app.dispose() })

it('puts a real question and current work before accessible secondary preferences', async () => {
  await app.mount()
  const question = node('[aria-label="Start working together"]'), work = node('[aria-label="This Mote’s work"]')
  const secondary = ['.mote-behavior-summary', '[aria-label="Quick mode"]', '[aria-label="Mote bot"]', '[data-mote-memory]'].map(selector => node(selector))
  expect(secondary).toHaveLength(4)
  for (const section of secondary) {
    expect(question.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(work.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
  expect(button('Change Mote avatar')).toBeDefined()
  expect(button('Rename Mote')).toBeDefined()
  expect(node('.mote-details__status').textContent).toContain(useAppStore.getState().sessions.find(session => session.id === defaultAgent.id)!.status.state)
  await input('[aria-label="A question for this Mote"]', 'Retain my original question.')
  await ideas(); await moteClick(button('Profile'))
  expect(node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]').value).toBe('Retain my original question.')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('filters discovered names without new reads or clearing the exact selected body and revision feedback', async () => {
  await app.mount(); await openFirst()
  await input('[aria-label="Idea direction"]', 'Compare these exact options.')
  await input('[aria-label="Idea feedback comment"]', 'Keep this unsent revision feedback.')
  const publicRead = vi.mocked(api.files.readPublic), directoryRead = vi.mocked(api.files.readDirectory)
  const reads = publicRead.mock.calls.length, directories = directoryRead.mock.calls.length
  await input('[aria-label="Find a note"]', 'RELEASE')
  expect(rows().map(row => row.textContent)).toEqual([expect.stringContaining('release-questions')])
  expect(body()).toContain('Original saved body for design-options.md.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea direction"]').value).toBe('Compare these exact options.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea feedback comment"]').value).toBe('Keep this unsent revision feedback.')
  await input('[aria-label="Find a note"]', 'no-matching-note')
  expect(rows()).toHaveLength(0)
  expect(node('[aria-label="Mote ideas"]').textContent).toMatch(/no .*match/i)
  expect(body()).toContain('Original saved body for design-options.md.')
  await moteClick(button('Clear note filter'))
  expect(rows()).toHaveLength(2)
  expect(rows().filter(row => row.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
  expect(rows().find(row => row.getAttribute('aria-pressed') === 'true')?.textContent).toContain('design-options')
  expect(publicRead).toHaveBeenCalledTimes(reads); expect(directoryRead).toHaveBeenCalledTimes(directories)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('returns from the selected reader without discarding its source or unsent idea inputs', async () => {
  await app.mount(); await openFirst()
  expect(document.activeElement).toBe(node('.mote-ideas__reader-heading h4'))
  await input('[aria-label="Idea direction"]', 'Retain the selected source.')
  await input('[aria-label="Idea feedback comment"]', 'A retained detail.')
  const selected = rows()[0]!, reads = vi.mocked(api.files.readPublic).mock.calls.length
  expect(node('.mote-details__ideas').getAttribute('data-reading')).toBe('true')
  await moteClick(button('Back to notes'))
  expect(node('.mote-details__ideas').getAttribute('data-reading')).toBe('false')
  expect(document.activeElement).toBe(selected)
  expect(rows().map(row => row.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
  expect(body()).toContain('Original saved body for design-options.md.')
  await moteClick(selected)
  expect(node<HTMLTextAreaElement>('[aria-label="Idea direction"]').value).toBe('Retain the selected source.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea feedback comment"]').value).toBe('A retained detail.')
  expect(vi.mocked(api.files.readPublic)).toHaveBeenCalledTimes(reads)
})

it('changes only the selected original source and restores feedback for its exact saved revision', async () => {
  await app.mount(); await openFirst()
  await input('[aria-label="Idea feedback comment"]', 'Feedback belongs to the first source.')
  await moteClick(rows()[1]!)
  expect(body()).toContain('Original saved body for release-questions.txt.')
  expect(body()).not.toContain('Original saved body for design-options.md.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea feedback comment"]').value).toBe('')
  await input('[aria-label="Idea feedback comment"]', 'Feedback belongs to the other source.')
  await moteClick(rows()[0]!)
  expect(body()).toContain('Original saved body for design-options.md.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea feedback comment"]').value).toBe('Feedback belongs to the first source.')
  expect(vi.mocked(api.files.readPublic).mock.calls.filter(([params]) => noteNames.includes(params.path)).map(([params]) => params.path)).toEqual([
    'design-options.md', 'release-questions.txt', 'design-options.md'
  ])
})

it('parks selected-note observations while Calendar is visible and returns to the same source and inputs', async () => {
  await app.mount(); await openFirst()
  await input('[aria-label="Idea direction"]', 'The original direction survives siblings.')
  await input('[aria-label="Idea feedback comment"]', 'The original feedback survives siblings.')
  const drafts = useAppStore.getState().agentComposerDrafts, sessions = useAppStore.getState().sessions
  await moteClick(button('Calendar'))
  const read = vi.mocked(api.files.readPublic), before = read.mock.calls.filter(([params]) => noteNames.includes(params.path)).length
  await act(async () => useAppStore.setState(state => ({ workspaceFileRevisions: { ...state.workspaceFileRevisions, [SCRATCH_WORKSPACE_ID]: 1 } })))
  await settleMoteApp()
  expect(read.mock.calls.filter(([params]) => noteNames.includes(params.path))).toHaveLength(before)
  const ideasTab = button('Ideas')
  await act(async () => ideasTab.focus())
  await moteClick(ideasTab)
  expect(document.activeElement).toBe(ideasTab)
  expect(rows().filter(row => row.getAttribute('aria-pressed') === 'true').map(row => row.textContent)).toEqual([expect.stringContaining('design-options')])
  expect(body()).toContain('Original saved body for design-options.md.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea direction"]').value).toBe('The original direction survives siblings.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea feedback comment"]').value).toBe('The original feedback survives siblings.')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(useAppStore.getState().sessions).toBe(sessions)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('opens the selected original file through the existing Editor while preserving healthy work', async () => {
  const filePath = rootPath + '/' + noteNames[0]
  const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: filePath, content: '# Existing original Editor body', revision } })
  const write = vi.spyOn(api.files, 'write')
  await app.mount(); await openFirst()
  const before = useAppStore.getState()
  await moteClick(button('Open file'))
  expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, filePath)
  const files = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'file')
  expect(files).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file', path: filePath, workspaceId: SCRATCH_WORKSPACE_ID })]))
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(write).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
