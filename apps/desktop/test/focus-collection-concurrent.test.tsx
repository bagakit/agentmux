// @vitest-environment happy-dom
import { act, startTransition, Suspense, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog, TopicCategory } from '@agentmux/core/control'
import { homeZoneId, type SpaceZoneBindings } from '../src/shared/space-addresses'
import type { FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'
import { useFocusCollectionLanes } from '../src/renderer/src/lib/use-focus-collection-lanes'

it('keeps committed membership through an abandoned render and an active kind change', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), zoneId = homeZoneId('original-topic-space')
  const categories = ['a', 'b'].map(id => ({ categoryId: id, hostId: 'local', spaceId: id,
    directoryPath: `/category/${id}`, title: id, revision: 'original' })) satisfies TopicCategory[]
  const lane: FocusProjectLane = { id: 'original-lane', workspaceId: 'workspace', projectId: 'project', projectWorkspaceId: null,
    name: 'Topic', path: '/topic', hostId: 'local',  labels: ['Topic'], topicId: 'topic', recovery: null, summary: null,
    objectKind: 'topic', activeAgentRefs: (['agent']).map(id => ({ hostId: 'local', id })), contextRefs: (['agent']).map(id => ({ hostId: 'local', id })) }
  function source(category: string) {
    const catalog: AgentMuxSpaceCatalog = { zones: [{ zoneId, workspaceId: 'workspace', hostId: 'local', kind: 'home', directoryPath: '/topic', branch: null }],
      spaces: categories.map(value => ({ spaceId: value.spaceId, hostId: value.hostId, kind: 'container', name: value.title, directoryPath: value.directoryPath, projectId: null })),
      bindings: [{ zoneId, spaceId: category }], tabs: [], regions: [], locations: [] }
    const bindings: SpaceZoneBindings = { [zoneId]: { spaceId: 'original-topic-space', workspaceId: 'workspace', topicId: 'topic',
      relations: { [category]: true } } }
    return { catalog, content: { bindings, categories } }
  }
  const a = source('a'), b = source('b'), never = new Promise<never>(() => {}), attempts: string[] = []
  function Board({ data, suspend, unknown }: { data: typeof a; suspend: boolean; unknown: boolean }) {
    const rows = useRef<HTMLDivElement>(null), pressed = useRef(false)
    const result = useFocusCollectionLanes([unknown ? { ...lane, objectKind: 'unknown' } : lane], data.catalog, data.content, rows, pressed, true)
    attempts.push(data === b ? 'b' : 'a')
    if (suspend) throw never
    return <div ref={rows}>{result.map(group => <div key={group.id} data-collection={group.collection?.categories[0]?.spaceId}>
      <input aria-label="Original Agent rename" defaultValue="Unsent rename" />
    </div>)}</div>
  }
  const view = (data: typeof a, suspend = false, unknown = false) => <Suspense fallback={<span>Loading</span>}><Board data={data} suspend={suspend} unknown={unknown} /></Suspense>
  try {
    await act(async () => root.render(view(a)))
    const input = host.querySelector<HTMLInputElement>('input')!
    expect(input).toBeTruthy(); expect(input.parentElement?.dataset.collection).toBe('a')
    await act(async () => { startTransition(() => root.render(view(b, true))) })
    expect(attempts).toContain('b'); expect(host.querySelector('input')).toBe(input)
    await act(async () => { input.focus(); input.setSelectionRange(2, 8) })
    await act(async () => root.render(view(a)))
    expect(host.querySelector('input')).toBe(input)
    expect(input.parentElement?.dataset.collection).toBe('a')
    expect(input.value).toBe('Unsent rename'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8])
    expect(document.activeElement).toBe(input)
    await act(async () => root.render(view(a, false, true)))
    expect(host.querySelector('input')).toBe(input)
    expect(input.parentElement?.dataset.collection).toBe('a')
    expect(input.value).toBe('Unsent rename'); expect(document.activeElement).toBe(input)
    await act(async () => { input.blur(); document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' })) })
    expect(host.querySelector('input')?.parentElement?.dataset.collection).toBeUndefined()
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals()
  }
})
