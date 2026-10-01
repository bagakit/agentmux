// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { MoteIcon } from '../src/renderer/src/components/MoteIcon'
import { ConversationMessageAvatar } from '../src/renderer/src/components/ConversationMessageAvatar'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, defaultAgent, defaultTab, moteConfig, moteTopics, quietMoteId, savedMoteKey, scratchWorkspace } from './fixtures/mote-workface'

const primary = topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!), custom = topicSpaceIconTarget(scratchWorkspace, moteTopics[1]!)
const image = { kind: 'image' as const, fileName: 'b'.repeat(64) + '.png' }
let app: MoteAppFixture, sheet: HTMLStyleElement, dispose: (() => void) | undefined
beforeEach(async () => {
  vi.spyOn(api.config, 'get').mockResolvedValue(moteConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  dispose = await useAppStore.getState().initialize(); await prepareRendererUpdate()
  app = createMoteApp()
  vi.spyOn(api.scratch, 'readMoteAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,ORIGINAL' })
  sheet = document.createElement('style')
  sheet.textContent = ['tokens', 'chrome', 'space-object-appearance', 'conversation-avatar'].map(name => readFileSync(resolve(import.meta.dirname, '../src/renderer/src/styles', name + '.css'), 'utf8')).join('\n')
  document.head.append(sheet)
  expect(sheet.sheet!.cssRules.length).toBeGreaterThan(100)
})
afterEach(async () => { await app.dispose(); dispose?.(); dispose = undefined; sheet.remove(); document.documentElement.removeAttribute('data-appearance') })
function icon(owner: ParentNode) {
  const node = owner.querySelector<HTMLElement>('.space-object-icon[data-space-icon-source]')
  expect(node).not.toBeNull(); expect(node!.dataset.spaceIconKind).toBe('mote')
  return node!
}
function originalImages(owner: ParentNode) {
  const nodes = [...owner.querySelectorAll<HTMLImageElement>('.space-object-icon img')]
  expect(nodes.length).toBeGreaterThan(0)
  for (const node of nodes) { expect(node.closest('.space-object-icon')?.getAttribute('data-space-icon-kind')).toBe('mote'); expect(getComputedStyle(node).filter).toBe('none'); expect(getComputedStyle(node).opacity).toBe('1') }
  return nodes
}
function tokenColor(token: string) {
  const reference = document.createElement('span'); reference.style.color = `var(${token})`; document.body.append(reference)
  const color = getComputedStyle(reference).color; reference.remove(); expect(color).toBeTruthy(); return color
}
function button(label: string) { const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label); expect(found, label).toBeDefined(); return found! }

