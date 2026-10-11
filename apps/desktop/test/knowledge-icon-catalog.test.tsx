// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AUTHORED_ICON_DEFINITIONS } from '../../../packages/client-ui/src/theme/icon-authored'
import { BUILTIN_THEMES, GRAPHITE_THEME, mountThemeRuntime, parseThemeFile, previewTheme, serializeThemeFile } from '@agentmux/client-ui/theme'
import { ICON_GLYPHS, SEMANTIC_ICON_CATALOG, SemanticIcon, createSemanticIconElement, semanticIconHref, type SemanticIconId } from '@agentmux/client-ui/icons'
import { emptyNotebookState, DEFAULT_NOTEBOOK_ID } from '@agentmux/core/notebook-catalog'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { GlobalRecallSurface } from '../src/renderer/src/components/GlobalRecallSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/monaco', () => ({}))
const dom = composerDOM(), customPath = 'M4 4H20V20H4Z'
const roleGlyphs = { 'navigation.goals': 'goal-consensus', 'object.goal': 'goal-consensus', 'navigation.survey': 'survey-explore', 'object.survey': 'survey-explore', 'object.note': 'note-page' } as const
const parts = { 'goal-consensus': 'agreement-flag', 'survey-explore': 'survey-reflection', 'note-page': 'note-content' } as const
let release: () => void
beforeEach(() => {
  release = mountThemeRuntime(window, { appAppearance: 'light' })
  useAppStore.setState({ config: composerConfig, sessions: [], tabs: {}, layouts: {}, scratchTopicSnapshots: {}, workspaceFileRevisions: {}, timelines: {}, mainSurface: 'workbench', notebookRecoveries: [], recallSidebarCollapsed: false })
  useNotebookLibrary.setState({ state: null, issue: null })
})
afterEach(() => release())
const symbol = (id: SemanticIconId) => document.getElementById(semanticIconHref(id).slice(1))!
const shapes = (element: Element) => [...element.children].map(child => [child.localName, Object.fromEntries([...child.attributes].map(attribute => [attribute.name, attribute.value]))])
function expectedDrawing(id: keyof typeof roleGlyphs) { expect(SEMANTIC_ICON_CATALOG[id].glyph).toBe(roleGlyphs[id]); expect(shapes(symbol(id))).toEqual(AUTHORED_ICON_DEFINITIONS[roleGlyphs[id]].shapes) }
function expectStaticIcon(element: Element, role: SemanticIconId) {
  const glyph = element.querySelector<SVGElement>(`svg[data-semantic-icon="${role}"]`)!
  expect(glyph).not.toBeNull(); expect(glyph.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(role)); expect(glyph.closest('[data-icon-animation]')).toBeNull()
}
it('actual SurfaceSwitch consumes the original navigation plugins with new static goal and survey drawings in every built-in theme', async () => {
  const settings = { open: vi.fn(), openToolkit: vi.fn(), openHost: vi.fn() }
  await dom.render(<SettingsNavigation.Provider value={settings}><SurfaceSwitch/></SettingsNavigation.Provider>)
  const navigation = dom.container.querySelector('[aria-label="Primary surfaces"]')!
  expectStaticIcon(navigation, 'navigation.goals'); expectStaticIcon(navigation, 'navigation.survey')
  expect(BUILTIN_THEMES.length).toBeGreaterThan(0)
  for (const theme of BUILTIN_THEMES) for (const appearance of ['light', 'dark'] as const) {
    expect(previewTheme(theme, window, appearance).applied).toBe(true)
    expectedDrawing('navigation.goals'); expectedDrawing('object.goal'); expectedDrawing('navigation.survey')
    expectStaticIcon(navigation, 'navigation.goals'); expectStaticIcon(navigation, 'navigation.survey')
  }
  const goals = navigation.querySelector<HTMLButtonElement>('button[aria-label="Goals: show goals and progress"]')!
  await act(async () => goals.click()); expect(useAppStore.getState().mainSurface).toBe('board')
  const survey = navigation.querySelector<HTMLButtonElement>('button[aria-label="Survey: browse and explore"]')!
  await act(async () => survey.click()); expect(useAppStore.getState().mainSurface).toBe('survey')
  expectStaticIcon(navigation, 'navigation.goals'); expectStaticIcon(navigation, 'navigation.survey'); expect(settings.open).not.toHaveBeenCalled()
})
it('the actual Recall return-to-note button keeps its original selection while consuming the new single-page identity and user override', async () => {
  const catalog = emptyNotebookState(), workspace = composerConfig.workspaces[0]!, original = { noteId: 'original-selected-note', title: 'Original selected note', notebookId: DEFAULT_NOTEBOOK_ID, parentNoteId: null,
    resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'original.note.md' }, sources: [], topics: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2) }
  catalog.pages[original.noteId] = original; useNotebookLibrary.setState({ state: catalog, issue: null })
  useAppStore.setState({ recallNotebookId: DEFAULT_NOTEBOOK_ID, recallNoteId: original.noteId, recallSidebarCollapsed: false, mainSurface: 'recall' })
  const reference = { displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: 'original-tab', regionId: 'original-note-region' }, selection = { zoneId: 'original-zone', selection: [reference], active: reference }
  await dom.render(<GlobalRecallSurface catalog={null} projection={null} selection={selection} />)
  const directory = dom.container.querySelector<HTMLButtonElement>('.recall-directory-home:not(.recall-directory-graph)')!
  expect(directory).not.toBeNull(); await act(async () => directory.click())
  const button = dom.container.querySelector<HTMLButtonElement>('.recall-return-note')!
  expect(button).not.toBeNull(); expect(button.textContent).toContain(original.title); expectStaticIcon(button, 'object.note'); expectedDrawing('object.note')
  const documents = useAppStore.getState().documents
  const custom = { ...structuredClone(GRAPHITE_THEME), id: 'custom.note-return', name: 'Original note drawing', icons: { 'object.note': { kind: 'paths' as const, paths: [{ d: customPath }] } } }
  expect(previewTheme(custom).applied).toBe(true)
  expect(symbol('object.note').querySelector('path')?.getAttribute('d')).toBe(customPath); expect(dom.container.querySelector('.recall-return-note')).toBe(button)
  expectStaticIcon(button, 'object.note'); await act(async () => button.click())
  expect(dom.container.querySelector('.recall-return-note')).toBeNull(); expect(useAppStore.getState().recallNoteId).toBe(original.noteId); expect(useAppStore.getState().documents).toBe(documents)
})
it('original meanings remain independently customizable and explicit target, compass, book-open and user paths survive theme roundtrip unchanged', async () => {
  await dom.render(<>{Object.keys(roleGlyphs).map(role => <SemanticIcon key={role} name={role as SemanticIconId} />)}<SemanticIcon name="object.notebook"/></>)
  const siblings = [['navigation.goals', 'object.goal'], ['navigation.survey', 'object.survey'], ['object.note', 'object.notebook']] as const
  for (const [role, sibling] of siblings) {
    const theme = { ...structuredClone(GRAPHITE_THEME), id: 'custom.independent-knowledge', name: 'Independent knowledge meaning', icons: { [role]: { kind: 'paths' as const, paths: [{ d: customPath }] } } }
    expect(previewTheme(theme).applied).toBe(true); expect(symbol(role).querySelector('path')?.getAttribute('d')).toBe(customPath)
    if (sibling === 'object.notebook') expect(shapes(symbol(sibling))).toEqual(ICON_GLYPHS['notebook-text'])
    else expectedDrawing(sibling)
  }
  const original = parseThemeFile(serializeThemeFile({ ...structuredClone(GRAPHITE_THEME), id: 'custom.retained-knowledge-assets', name: 'Original user assets', icons: {
    'object.goal': { kind: 'glyph', glyph: 'target' }, 'navigation.survey': { kind: 'glyph', glyph: 'compass' }, 'object.note': { kind: 'glyph', glyph: 'book-open' }, 'object.survey': { kind: 'paths', paths: [{ d: customPath }] }
  } }))
  const before = serializeThemeFile(original); expect(previewTheme(original).applied).toBe(true)
  for (const [role, glyph] of [['object.goal', 'target'], ['navigation.survey', 'compass'], ['object.note', 'book-open']] as const) { expect(ICON_GLYPHS[glyph].length).toBeGreaterThan(0); expect(shapes(symbol(role))).toEqual(ICON_GLYPHS[glyph]) }
  expect(symbol('object.survey').querySelector('path')?.getAttribute('d')).toBe(customPath); expect(symbol('object.survey').querySelector('[data-semantic-icon-part]')).toBeNull()
  expect(serializeThemeFile(original)).toBe(before); expect(SEMANTIC_ICON_CATALOG['object.notebook'].glyph).toBe('notebook-text'); expect(SEMANTIC_ICON_CATALOG['navigation.recall'].glyph).toBe('book-open')
  for (const role of Object.keys(roleGlyphs)) expectStaticIcon(dom.container, role as SemanticIconId)
})
it('the original single authored owner supplies complete rest, one local feedback part, and default-none React/native presentations', async () => {
  await dom.render(<><SemanticIcon name="object.goal"/><SemanticIcon name="object.survey"/><SemanticIcon name="object.note"/></>)
  for (const [role, glyph] of Object.entries(roleGlyphs) as [keyof typeof roleGlyphs, (typeof roleGlyphs)[keyof typeof roleGlyphs]][]) {
    expectedDrawing(role)
    const authored = AUTHORED_ICON_DEFINITIONS[glyph]
    expect(authored.design.rest.trim().length).toBeGreaterThan(0); expect(authored.design.motion).toMatchObject({ kind: 'once', animation: 'feedback' })
    expect(authored.design.motion.description.trim().length).toBeGreaterThan(0); expect(authored.design.motion.trigger.trim().length).toBeGreaterThan(0)
    const declared = authored.shapes.filter(([, attrs]) => 'data-semantic-icon-part' in attrs)
    expect(declared).toHaveLength(1); expect(declared[0]![1]).toHaveProperty('data-semantic-icon-part', parts[glyph]); expect(authored.shapes.length - declared.length).toBeGreaterThanOrEqual(2)
    const native = createSemanticIconElement(role, document); expect(native.tagName.toLowerCase()).toBe('svg'); expect(native.getAttribute('data-icon-animation')).toBeNull(); expect(native.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(role))
  }
  expect(dom.container.querySelector('[data-icon-animation]')).toBeNull()
})
