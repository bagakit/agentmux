// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { newSourceAgentInput } from '../src/renderer/src/lib/new-source-agent-input'
import { useSourceLauncher } from '../src/renderer/src/hooks/useSourceLauncher'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'

const target = { hostId: 'original-carrier', expectedRuntimeId: 'source-runtime' }
const agentTarget = { hostId: 'original-executor', runtimeId: 'executor-runtime' }
const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const description = (runtimeId = agentTarget.runtimeId, inputEpoch: string | null = 'original-source-cut') => ({
  source: { runtimeId: target.expectedRuntimeId, ownerInstanceId: 'original-instance' },
  contracts: { ordinaryLaunch: null, externalAssociation: null, takeover: null }, execution: { hostId: agentTarget.hostId, runtimeId, inputEpoch } })

it('first Source birth freezes its exact execution Runtime and cut with an execution-only read', async () => {
  const read = vi.spyOn(api.spaceMounts, 'call').mockResolvedValue(description() as never)
  expect(await newSourceAgentInput(target, agentTarget)).toEqual({ fields: { inputRuntimeId: agentTarget.runtimeId, inputEpoch: 'original-source-cut' } })
  expect(read).toHaveBeenCalledExactlyOnceWith('describe', { ...target, execution: { agentTarget }, executionOnly: true })
  read.mockResolvedValue(description(agentTarget.runtimeId, null) as never)
  expect(await newSourceAgentInput(target, agentTarget)).toEqual({ fields: { inputRuntimeId: agentTarget.runtimeId } })
})

it('an unavailable namespace reader keeps only the already confirmed Runtime pin without fabricating an empty or fresh cut', async () => {
  const read = vi.spyOn(api.spaceMounts, 'call').mockRejectedValue(Object.assign(new Error('Original reader denied'), { code: 'CONTROL_PERMISSION_DENIED' }))
  const other = vi.spyOn(api.sessions, 'readInputEpoch')
  await expect(newSourceAgentInput(target, agentTarget)).resolves.toMatchObject({ fields: { inputRuntimeId: agentTarget.runtimeId } })
  const frozen = await newSourceAgentInput(target, agentTarget)
  expect(frozen.fields).not.toHaveProperty('inputEpoch'); expect(frozen.issue).toContain('Original reader denied')
  expect(read).toHaveBeenCalledTimes(2); expect(other).not.toHaveBeenCalled()
})

it('a wrong Runtime reply or absent original pin cannot be promoted to a new Source creation', async () => {
  const read = vi.spyOn(api.spaceMounts, 'call').mockResolvedValue(description('another-runtime') as never)
  await expect(newSourceAgentInput(target, agentTarget)).rejects.toThrow('belongs to another Runtime')
  read.mockClear()
  await expect(newSourceAgentInput({ hostId: 'original-carrier', expectedRuntimeId: '' }, null)).rejects.toThrow('Runtime is unconfirmed')
  expect(read).not.toHaveBeenCalled()
})

it('the original Main IPC and RuntimeController preserve the execution-only selector and original Runtime fence', async () => {
  const calls = vi.fn(async (method: string) => {
    if (method === 'runtime.owner.identity') return { owner: { runtimeId: target.expectedRuntimeId, ownerInstanceId: 'original-instance' } }
    if (method === 'agent.open.describe') return description()
    throw Error('Unexpected original Source operation')
  })
  const transport = spaceMountTransport(cleanup, [{ id: target.hostId, carrier: { forwardRpc: calls as never, subscribeRpc: vi.fn() as never } }])
  expect(await transport.api.call('describe', { ...target, execution: { agentTarget }, executionOnly: true })).toEqual(description())
  expect(calls).toHaveBeenLastCalledWith('agent.open.describe', { expectedRuntimeId: target.expectedRuntimeId, execution: { agentTarget }, executionOnly: true },
    expect.objectContaining({ signal: expect.any(AbortSignal) }), { runtimeId: target.expectedRuntimeId, ownerInstanceId: 'original-instance' })
  expect(calls.mock.calls.map(call => call[0])).toEqual(['runtime.owner.identity', 'agent.open.describe'])
})

it('an optional Source description failure remains visible while a confirmed executor stays usable', async () => {
  const selection = { project: { id: 'original-project', hostId: target.hostId, path: '/original/project' },
    target: { hostId: target.hostId, reference: { runtimeId: target.expectedRuntimeId, spaceId: 'original-space' }, workspaceId: 'original-project', zoneId: 'original-zone' }, agentTarget, executorId: 'original-executor' }
  const { execution: _execution, ...optional } = description()
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async method => method === 'describe'
    ? { ...optional, sourceIssue: { code: 'OPTIONAL_DESCRIPTION_UNAVAILABLE', message: 'Optional description unavailable' } } as never
    : { runtimeId: agentTarget.runtimeId, executors: [{ executorId: 'original-executor', providerId: 'codex', label: 'Original executor', command: '/original/cli', configRevision: 'original-revision', source: 'registered', availability: 'unknown', creationContract: { ordinaryLaunch: 1 } }] } as never)
  let current!: ReturnType<typeof useSourceLauncher>
  function Probe() { current = useSourceLauncher(selection, true); return <div>{current.issue}</div> }
  await act(async () => dom.render(<Probe />))
  await vi.waitFor(() => expect(current.selected).toBeDefined())
  expect(current.ready).toBe(true); expect(current.issue).toBe('Optional description unavailable')
})