it('original image colors reach the real Footer, both floating forms, Space identity and accurate message author', async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  await useAppStore.getState().setSpaceObjectIcon(custom.key, image)
  await app.mount(<ConversationMessageAvatar speaker={{ role: 'agent', id: 'custom-agent' }} name="Analyst" mote={{ workspaceId: scratchWorkspace.id, topicId: customMoteId, objectKey: custom.key, name: 'Analyst', icon: image }} />)
  const before = useAppStore.getState()
  const dragon = originalImages(app.entry()); expect(dragon).toHaveLength(1); expect(dragon[0]!.src).toContain('pmo-teams-topic-avatar')
  const customRow = app.panel().querySelector<HTMLElement>(`[data-mote-topic-id="${customMoteId}"]`)!
  expect(customRow).not.toBeNull(); expect(customRow.getAttribute('aria-pressed')).toBe('false'); expect(originalImages(customRow)).toHaveLength(1)
  await moteClick(customRow); expect(originalImages(app.entry())[0]!.src).toContain('ORIGINAL')
  await moteClick(button('Show Mote avatars only')); expect(originalImages(app.panel()).length).toBeGreaterThan(1)
  const author = app.container.querySelector('[data-mote-author]')!; expect(author).not.toBeNull(); expect(originalImages(author)[0]!.src).toContain('ORIGINAL')
  await moteClick(button('Open Mote Space')); await act(async () => useAppStore.setState({ projectRailOpen: true })); await settleMoteApp()
  const space = [...app.container.querySelectorAll<HTMLElement>('.project-rail [data-space-icon-target]')].find(node => node.dataset.spaceIconTarget === custom.key)!
  expect(space).not.toBeNull(); expect(originalImages(space)[0]!.src).toContain('ORIGINAL')
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it.each(['dark', 'light'])('fallback and manual identity glyphs keep the existing purple through selection, sleep and unknown in %s while face keeps its own palette', async appearance => {
  document.documentElement.setAttribute('data-appearance', appearance)
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  await app.mount(<><span data-type-glyph style={{ color: 'var(--text-3)' }}><MoteIcon /></span><span data-manual-identity><SpaceObjectIcon kind="mote" name="Manual identity" manualIcon="book" /></span><span data-unknown-identity><SpaceObjectIcon kind="mote" name="Retained unknown" manualIcon={null} moteAvailability="restoring" /></span></>)
  const quiet = app.panel().querySelector<HTMLElement>(`[data-mote-topic-id="${quietMoteId}"]`)!
  expect(quiet).not.toBeNull(); const seed = icon(quiet), shape = seed.querySelector('svg')!.outerHTML
  expect(seed.querySelector('svg')?.getAttribute('fill')).toBe('currentColor'); expect(quiet.dataset.moteStatus).toBe('No Agent yet')
  expect(getComputedStyle(seed).color).toBe(tokenColor('--purple'))
  await moteClick(quiet); expect(icon(app.entry()).querySelector('svg')!.outerHTML).toBe(shape)
  expect(getComputedStyle(icon(app.entry())).color).toBe(tokenColor('--purple')); expect(app.entry().dataset.moteStatus).toBe('No Agent yet')
  expect(getComputedStyle(icon(app.container.querySelector('[data-manual-identity]')!)).color).toBe(tokenColor('--purple'))
  const unknown = app.container.querySelector('[data-unknown-identity]')!; expect(unknown.querySelector('[data-mote-expression]')?.getAttribute('data-mote-expression')).toBe('unknown')
  expect(getComputedStyle(icon(unknown)).color).toBe(tokenColor('--purple'))
  const ordinary = app.container.querySelector<HTMLElement>('[data-type-glyph]')!
  expect(ordinary.querySelector('[data-space-icon-kind]')).toBeNull(); expect(getComputedStyle(ordinary).color).toBe(tokenColor('--text-3')); expect(getComputedStyle(ordinary).color).not.toBe(getComputedStyle(seed).color)
  await act(async () => useAppStore.getState().setSpaceObjectIcon(primary.key, DEFAULT_MOTE_FACE)); await settleMoteApp()
  const primaryRow = app.panel().querySelector(`[data-mote-topic-id="${PMO_TEAMS_TOPIC_ID}"]`)!
  const painted = primaryRow.querySelector('.mote-face__head')!; expect(painted).not.toBeNull()
  const palette = painted.outerHTML; expect(painted.querySelector('[fill]')).not.toBeNull()
  await act(async () => useAppStore.setState({ sessions: [{ ...defaultAgent, status: { state: 'error', source: 'native-hook', observedAt: 3 } }] })); await settleMoteApp()
  expect(primaryRow.querySelector('[data-mote-expression]')?.getAttribute('data-mote-expression')).toBe('error'); expect(primaryRow.querySelector('.mote-face__head')!.outerHTML).toBe(palette)
})

it('Mote identity color leaves Folder recency, ordinary images and neutral Topic monograms on their original rules', async () => {
  await app.mount(<><span data-ordinary-image className="project-rail-row__icon"><img src="ordinary.png" /></span><span data-folder-full className="project-rail-row__icon"><img data-folder-icon-recency="full" src="full.png" /></span><span data-folder-subdued className="project-rail-row__icon"><img data-folder-icon-recency="subdued" src="subdued.png" /></span><span data-topic-identity><SpaceObjectIcon kind="topic" name="Notes" manualIcon={null} /></span></>)
  const ordinary = app.container.querySelector<HTMLImageElement>('[data-ordinary-image] img')!, full = app.container.querySelector<HTMLImageElement>('[data-folder-full] img')!, subdued = app.container.querySelector<HTMLImageElement>('[data-folder-subdued] img')!
  expect([ordinary, full, subdued].filter(Boolean)).toHaveLength(3)
  expect(getComputedStyle(ordinary).filter).toBe('saturate(.2)'); expect(getComputedStyle(ordinary).opacity).toBe('.85')
  expect(getComputedStyle(full).filter).toBe('none'); expect(getComputedStyle(full).opacity).toBe('1')
  expect(getComputedStyle(subdued).filter).toBe('saturate(.65) brightness(.92)'); expect(getComputedStyle(subdued).opacity).toBe('.95')
  const topic = app.container.querySelector<HTMLElement>('[data-topic-identity] .space-object-icon')!; expect(topic).not.toBeNull(); expect(topic.dataset.spaceIconKind).toBe('topic'); expect(getComputedStyle(topic).filter).toBe('grayscale(1)'); expect(getComputedStyle(topic).color).toBe(tokenColor('--text-3'))
})
