// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createFocusObservation } from '../src/main/focus-observation'
import type { AgentMuxControlFocusReadRequest, AgentMuxControlResult } from '@agentmux/core/control'
import type { DesktopLoadedRenderer } from '../src/shared/client-observation'

const request: AgentMuxControlFocusReadRequest = { schemaVersion: 5, requestId: 'original-read', operation: 'focus.ls', input: { limit: 1 } }
const renderer: DesktopLoadedRenderer = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'original-shell', ctxmux: 'original-runtime' } }
function page(input: AgentMuxControlFocusReadRequest): AgentMuxControlResult {
  if (input.operation !== 'focus.ls' || !input.source) throw new Error('Original Main observation source required')
  return { operation: input.operation, page: { schemaVersion: 1, source: input.source, readAt: 1,
    status: 'observed', items: [], nextCursor: null, coverage: { complete: true, total: 0, selected: 0, returned: 0,
      sourceStatuses: [{ source: 'original-loaded-document', status: 'observed' }] }, issues: [] } }
}

it('one original Main owner stamps the loaded document and retains its observation identity across reads', async () => {
  const execute = vi.fn(async (input: AgentMuxControlFocusReadRequest) => page(input))
  const read = createFocusObservation({ renderer: () => renderer, generation: () => 2, execute })
  const first = await read(request), second = await read(request)
  expect(execute).toHaveBeenCalledTimes(2)
  expect(execute.mock.calls[0]![0].source).toEqual({ clientId: expect.any(String), rendererId: renderer.id, documentGeneration: 2 })
  expect(first).toEqual(second)
  expect(request.source).toBeUndefined()
})

it('an unavailable loaded reader refuses only that observation without executing against another document', async () => {
  const execute = vi.fn(async (input: AgentMuxControlFocusReadRequest) => page(input))
  const read = createFocusObservation({ renderer: () => null, generation: () => null, execute })
  await expect(read(request)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(execute).not.toHaveBeenCalled()
})

it.each(['renderer', 'generation'] as const)('a changed original %s cannot return a falsely current page', async changed => {
  let current = renderer, generation = 2
  const read = createFocusObservation({ renderer: () => current, generation: () => generation, execute: async input => {
    if (changed === 'renderer') current = { ...renderer, id: 'b'.repeat(64) }
    else generation++
    return page(input)
  } })
  await expect(read(request)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})

it('a mismatched reply source cannot replace the original Main observation owner', async () => {
  const read = createFocusObservation({ renderer: () => renderer, generation: () => 2, execute: async input => {
    const result = page(input)
    if (result.operation !== 'focus.ls') throw new Error('Original directory expected')
    return { ...result, page: { ...result.page, source: { ...result.page.source, clientId: 'another-client' } } }
  } })
  await expect(read(request)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
})
