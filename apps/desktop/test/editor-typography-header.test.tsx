const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act, useEffect } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import { monacoKeybindingConstants } from './helpers/editor-pane-store'
import { EditorPane } from '../src/renderer/src/components/EditorPane'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import type { OnMount } from '@monaco-editor/react'

const platform = vi.hoisted(() => ({ options: {} as Record<string, unknown>, mounts: 0,
  commands: [] as Array<{ key: number; run: () => void }> }))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
vi.mock('../src/renderer/src/hooks/useMonacoTheme', () => ({ useMonacoTheme: () => 'vs-dark' }))
vi.mock('@monaco-editor/react', () => ({ default: function Canvas({ options, onMount }: {
  options: Record<string, unknown>; onMount: OnMount
}) {
  platform.options = options
  useEffect(() => {
    platform.mounts++
    onMount({ addCommand: (key: number, run: () => void) => platform.commands.push({ key, run }),
      addAction: vi.fn(), createContextKey: () => ({ set: vi.fn() }),
      onDidChangeCursorSelection: () => ({ dispose: vi.fn() }), onDidDispose: () => ({ dispose: vi.fn() }),
      getModel: () => null, getDomNode: () => null, focus: vi.fn()
    } as unknown as Parameters<OnMount>[0], monacoKeybindingConstants() as unknown as Parameters<OnMount>[1])
  }, [])
  return <div data-monaco-platform="source" />
} }))
const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const surface = { regionId: 'header-region', kind: 'file' as const, workspaceId: workspace.id, path: 'notes.ts' }
const tab = createWorkbenchTab('header-tab', surface), key = documentKey(workspace.id, surface.path)
const save = vi.fn(), reload = vi.fn(), overwrite = vi.fn()
let stylesheet: HTMLStyleElement
beforeEach(() => {
  stylesheet = document.createElement('style'); stylesheet.textContent = readFileSync('apps/desktop/src/renderer/src/styles/tokens.css', 'utf8'); document.head.append(stylesheet)
  platform.options = {}; platform.mounts = 0; platform.commands = []; save.mockReset(); reload.mockReset(); overwrite.mockReset()
  useAppStore.setState({ config: composerConfig, documents: { [key]: { path: surface.path, content: 'const draft = 1', revision: 'r1' } },
    tabs: { [tab.id]: tab }, dirtyDocuments: {}, documentIssues: {}, savingDocuments: {}, documentRevealTargets: {},
    editorRegionModes: {}, editorRegionDiffs: {}, editorWordWrap: false, regionCaretFocus: null,
    saveDocument: save, reloadDocument: reload, overwriteDocument: overwrite })
})
afterEach(() => { stylesheet.remove(); document.documentElement.style.removeProperty('--fs-body') })
const render = () => dom.render(<EditorPane tabId={tab.id} surface={surface} />)
const button = (name: string) => dom.container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)

it('consumes the actual App font and live override without remounting or changing the document/view', async () => {
  document.documentElement.style.setProperty('--fs-body', '15px')
  await render(); expect(platform.options).toMatchObject({ fontSize: 15, lineHeight: 23 })
  const documentBefore = useAppStore.getState().documents[key], tabsBefore = useAppStore.getState().tabs
  await act(async () => useAppStore.setState({ config: { ...composerConfig, appearance: { ...composerConfig.appearance, editorFontSize: 20 } } }))
  expect(platform.options).toMatchObject({ fontSize: 20, lineHeight: 30 }); expect(platform.mounts).toBe(1)
  await act(async () => useAppStore.setState({ config: composerConfig }))
  expect(platform.options).toMatchObject({ fontSize: 15, lineHeight: 23 }); expect(platform.mounts).toBe(1)
  expect(useAppStore.getState().documents[key]).toBe(documentBefore); expect(useAppStore.getState().tabs).toBe(tabsBefore)
})
it('presents Saved and Saving as honest statuses and keeps the dirty Save and registered shortcut', async () => {
  await render(); expect(button('File saved')).toBeNull(); expect(dom.container.querySelector('[role="status"]')?.textContent).toBe('Saved')
  await act(async () => useAppStore.setState({ dirtyDocuments: { [key]: true } }))
  expect(button('Save file')).not.toBeNull(); await act(async () => button('Save file')!.click()); expect(save).toHaveBeenCalledWith(tab.id, surface.regionId)
  const shortcut = platform.commands.find(command => command.key === (2048 | 49)); expect(shortcut).toBeDefined()
  shortcut!.run(); expect(save).toHaveBeenCalledTimes(2)
  await act(async () => useAppStore.setState({ savingDocuments: { [key]: true } }))
  expect(button('Save file')).toBeNull(); expect(dom.container.querySelector('[role="status"]')?.textContent).toBe('Saving…')
})
it('keeps unknown save outcome Check and disk conflict Overwrite as real exact-file actions', async () => {
  useAppStore.setState({ dirtyDocuments: { [key]: true }, documentIssues: { [key]: { kind: 'write-unknown', code: 'unknown', message: 'Outcome not confirmed', attempted: { content: 'const draft = 1', expectedRevision: 'r1', generation: 1, resource: { hostId: 'local', path: _hygiene_fixturePath("repo/notes.ts") } } } } })
  await render(); expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('not confirmed')
  await act(async () => button('Check saved file')!.click()); expect(reload).toHaveBeenCalledWith(tab.id, surface.regionId); expect(button('Save file')).toBeNull()
  await act(async () => useAppStore.setState({ documentIssues: { [key]: { kind: 'changed', observed: { path: surface.path, content: 'Disk change', revision: 'r2', language: 'typescript' } } } }))
  await act(async () => button('Overwrite file with this draft')!.click()); expect(overwrite).toHaveBeenCalledWith(tab.id, surface.regionId)
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('draft is preserved')
})
it('keeps read-error retry and write-error unsaved feedback with the original buffer', async () => {
  useAppStore.setState({ documentIssues: { [key]: { kind: 'read-error', code: 'temporarily-unavailable', message: 'Temporary file read failure' } } })
  await render(); await act(async () => button('Retry reading file')!.click()); expect(reload).toHaveBeenCalledWith(tab.id, surface.regionId)
  await act(async () => useAppStore.setState({ dirtyDocuments: { [key]: true }, documentIssues: { [key]: { kind: 'write-error', code: 'disk-full', message: 'Disk full' } } }))
  expect(button('Save file')).not.toBeNull(); expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Disk full')
  expect(useAppStore.getState().documents[key]?.content).toBe('const draft = 1')
})
it('opens the actual keyboard menu, toggles wrap and returns focus after Escape', async () => {
  await render()
  const trigger = button('File options')!; expect(trigger).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const menu = document.querySelector<HTMLElement>('[role="menu"]'); expect(menu).not.toBeNull()
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]; expect(items).toHaveLength(2)
  expect(menu!.classList.contains('editor-options-menu')).toBe(true)
  const wrap = items.find(item => item.textContent?.includes('Word wrap'))!; expect(wrap.getAttribute('aria-checked')).toBe('false')
  await act(async () => wrap.click()); expect(useAppStore.getState().editorWordWrap).toBe(true)
  expect(wrap.getAttribute('aria-checked')).toBe('true')
  await act(async () => {
    menu!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger)
})
