// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import { parseMoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import { AgentAvatarBadgeIcon } from '@agentmux/client-ui/components/AgentAvatarBadgeIcon'
import { MoteIcon } from '@agentmux/client-ui/components/MoteIcon'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { GRAPHITE_THEME, getSemanticIconCatalog, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { AUTHORED_ICON_GLYPHS } from '../../../packages/client-ui/src/theme/icon-authored'
import identityCss from '../../../packages/client-ui/src/styles/mote-identity.css?inline'
import { MobileIdentity, type MobileObjectIdentity } from '../../mobile/src/navigation/MobileIdentity'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { api } from '../src/renderer/src/lib/api'
import { readSpatialAppearance } from '../src/renderer/src/lib/mobile-presentation'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { useAppStore } from '../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { moteConfig, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), path = 'M4 5H20V19H4Z', fileName = 'a'.repeat(64) + '.png'
const series = parseMoteAvatarSeriesChoice({ kind: 'series', source: { origin: 'user', seriesId: 'original', entryId: 'image', revision: 'sha256:' + 'b'.repeat(64) }, definition: { kind: 'image', file: 'original.png' }, parameters: { kind: 'image', zoom: 1, offsetX: 0, offsetY: 0 }, image: { kind: 'image', fileName } })
let release: () => void
beforeEach(() => { release = mountThemeRuntime(window) })
afterEach(() => release())
const mobile = (appearance: Record<string, unknown> = {}) => ({ name: 'Original Mote', project: 'Original project', mote: { spaceId: 'same-mote', appearance: { spaceId: 'same-mote', ...appearance } } }) as MobileObjectIdentity
const href = (node: ParentNode | null) => { expect(node).not.toBeNull(); const use = node!.querySelector('use'); expect(use).not.toBeNull(); return use!.getAttribute('href') }
const symbol = (id: 'object.mote' | 'avatar.badge-spark') => document.getElementById(semanticIconHref(id).slice(1))!

it('new Mote default and tiny badge are independent, while the old public glyph keeps its exact drawing', async () => {
  const catalog = getSemanticIconCatalog()
  expect(catalog.icons.length).toBeGreaterThan(0)
  expect(catalog.icons.find(item => item.id === 'object.mote')?.defaultGlyph).toBe('mote-identity')
  expect(catalog.icons.find(item => item.id === 'avatar.badge-spark')?.defaultGlyph).toBe('badge-token')
  expect(catalog.glyphs).toEqual(expect.arrayContaining(['mote-mark', 'mote-identity', 'badge-token']))
  expect(createHash('sha256').update(JSON.stringify(AUTHORED_ICON_GLYPHS['mote-mark'])).digest('hex')).toBe('e0c6180983b82f53856fab475a7c9a1488a4cafe40a0d9abb4a919a865f98eba')
  await dom.render(<><MoteIcon size={12} /><AgentAvatarBadgeIcon badge="spark" size={6} /></>)
  expect(href(dom.container.querySelector('svg[data-semantic-icon="object.mote"]'))).toBe(semanticIconHref('object.mote'))
  expect(href(dom.container.querySelector('svg[data-semantic-icon="avatar.badge-spark"]'))).toBe(semanticIconHref('avatar.badge-spark'))
  expect(symbol('object.mote').querySelector('path')?.getAttribute('stroke')).toBe('none')
})

it('real Desktop and Mobile automatic primary and ordinary identities share one theme projection and retain original nodes', async () => {
  await dom.render(<>
    <section data-identity="desktop-primary"><SpaceObjectIcon kind="mote" name="Primary" manualIcon={null} avatarTopicId={PMO_TEAMS_TOPIC_ID} /></section>
    <section data-identity="desktop-ordinary"><SpaceObjectIcon kind="mote" name="Ordinary" manualIcon={null} avatarTopicId="launcher:ordinary" /></section>
    <section data-identity="mobile-primary"><MobileIdentity identity={mobile({ preset: 'primary-mote' })} client={null} connected={false} /></section>
    <section data-identity="mobile-ordinary"><MobileIdentity identity={mobile()} client={null} connected={false} /></section>
  </>)
  const nodes = [...dom.container.querySelectorAll('section')].map(node => node.querySelector('svg'))
  expect(nodes).toHaveLength(4)
  for (const node of nodes) {
    expect(href(node)).toBe(semanticIconHref('object.mote'))
    expect(node?.getAttribute('data-mote-icon-source')).toBe('automatic')
  }
  expect(dom.container.querySelector('img')).toBeNull()
  const custom = structuredClone(GRAPHITE_THEME)
  custom.id = 'custom.mote-default'; custom.name = 'Mote only'
  custom.icons = { 'object.mote': { kind: 'paths', paths: [{ d: path }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect([...dom.container.querySelectorAll('section')].map(node => node.querySelector('svg'))).toEqual(nodes)
  expect(symbol('object.mote').querySelector('path')?.getAttribute('d')).toBe(path)
  expect(symbol('avatar.badge-spark').querySelector('path')?.getAttribute('d')).not.toBe(path)
  expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft')
})

it('spark decoration keeps original Provider and node identity under bidirectional exact theme overrides', async () => {
  await dom.render(<><AgentAvatar providerId="codex" appearance={{ badge: 'spark' }} size={24} /><AgentAvatarBadgeIcon badge="spark" size={8} /><MoteIcon /></>)
  const badge = dom.container.querySelector('[data-avatar-badge="spark"]')!, provider = dom.container.querySelector('[data-agent-provider="codex"]')!
  expect(badge).not.toBeNull(); expect(provider).not.toBeNull()
  expect(href(badge)).toBe(semanticIconHref('avatar.badge-spark'))
  expect(badge.querySelector('svg')?.getAttribute('width')).toBe('6')
  expect(dom.container.querySelector('svg[width="8"][data-semantic-icon="avatar.badge-spark"]')).not.toBeNull()
  const originalMote = symbol('object.mote').innerHTML
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.badge'; custom.name = 'Badge only'
  custom.icons = { 'avatar.badge-spark': { kind: 'paths', paths: [{ d: path }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(symbol('object.mote').innerHTML).toBe(originalMote)
  expect(symbol('avatar.badge-spark').querySelector('path')?.getAttribute('d')).toBe(path)
  custom.icons = { 'object.mote': { kind: 'glyph', glyph: 'mote-mark' } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(symbol('object.mote').querySelector('path')?.getAttribute('d')).toBe(AUTHORED_ICON_GLYPHS['mote-mark'][0]![1].d)
  expect(symbol('avatar.badge-spark').querySelector('path')?.getAttribute('d')).not.toBe(path)
  expect(dom.container.querySelector('[data-avatar-badge="spark"]')).toBe(badge)
  expect(dom.container.querySelector('[data-agent-provider="codex"]')).toBe(provider)
})

it('actual CSS excludes only automatic source from both host motions, retaining an explicit same-role image fallback', async () => {
  await dom.render(<>
    <section data-identity="automatic"><SpaceObjectIcon kind="mote" name="Automatic" manualIcon={null} /></section>
    <section data-identity="selected"><SpaceObjectIcon kind="mote" name="Saved image unavailable" manualIcon={{ kind: 'image', fileName }} /></section>
  </>)
  const style = document.createElement('style'); style.textContent = identityCss; document.head.append(style)
  try {
    const automatic = dom.container.querySelector('[data-identity="automatic"] svg')!, selected = dom.container.querySelector('[data-identity="selected"] svg')!
    expect(href(automatic)).toBe(semanticIconHref('object.mote')); expect(href(selected)).toBe(semanticIconHref('object.mote'))
    expect(selected.hasAttribute('data-mote-icon-source')).toBe(false)
    expect(selected.closest('[data-space-icon-source="image"]')?.getAttribute('title')).toBe('Saved avatar target is unavailable')
    for (const carrier of dom.container.querySelectorAll('.mote-identity-motion')) { carrier.setAttribute('data-mote-motion', 'on'); carrier.setAttribute('data-mote-gesture', 'curious') }
    const rules = [...style.sheet!.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && /mote-(?:gesture-)?presence /.test(rule.style.animation))
    expect(rules).toHaveLength(2)
    for (const rule of rules) {
      expect(automatic.matches(rule.selectorText), 'automatic source must stay still in ' + rule.style.animation).toBe(false)
      expect(selected.matches(rule.selectorText), 'same role explicit fallback keeps original host animation').toBe(true)
    }
  } finally { style.remove() }
})

it('actual Desktop explicit face, manual glyph, image and series retain original choices and image content', async () => {
  const read = vi.spyOn(api.scratch, 'readMoteAvatar').mockResolvedValue({ dataUrl: 'data:image/png;base64,T1JJR0lOQUw=', width: 256, height: 256 })
  const choices = [DEFAULT_MOTE_FACE, 'book', { kind: 'image', fileName }, series] as const
  await dom.render(<>{choices.map((choice, index) => <section key={index} data-choice={index}><SpaceObjectIcon kind="mote" name="Original" manualIcon={choice} avatarTopicId={PMO_TEAMS_TOPIC_ID} avatarWorkspaceId="original-workspace" avatarObjectKey={'original-object-' + index} /></section>)}</>)
  expect(dom.container.querySelector('[data-choice="0"] [data-space-icon-source="face"] .mote-face')).not.toBeNull()
  expect(href(dom.container.querySelector('[data-choice="1"]'))).toBe(semanticIconHref('space.book'))
  for (const index of [2, 3]) expect(dom.container.querySelector(`[data-choice="${index}"] img`)?.getAttribute('src')).toBe('data:image/png;base64,T1JJR0lOQUw=')
  expect(dom.container.querySelector('[data-mote-icon-source="automatic"]')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
  expect(choices[2].fileName).toBe(fileName)
})

it('actual Mobile explicit face and glyph override a primary preset while failed image keeps its precise revision and issue', async () => {
  await dom.render(<>
    <section data-choice="face"><MobileIdentity identity={mobile({ preset: 'primary-mote', parts: DEFAULT_MOTE_FACE })} client={null} connected={false} /></section>
    <section data-choice="glyph"><MobileIdentity identity={mobile({ preset: 'primary-mote', glyph: 'book' })} client={null} connected={false} /></section>
    <section data-choice="image"><MobileIdentity identity={mobile({ preset: 'primary-mote', image: { dataUrl: null, revision: 'saved-revision' }, issue: 'Original image unavailable' })} client={null} connected={false} /></section>
  </>)
  expect(dom.container.querySelector('[data-choice="face"] .mote-face')).not.toBeNull()
  expect(href(dom.container.querySelector('[data-choice="glyph"]'))).toBe(semanticIconHref('space.book'))
  expect(dom.container.querySelector('[data-choice="image"] .mobile-object-avatar')?.getAttribute('title')).toBe('Original image unavailable')
  expect(dom.container.querySelector('[data-choice="image"] .mobile-avatar-issue')).not.toBeNull()
  expect(dom.container.querySelector('[data-mote-icon-source="automatic"]')).toBeNull()
})

it('a real Desktop image-read failure retains the exact saved reference and explicit-source fallback', async () => {
  const choice = { kind: 'image' as const, fileName }, report = vi.fn()
  useAppStore.setState({ reportError: report })
  const read = vi.spyOn(api.scratch, 'readMoteAvatar').mockRejectedValue(new Error('Original immutable image unreadable'))
  await dom.render(<SpaceObjectIcon kind="mote" name="Original selection" manualIcon={choice} avatarWorkspaceId="original-workspace" avatarTopicId={PMO_TEAMS_TOPIC_ID} avatarObjectKey="original-object" />)
  const source = dom.container.querySelector('[data-space-icon-source="image"]')!
  expect(source).not.toBeNull(); expect(source.getAttribute('data-space-avatar')).toBe(fileName)
  expect(source.getAttribute('title')).toContain('Its saved choice is retained')
  expect(source.getAttribute('title')).toContain('Original immutable image unreadable')
  expect(source.querySelector('[data-mote-icon-source="automatic"]')).toBeNull()
  expect(read).toHaveBeenCalledExactlyOnceWith('original-workspace', PMO_TEAMS_TOPIC_ID, choice, 'original-object')
  expect(report).toHaveBeenCalledOnce(); expect(choice).toEqual({ kind: 'image', fileName })
})

it('an actual Mobile appearance-port failure retains the original selected revision and an actionable issue', async () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 32, 32)] as unknown as DOMRectList)
  const identity = mobile({ image: { dataUrl: null, revision: 'saved-revision' } })
  const rpc = vi.fn().mockRejectedValue(new Error('Original appearance temporarily unavailable'))
  const client = { forwardRpc: rpc, onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  await dom.render(<MobileIdentity identity={identity} client={client} connected />)
  expect(rpc).toHaveBeenCalledExactlyOnceWith('space.ls', { target: { spaceId: 'same-mote' }, presentation: true })
  expect(dom.container.querySelector('.mobile-object-avatar')?.getAttribute('title')).toContain('Original appearance temporarily unavailable')
  expect(dom.container.querySelector('.mobile-avatar-issue')).not.toBeNull()
  expect(dom.container.querySelector('[data-mote-icon-source="automatic"]')).toBeNull()
  expect(identity.mote?.appearance?.image?.revision).toBe('saved-revision')
})

it('actual Mobile image reads preserve original revision and loaded bytes without replacing the selected source', async () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 32, 32)] as unknown as DOMRectList)
  const original = { spaceId: 'same-mote', image: { dataUrl: 'data:image/png;base64,T1JJR0lOQUw=', revision: 'saved-revision' } }
  const rpc = vi.fn().mockImplementation(async () => ({ catalog: { appearance: [original] } }))
  const client = { forwardRpc: rpc, onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  await dom.render(<MobileIdentity identity={mobile({ image: { dataUrl: null, revision: 'saved-revision' } })} client={client} connected />)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(rpc.mock.calls.map(([method]) => method)).toEqual(['space.ls', 'space.inspect'])
  expect(rpc.mock.calls.every(([, args]) => args.target.spaceId === original.spaceId && args.presentation === true)).toBe(true)
  expect(dom.container.querySelector('img')?.getAttribute('src')).toBe(original.image.dataUrl)
  expect(dom.container.querySelector('[data-mote-icon-source="automatic"]')).toBeNull()
  expect(original.image.revision).toBe('saved-revision')
})

it('original Desktop projection derives primary-mote only after every explicit choice, without writing that choice', async () => {
  const state = { ...useAppStore.getState(), config: moteConfig, spaceObjectIcons: {} }, catalog = spatialCatalog(state, moteTopics)
  const primary = moteTopics.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!, key = topicSpaceIconTarget(scratchWorkspace, primary).key
  expect(primary).toBeDefined(); expect(catalog.spaces.length).toBeGreaterThan(0)
  const appearance = await readSpatialAppearance(state, catalog, undefined, moteTopics, vi.fn())
  expect(appearance.some(item => item.preset === 'primary-mote')).toBe(true)
  const values = ['book', DEFAULT_MOTE_FACE, { kind: 'image' as const, fileName }, series] as const
  for (const choice of values) {
    const selected = { ...state, spaceObjectIcons: { [key]: choice } }
    const bytes = JSON.stringify(selected.spaceObjectIcons)
    const result = await readSpatialAppearance(selected, catalog, undefined, moteTopics, vi.fn())
    const entry = result.find(item => item.spaceId === appearance.find(item => item.preset === 'primary-mote')!.spaceId)!
    expect(entry).toBeDefined(); expect(entry.preset).toBeUndefined()
    expect(JSON.stringify(selected.spaceObjectIcons)).toBe(bytes)
    if (typeof choice === 'string') expect(entry.glyph).toBe(choice)
    else if (choice.kind === 'face') expect(entry.parts).toEqual(choice)
    else expect(entry.image?.revision).toBe(fileName)
  }
})
