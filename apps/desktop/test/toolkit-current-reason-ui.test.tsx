// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('electron', () => ({ app: { getPath: () => fixturePath('tmp'), getAppPath: () => process.cwd() } }))
vi.mock('@agentmux/core/toolkit-result-channel', () => ({ openToolkitResultChannel: async () => ({ env: {}, connected: false, close: async () => {} }) }))
// The DOM fixture does not launch Core binaries; retain every domain owner and parser.
vi.mock('../../../packages/core/src/runtime-paths.ts', async original => ({
  ...await original<typeof import('../../../packages/core/src/runtime-paths.ts')>(), resolveCoreBinPath: () => fixturePath('core-bin')
}))
import { fixture, tool, flush, deferred } from './helpers/toolkit-custom-owner-fixture'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
it.each(['ordinary', 'display'] as const)('renders actual Owner %s reasons without filtering historical stop wording', async lane => {
  const definition = lane === 'display' ? { ...tool, display: { script: 'void 0', args: [] } } : tool
  const f = fixture('', 'running', definition), held = deferred(), operation = new AbortController()
  const select = (value: any) => lane === 'display' ? value.display : value
  const launch = async (latest: string | null = null) => select(await (lane === 'display'
    ? f.custom.evaluate(tool.id, undefined, operation.signal) : f.custom.run(tool.id, f.input(latest), operation.signal)))
  let reader!: ReturnType<typeof f.custom.subscribe>
  vi.spyOn(api.toolkit, 'observe').mockImplementation((id, snapshot, end, options) => {
    const controller = new AbortController()
    reader = f.custom.subscribe(id, snapshot, cause => end?.(cause?.message ?? 'Toolkit reader ended'), controller.signal, options)
    return { dispose: () => { controller.abort(); void reader.then(lease => lease.dispose()) } }
  })
  vi.spyOn(api.toolkit, 'get').mockImplementation(id => f.custom.get(id))
  try {
    await dom.render(<UserToolkitResult definition={definition} active close={() => {}} />)
    await act(async () => { await reader; await flush(); if (lane === 'ordinary') await launch() })
    let stopped!: any
    await act(async () => { const current = select(await f.custom.get(tool.id)); stopped = select(await f.custom.stop(tool.id, current.admission.executionId)) })
    expect(dom.container.querySelector('.toolkit-result__notice')?.textContent).toBe('Stopped explicitly.')
    const previous = stopped.latestConfirmed
    const create = vi.mocked(f.port.create), original = create.getMockImplementation()!
    create.mockImplementationOnce(async (...args) => { await held.promise; return original(...args) })
    f.begin()
    let next!: ReturnType<typeof launch>
    await act(async () => { next = launch(previous.executionId); await flush() })
    expect(dom.container.textContent).not.toContain('Stopped explicitly.')
    expect(select(await f.custom.get(tool.id))).toMatchObject({ state: 'pending', reason: null, latestConfirmed: previous })
    await act(async () => { held.release(); await next })
    expect(dom.container.textContent).not.toContain('Stopped explicitly.')
    await act(async () => {
      const current = select(await f.custom.get(tool.id))
      stopped = select(await f.custom.stop(tool.id, current.admission.executionId))
      f.begin(); create.mockRejectedValueOnce(new Error('Stopped explicitly.'))
      await launch(stopped.latestConfirmed.executionId)
    })
    expect(select(await f.custom.get(tool.id))).toMatchObject({ state: 'unknown', reason: 'Stopped explicitly.' })
    expect(dom.container.querySelector('.toolkit-result__notice')?.textContent).toBe('Stopped explicitly.')
    expect(previous.reason).toBe('Stopped explicitly.')
  } finally {
    held.release(); operation.abort()
    await act(async () => { (await reader)?.dispose(); await f.custom.dispose() })
  }
})
