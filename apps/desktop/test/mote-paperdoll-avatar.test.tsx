// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { DEFAULT_MOTE_FACE, isMoteFace, MOTE_FACE_PARTS } from '../src/shared/mote-avatars'
import { restoreSpaceIconOverrides, topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { SpaceIconPicker } from '../src/renderer/src/components/SpaceIconPicker'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, defaultTab, moteConfig, moteTopics, ordinaryTopicId, savedMoteKey, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
const primary = topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!), custom = topicSpaceIconTarget(scratchWorkspace, moteTopics[1]!)
let app: MoteAppFixture, dispose: (() => void) | undefined
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(Date, 'now').mockReturnValue(200)
  vi.spyOn(api.config, 'get').mockResolvedValue(moteConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  dispose = await useAppStore.getState().initialize(); await prepareRendererUpdate(); app = createMoteApp()
})
afterEach(async () => { await app.dispose(); dispose?.(); dispose = undefined; vi.unstubAllGlobals() })
function button(label: string) {
  if (label === 'Save avatar' && document.querySelector('[data-avatar-source=face][aria-pressed=true]')) label = 'Save face'

  const scope = document.querySelector('.space-icon-picker[role="dialog"]') ?? document
  const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  expect(value, label).toBeDefined(); return value!
}
async function edit() {
  await act(async () => app.entry().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 10, clientY: 50 }))); await settleMoteApp()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Change avatar…')
  expect(item).toBeDefined(); await moteClick(item!); expect(document.querySelector('.space-icon-picker[role="dialog"]')).not.toBeNull()
  await moteClick(button('Make a face'))
}
function quiet(before: ReturnType<typeof useAppStore.getState>) {
  const after = useAppStore.getState()
  expect(after.sessions).toBe(before.sessions); expect(after.tabs).toBe(before.tabs)
  expect(after.agentFocus.execution).toEqual(before.agentFocus.execution); expect(after.agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
}
it('real primary and custom editor saves one bounded face in the original owner and actual Footer/rail/Space consume it', async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  await app.mount(); const before = useAppStore.getState()
  expect(app.entry().querySelector('img')?.getAttribute('src')).toContain('pmo-teams-topic-avatar')
  await edit(); await moteClick(button('Eyes · spark')); await moteClick(button('Color · peach'))
  expect(document.querySelector('.mote-face-editor__preview [data-mote-face-eyes="spark"]')).not.toBeNull()
  expect(useAppStore.getState().spaceObjectIcons).toEqual({})
  await moteClick(button('Save avatar'))
  const saved = { ...DEFAULT_MOTE_FACE, eyes: 'spark', palette: 'peach' }
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(saved)
  expect(app.entry().querySelector('[data-space-icon-source="face"] [data-mote-face-eyes="spark"]')).not.toBeNull()
  await moteClick(app.entry())
  expect(app.panel().querySelector(`[data-mote-topic-id="${PMO_TEAMS_TOPIC_ID}"] [data-mote-face-palette="peach"]`)).not.toBeNull()
  await moteClick(app.panel().querySelector<HTMLElement>(`[data-mote-topic-id="${customMoteId}"]`)!)
  await edit(); await moteClick(button('Face · square')); await moteClick(button('Save avatar'))
  expect(useAppStore.getState().spaceObjectIcons[custom.key]).toEqual({ ...DEFAULT_MOTE_FACE, shape: 'square' })
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(saved)
  await moteClick(app.entry()); await moteClick(button('Show Mote avatars only'))
  expect(app.panel().querySelector(`[data-mote-topic-id="${customMoteId}"] [data-mote-face-shape="square"]`)).not.toBeNull()
  await moteClick(button('Open Mote Space')); await act(async () => useAppStore.setState({ projectRailOpen: true })); await settleMoteApp()
  const directory = [...app.container.querySelectorAll<HTMLElement>('[data-space-icon-target]')].filter(node => node.dataset.spaceIconTarget === custom.key)
  expect(directory).toHaveLength(1); expect(directory[0]!.querySelector('[data-mote-face-shape="square"]')).not.toBeNull()
  quiet(before)
})
it('Cancel and Escape discard actual component drafts, restoring automatic returns the primary to its original dragon', async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  await app.mount(); const before = useAppStore.getState(); await edit()
  await moteClick(button('Mouth · grin')); await moteClick(button('Cancel'))
  expect(useAppStore.getState().spaceObjectIcons).toEqual({})
  await edit(); await moteClick(button('Detail · antenna'))
  await act(async () => document.querySelector('.space-icon-picker[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settleMoteApp()
  expect(useAppStore.getState().spaceObjectIcons).toEqual({})
  await edit(); await moteClick(button('Save avatar'))
  expect(app.entry().querySelector('.mote-face')).not.toBeNull()
  await edit(); await moteClick(button('Restore automatic')); await moteClick(button('Save avatar'))
  expect(app.entry().querySelector('img')?.getAttribute('src')).toContain('pmo-teams-topic-avatar')
  expect(app.entry().querySelector('.mote-face')).toBeNull(); quiet(before)
})
it('the actual face editor paints one checked outline per nonempty group without moving marker slots or publishing its draft', async () => {
  const style = document.createElement('style')
  style.textContent = ['base', 'space-object-appearance'].map(name => readFileSync(resolve(import.meta.dirname, '../src/renderer/src/styles', name + '.css'), 'utf8')).join('\n')
  document.head.append(style)
  try {
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
    await app.mount(); const before = useAppStore.getState(); await edit()
    expect(style.sheet!.cssRules.length).toBeGreaterThan(100)
    expect([...style.sheet!.cssRules].filter(rule => rule.cssText.includes('.mote-avatar-selection-mark')).length).toBeGreaterThan(0)
    function painted(parts: boolean) {
      const source = document.querySelector('.mote-avatar-source')!
      expect(source.querySelectorAll('button')).toHaveLength(2)
      const fields = [...document.querySelectorAll('.mote-face-editor:not([hidden]) fieldset')]
      expect(fields).toHaveLength(parts ? 6 : 0)
      const groups = [source, ...fields]
      expect(groups).toHaveLength(parts ? 7 : 1)
      for (const group of groups) {
        const buttons = [...group.querySelectorAll('button')]
        expect(buttons.length).toBeGreaterThan(1)
        expect(buttons.filter(node => node.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
        for (const node of buttons) {
          const selected = node.getAttribute('aria-pressed') === 'true', marks = node.querySelectorAll('.mote-avatar-selection-mark')
          expect(marks).toHaveLength(1)
          const mark = marks[0]!, markStyle = getComputedStyle(mark)
          expect(mark.tagName.toLowerCase()).toBe('svg'); expect(mark.querySelectorAll('path')).toHaveLength(1)
          expect(markStyle.width).toBe('12px'); expect(markStyle.height).toBe('12px')
          expect(markStyle.position).toBe('absolute'); expect(markStyle.pointerEvents).toBe('none')
          expect(markStyle.visibility).toBe(selected ? 'visible' : 'hidden')
          if (group !== source) {
            expect(node.classList.contains('small-button--active')).toBe(selected)
            if (selected) expect(getComputedStyle(node).boxShadow).toContain('inset 0 0 0 1px')
          }
        }
      }
    }
    painted(true)
    await moteClick(button('Eyes · spark')); await moteClick(button('Color · peach')); painted(true)
    expect(document.querySelector('.mote-face-editor__preview [data-mote-face-eyes="spark"]')).not.toBeNull()
    expect(useAppStore.getState().spaceObjectIcons).toEqual({})
    expect(button('Save avatar').classList.contains('primary-button')).toBe(true)
    expect(button('Cancel').classList.contains('primary-button')).toBe(false)
    await moteClick(button('Icon or image')); painted(false)
    await moteClick(button('Make a face')); painted(true)
    expect(button('Eyes · spark').getAttribute('aria-pressed')).toBe('true')
    expect(button('Color · peach').getAttribute('aria-pressed')).toBe('true')
    await moteClick(button('Cancel')); expect(useAppStore.getState().spaceObjectIcons).toEqual({}); quiet(before)
  } finally { style.remove() }
})
it('failed confirmation retains the real saved face and current editor draft; Retry publishes only after confirmation', async () => {
  await useAppStore.getState().setSpaceObjectIcon(custom.key, DEFAULT_MOTE_FACE)
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: customMoteId, targetTabId: customTab.id }))
  await app.mount(); const before = useAppStore.getState(); await edit(); await moteClick(button('Eyes · oval'))
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('disk unconfirmed'))
  await moteClick(button('Save avatar'))
  expect(useAppStore.getState().spaceObjectIcons[custom.key]).toEqual(DEFAULT_MOTE_FACE)
  expect(app.entry().querySelector('[data-mote-face-eyes="round"]')).not.toBeNull()
  expect(button('Eyes · oval').getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('unconfirmed')
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(); await moteClick(button('Retry saving'))
  expect(app.entry().querySelector('[data-mote-face-eyes="oval"]')).not.toBeNull(); quiet(before)
})
it('switched targets reject stale editor completion without publishing or closing the new face editor', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve }); const close = vi.fn()
  vi.mocked(api.ui.requestStorageFlush).mockImplementation(() => pending)
  await app.mount(<SpaceIconPicker target={primary} onClose={close} />)
  await moteClick(button('Make a face')); await moteClick(button('Save avatar'))
  await app.mount(<SpaceIconPicker target={custom} onClose={close} />); await moteClick(button('Make a face')); await moteClick(button('Color · sky'))
  await act(async () => release()); await settleMoteApp()
  expect(close).not.toHaveBeenCalled(); expect(button('Color · sky').getAttribute('aria-pressed')).toBe('true')
  expect(useAppStore.getState().spaceObjectIcons[custom.key]).toBeUndefined()
  expect(button('Save avatar').disabled).toBe(false)
})
it('plain Topic and Folder keep the original icon editor; malformed face cannot erase other authored identities', async () => {
  const plain = topicSpaceIconTarget(scratchWorkspace, moteTopics.find(topic => topic.id === ordinaryTopicId)!)
  await app.mount(<SpaceIconPicker target={plain} onClose={vi.fn()} />)
  expect([...document.querySelectorAll('button')].filter(node => node.textContent === 'Make a face')).toHaveLength(0)
  expect(button('Save icon').classList.contains('primary-button')).toBe(false)
  expect(document.querySelectorAll('.mote-avatar-selection-mark')).toHaveLength(0)
  expect(document.querySelector('[role="group"][aria-label="Icon choices"]')!.children.length).toBeGreaterThan(0)
  expect(Object.keys(MOTE_FACE_PARTS)).toEqual(['shape', 'palette', 'eyes', 'brows', 'mouth', 'accessory'])
  expect(isMoteFace(DEFAULT_MOTE_FACE)).toBe(true)
  for (const invalid of [{ ...DEFAULT_MOTE_FACE, eyes: '<script>' }, { ...DEFAULT_MOTE_FACE, palette: 'https://remote' }, { ...DEFAULT_MOTE_FACE, extra: true }, { kind: 'face' }]) expect(isMoteFace(invalid)).toBe(false)
  const saved = restoreSpaceIconOverrides({ [primary.key]: { ...DEFAULT_MOTE_FACE, eyes: '<script>' }, [custom.key]: DEFAULT_MOTE_FACE, [plain.key]: 'book' })
  expect(saved).toEqual({ [custom.key]: DEFAULT_MOTE_FACE, [plain.key]: 'book' })
})

