import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_MOTE_FACE, isMoteFace, MOTE_FACE_PARTS } from '../src/shared/mote-avatars'
import { MoteFace } from '@agentmux/client-ui/components/MoteFace'
import { MobileIdentity } from '../../mobile/src/navigation/MobileIdentity'
import { readSpatialAppearance } from '../src/renderer/src/lib/mobile-presentation'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import { restoreSpaceIconOverrides, topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { useAppStore } from '../src/renderer/src/store'
import { moteTopics, scratchWorkspace } from './fixtures/mote-workface'

const container = document.createElement('div')
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container.remove(); vi.unstubAllGlobals() })
async function render(node: import('react').ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  if (!root) { document.body.append(container); root = createRoot(container) }
  await act(async () => root!.render(node))
}
it('keeps original six-part authored faces exact and rejects malformed new features without dropping neighbours', () => {
  const original = { ...DEFAULT_MOTE_FACE, palette: 'sky', accessory: 'antenna' }
  const distinct = { ...DEFAULT_MOTE_FACE, shape: 'diamond', palette: 'cocoa', eyes: 'lashes', brows: 'bold', mouth: 'smirk', accessory: 'curls', nose: 'bridge', marking: 'freckles' }
  expect(isMoteFace(original)).toBe(true); expect(isMoteFace(distinct)).toBe(true)
  const originalKey = JSON.stringify(['local', _hygiene_fixturePath("original")]), distinctKey = JSON.stringify(['local', _hygiene_fixturePath("distinct")])
  expect(restoreSpaceIconOverrides({ [originalKey]: original, [distinctKey]: distinct })).toEqual({ [originalKey]: original, [distinctKey]: distinct })
  expect(Object.keys(original)).toHaveLength(7)
  for (const invalid of [{ ...distinct, nose: 'foreign' }, { ...distinct, marking: '<svg>' }, { ...distinct, nose: undefined }, { ...distinct, constructor: 'round' }, { kind: 'face', nose: 'button' }]) {
    expect(isMoteFace(invalid)).toBe(false)
    expect(restoreSpaceIconOverrides({ [originalKey]: original, [distinctKey]: invalid })).toEqual({ [originalKey]: original })
  }
})
it('draws distinct authored options rather than labels alone, with optional features absent on old faces', async () => {
  await render(<MoteFace face={DEFAULT_MOTE_FACE} />)
  expect(container.querySelector('.mote-face__nose')).toBeNull(); expect(container.querySelector('.mote-face__marking')).toBeNull()
  for (const part of Object.keys(MOTE_FACE_PARTS) as Array<keyof typeof MOTE_FACE_PARTS>) {
    const paintings = new Set<string>()
    for (const value of MOTE_FACE_PARTS[part]) {
      await render(<MoteFace face={{ ...DEFAULT_MOTE_FACE, [part]: value }} />)
      const svg = container.querySelector('svg')!.cloneNode(true) as SVGElement
      for (const attr of [...svg.attributes]) if (attr.name.startsWith('data-')) svg.removeAttribute(attr.name)
      paintings.add(svg.innerHTML)
    }
    expect(paintings.size, `${part} must visibly change the drawing`).toBe(MOTE_FACE_PARTS[part].length)
  }
})
it.each([DEFAULT_MOTE_FACE, { ...DEFAULT_MOTE_FACE, shape: 'slim', palette: 'rose', eyes: 'wink', brows: 'arched', mouth: 'cat', accessory: 'glasses', nose: 'round', marking: 'blush' }])('carries saved original appearance through public Core receipt to actual Mobile shared face %j', async choice => {
  const topic = moteTopics[1]!, target = topicSpaceIconTarget(scratchWorkspace, topic)
  const catalog = { spaces: [{ spaceId: target.key, kind: 'mote' as const, name: topic.title, hostId: scratchWorkspace.hostId, directoryPath: topic.directoryPath, topicId: topic.id, projectId: null }], zones: [], tabs: [], regions: [], bindings: [], locations: [] }
  const state = { ...useAppStore.getState(), config: { version: 9, workspaces: [scratchWorkspace], hosts: [], executors: {}, appearance: {} }, sessions: [], spaceObjectIcons: { [target.key]: choice }, spaceZoneBindings: {} }
  const read = vi.fn()
  const appearance = await readSpatialAppearance(state as never, catalog, target.key, [topic], read)
  const receipt = parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'original-appearance', ok: true, operation: 'space.ls', result: { catalog: { ...catalog, appearance } } })
  if (receipt.operation !== 'space.ls') throw Error('Expected original catalog')
  const original = receipt.result.catalog.appearance![0]!
  expect(original.parts).toEqual(choice); expect(read).not.toHaveBeenCalled()
  await render(<MobileIdentity identity={{ name: topic.title, project: 'Original', mote: { spaceId: target.key, appearance: original } }} client={null} connected size={45} />)
  expect(container.querySelector('.mobile-object-avatar .mote-face')).not.toBeNull()
  expect(container.querySelector('.mote-face')!.getAttribute('data-mote-face-accessory')).toBe(choice.accessory)
  expect(!!container.querySelector('.mote-face__nose')).toBe('nose' in choice)
  expect(!!container.querySelector('.mote-face__marking')).toBe('marking' in choice)
  expect(container.querySelector('.mote-face')!.getAttribute('data-mote-face-shape')).toBe(choice.shape)
})
