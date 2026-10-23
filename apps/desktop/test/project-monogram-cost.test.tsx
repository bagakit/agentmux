// @vitest-environment happy-dom
const probe = vi.hoisted(() => {
  const NativeSegmenter = Intl.Segmenter
  const counts = { constructions: 0, segments: 0, yielded: 0, steps: 0 }
  class ObservedSegmenter extends NativeSegmenter {
    constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
      super(...args); counts.constructions++
    }
    override segment(value: string): Intl.Segments {
      counts.segments++
      const segments = super.segment(value)
      // Delegate to the real native iterator; count the records the consumer asks for.
      return new Proxy(segments, { get(target, key) {
        if (key !== Symbol.iterator) return Reflect.get(target, key, target)
        return () => {
          const iterator = segments[Symbol.iterator]()
          return { [Symbol.iterator]() { return this }, next() {
            counts.steps++
            const result = iterator.next()
            if (!result.done) counts.yielded++
            return result
          } }
        }
      } })
    }
  }
  vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: ObservedSegmenter } }))
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return counts
})
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { createClientUiRoot } from './helpers/client-ui-render'
import { projectMonogram } from '../src/renderer/src/lib/project-monogram'
import { ProjectIcon } from '../src/renderer/src/components/ProjectIcon'
import { api } from '../src/renderer/src/lib/api'

let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); container = undefined
  vi.restoreAllMocks()
})
afterAll(() => vi.unstubAllGlobals())
async function render(name: string, workspaceId = 'project') {
  if (!container) { container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container) }
  await act(async () => root!.render(<ProjectIcon workspaceId={workspaceId} name={name} />))
}

it('reuses one native segmenter and only requests the required clusters across independent suffixes', () => {
  const before = { ...probe }
  const names = ['A' + 'suffix'.repeat(32), '👨‍👩‍👧' + '不同的尾部'.repeat(64), 'ß' + 'other'.repeat(48)]
  expect(names.map(projectMonogram)).toEqual(['A', '👨‍👩‍👧', 'S'])
  expect(probe.constructions).toBe(1)
  expect(probe.segments - before.segments).toBe(6)
  expect(probe.yielded - before.yielded).toBe(6)
  expect(probe.steps - before.steps).toBe(6)
})

it('preserves uppercase expansion, combining clusters and the original leading normalization order', () => {
  expect(projectMonogram('ﬁlename')).toBe('F')
  expect(projectMonogram('ßeta')).toBe('S')
  expect(projectMonogram('e\u0301tude')).toBe('E\u0301')
  expect(projectMonogram('👩🏽‍🚀 explorer')).toBe('👩🏽‍🚀')
  expect(projectMonogram(' \u200bproject')).toBe('')
})

it('keeps the real automatic icon glyph with one shared native segmenter and bounded yielded records', async () => {
  const read = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const before = { ...probe }
  await render('👨‍👩‍👧' + 'long-name'.repeat(40))
  expect(container!.querySelector('[data-monogram]')?.textContent).toBe('👨‍👩‍👧')
  expect(read).toHaveBeenCalledWith('project')
  await render('ß' + 'independent-tail'.repeat(48))
  expect(container!.querySelector('[data-monogram]')?.textContent).toBe('S')
  expect(read).toHaveBeenCalledTimes(1)
  expect(probe.constructions).toBe(1)
  const segments = probe.segments - before.segments, yielded = probe.yielded - before.yielded
  expect(segments).toBeGreaterThan(0)
  expect(yielded).toBe(segments)
  expect(probe.steps - before.steps).toBe(segments)
  if (process.env.AGENTMUX_MONOGRAM_EVIDENCE) appendFileSync(process.env.AGENTMUX_MONOGRAM_EVIDENCE,
    JSON.stringify({ chain: ['ProjectIcon', 'projectMonogram', 'native Intl.Segmenter'], glyph: 'S',
      constructions: probe.constructions, segments, yielded, appearanceReads: read.mock.calls.length, originalAppActions: 0 }) + '\n')
})

it('keeps pending appearance distinct from confirmed missing and preserves a discovered original image', async () => {
  let finish!: (value: { kind: 'directory'; icon: string | null }) => void
  const image = 'data:image/svg+xml;base64,PHN2Zy8+'
  vi.spyOn(api.workspaces, 'appearance').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const before = probe.segments
  await render('Visible name')
  expect(container!.querySelector('[data-monogram]')).toBeNull()
  expect(container!.querySelector('img')).toBeNull()
  expect(probe.segments).toBe(before)
  await act(async () => finish({ kind: 'directory', icon: null }))
  expect(container!.querySelector('[data-monogram]')?.textContent).toBe('V')
  await render('Second project', 'other-project')
  expect(container!.querySelector('[data-monogram]')).toBeNull()
  const pending = probe.segments
  await act(async () => finish({ kind: 'directory', icon: image }))
  expect(container!.querySelector('img')?.getAttribute('src')).toBe(image)
  expect(container!.querySelector('[data-monogram]')).toBeNull()
  expect(probe.segments).toBe(pending)
})