it.each(['book', { kind: 'image', fileName: 'a'.repeat(64) + '.png' }])('opens Make a face first, preserves the alternative draft and saves exactly the visible face for %j', async original => {
  vi.spyOn(api.scratch, 'readMoteAvatar').mockResolvedValue({ dataUrl: 'data:image/png;base64,ORIGINAL', width: 256, height: 256 })
  await useAppStore.getState().setSpaceObjectIcon(primary.key, original as never)
  const close = vi.fn(); await app.mount(<SpaceIconPicker target={primary} onClose={close} />)
  expect(document.querySelector('[data-avatar-source="face"]')!.getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('.mote-face-editor__preview [data-mote-face-palette="mint"]')).not.toBeNull()
  expect(button('Save face').textContent).toBe('Save face')
  await moteClick(button('Eyes · oval')); await moteClick(button('Icon or image'))
  const alternative = document.querySelector('.mote-avatar-preview')!
  expect(alternative).not.toBeNull(); expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(original)
  expect(alternative.querySelector(typeof original === 'string' ? '[data-space-icon="book"]' : 'img')).not.toBeNull()
  await moteClick(button('Make a face')); expect(button('Eyes · oval').getAttribute('aria-pressed')).toBe('true')
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(original)
  await moteClick(button('Save face')); expect(close).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual({ ...DEFAULT_MOTE_FACE, eyes: 'oval' })
})
