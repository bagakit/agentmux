import { afterEach, describe, expect, it } from 'vitest'
import { parseBrowserTaskControlPayload } from '../src/browser-task-control.js'
import { parseBrowserTaskParallelContinuationInput } from '../src/browser-task-parallel.js'
import { parseRpcControlResult, rpcControlRequest } from '../src/rpc-business-codec.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import type { AgentMuxControlRequest } from '../src/control.js'
import type { AgentMuxRpcParams } from '../src/public-rpc.js'
import type { BrowserTaskParallelContinuation, BrowserTaskParallelInspection, BrowserTaskParallelSummary } from '../src/browser-task-parallel.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'

const browserId = 'original-source', operationId = 'original-parallel', targetId = 'original-target'
const input = { continuationId: 'original-continuation', expectedRevision: 'a'.repeat(64), parameters: { value: 'fresh parent value' },
  calls: { 'original-call': { parameters: {}, items: [{ id: 'original-item', parameters: { value: 'fresh child value' } }] } } }
const continueParams = { browserId, operationId, targetId, input }
const stopParams = { browserId, operationId }
const inspectParams = { browserId, operationId, continuationId: input.continuationId, limit: 1 }
const summary: BrowserTaskParallelSummary = { browserId, operationId, assetId: 'original-asset', version: 1, status: 'ready',
  targetCount: 2, requestedConcurrency: 2, concurrency: 2, startedAt: 1, updatedAt: 2, admission: 'confirmed',
  counts: { queued: 0, preparing: 0, running: 0, waitingHuman: 0, ready: 1, completed: 1, interrupted: 0, failed: 0, stopped: 0 } }
const continuation: BrowserTaskParallelContinuation = { id: input.continuationId, targetId, admission: 'unknown', warning: 'Original dispatch acknowledgement is unavailable.' }
const inspection: BrowserTaskParallelInspection = { run: summary, targets: [{ id: targetId, browserId: 'original-target-browser', profileId: 'original-profile',
  phase: 'bound', continuationRevision: input.expectedRevision, run: { id: 'original-run', status: 'ready', nextStep: 3, operationCount: 2 } }],
  page: { after: null, limit: 1, nextAfter: targetId }, continuation }
const probes: ObjectCliProbe[] = [], services: AgentMuxRpcService[] = []
afterEach(async () => {
  await Promise.all(probes.splice(0).map(probe => probe.stop()))
  await Promise.all(services.splice(0).map(service => service.dispose()))
})

describe('original parallel task stop and continuation public consumers', () => {
  it('carries fresh values and original caller separately from continuation identity, without human authority fields', () => {
    const caller = { agentSessionId: 'original-agent', capability: 'original-capability' }
    const decoded = rpcControlRequest('browser.task.parallel-continue', continueParams, caller)
    expect(decoded).toMatchObject({ operation: 'browser.task.parallel-continue', ...continueParams, caller })
    expect(decoded.requestId).not.toBe(input.continuationId)
    expect(parseBrowserTaskControlPayload(decoded)).toEqual({ operation: 'browser.task.parallel-continue', ...continueParams })
    expect(parseBrowserTaskParallelContinuationInput(input)).toEqual(input)
    expect(rpcControlRequest('browser.task.parallel-stop', stopParams, caller)).not.toHaveProperty('caller')
    expect(rpcControlRequest('browser.task.parallel-inspect', inspectParams, caller)).not.toHaveProperty('caller')
    for (const extra of [{ caller }, { human: true }, { approved: true }, { controlBefore: 'human' }, { runId: 'replacement-run' }]) {
      expect(() => rpcControlRequest('browser.task.parallel-continue', { ...continueParams, ...extra }, caller)).toThrow()
      expect(() => parseBrowserTaskParallelContinuationInput({ ...input, ...extra })).toThrow()
    }
    expect(() => parseBrowserTaskParallelContinuationInput({ ...input, calls: { 'original-call': { ...input.calls['original-call'], items: [{ ...input.calls['original-call'].items[0], runId: 'replacement-child' }] } } })).toThrow()
  })

  it('requires the original continuation revision and exact operation for receipt inspection', () => {
    for (const expectedRevision of [null, '', 'a'.repeat(63), 'A'.repeat(64), 'not-a-cursor']) {
      expect(() => parseBrowserTaskParallelContinuationInput({ ...input, expectedRevision })).toThrow()
    }
    expect(() => rpcControlRequest('browser.task.parallel-inspect', { browserId, continuationId: input.continuationId })).toThrow()
    expect(() => rpcControlRequest('browser.task.parallel-stop', { ...stopParams, targetId })).toThrow()
    expect(() => rpcControlRequest('browser.task.parallel-inspect', { ...inspectParams, approved: true })).toThrow()
  })

  it('keeps unknown, refused, absent and null continuation observations distinct through the actual public result codec', () => {
    for (const admission of ['confirmed', 'unknown', 'refused'] as const) {
      expect(parseRpcControlResult('browser.task.parallel-continue', { run: summary, continuation: { ...continuation, admission } }, continueParams))
        .toEqual({ run: summary, continuation: { ...continuation, admission } })
    }
    const missing = { run: summary, targets: inspection.targets, page: inspection.page }
    expect(parseRpcControlResult('browser.task.parallel-inspect', { inspection: missing }, inspectParams)).not.toHaveProperty('inspection.continuation')
    expect(parseRpcControlResult('browser.task.parallel-inspect', { inspection: { ...missing, continuation: null } }, inspectParams))
      .toHaveProperty('inspection.continuation', null)
    expect(parseRpcControlResult('browser.task.parallel-stop', { run: null }, stopParams)).toEqual({ run: null })
    for (const extra of [{ approved: true }, { controlBefore: 'human' }, { parameters: input.parameters }]) {
      expect(() => parseRpcControlResult('browser.task.parallel-continue', { run: summary, continuation: { ...continuation, ...extra } }, continueParams)).toThrow()
    }
  })

  it('rejects foreign Browser, operation, target and continuation replies at the public client boundary', () => {
    for (const run of [{ ...summary, browserId: 'another-source' }, { ...summary, operationId: 'another-operation' }]) {
      expect(() => parseRpcControlResult('browser.task.parallel-stop', { run }, stopParams)).toThrow()
      expect(() => parseRpcControlResult('browser.task.parallel-continue', { run, continuation }, continueParams)).toThrow()
    }
    for (const foreign of [{ ...continuation, id: 'another-continuation' }, { ...continuation, targetId: 'another-target' }]) {
      expect(() => parseRpcControlResult('browser.task.parallel-continue', { run: summary, continuation: foreign }, continueParams)).toThrow()
    }
    for (const foreign of [
      { ...inspection, continuation: { ...continuation, id: 'another-continuation' } },
      { ...inspection, run: { ...summary, operationId: 'another-operation' } },
      { ...inspection, page: { ...inspection.page, after: 'another-target' } }
    ]) expect(() => parseRpcControlResult('browser.task.parallel-inspect', { inspection: foreign }, inspectParams)).toThrow()
  })

  it('rejects extra result-envelope authority fields rather than silently dropping them', () => {
    expect(() => parseRpcControlResult('browser.task.parallel-continue', { run: summary, continuation, approved: true }, continueParams)).toThrow()
    expect(() => parseRpcControlResult('browser.task.parallel-stop', { run: summary, approved: true }, stopParams)).toThrow()
    expect(() => parseRpcControlResult('browser.task.parallel-inspect', { inspection, approved: true }, inspectParams)).toThrow()
  })

  it('makes the real public service reject a foreign continuation receipt before returning success', async () => {
    const service = new AgentMuxRpcService({ coreClients: () => [], execute: async () => ({ operation: 'browser.task.parallel-continue', run: summary,
      continuation: { ...continuation, targetId: 'another-target' } }) })
    services.push(service)
    await expect(service.call('browser.task.parallel-continue', continueParams)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  })

  it('routes compiled CLI stop, continuation and repeated read-only receipt queries through the original public service', async () => {
    const controls: AgentMuxControlRequest[] = []
    const service = new AgentMuxRpcService({ coreClients: () => [], execute: async request => {
      controls.push(request)
      if (request.operation === 'browser.task.parallel-stop') return { operation: request.operation, run: summary }
      if (request.operation === 'browser.task.parallel-continue') return { operation: request.operation, run: summary, continuation }
      if (request.operation === 'browser.task.parallel-inspect') return { operation: request.operation, inspection }
      throw new Error('Unexpected original owner operation')
    } })
    services.push(service)
    type Method = 'browser.task.parallel-stop' | 'browser.task.parallel-continue' | 'browser.task.parallel-inspect'
    const probe = new ObjectCliProbe(request => service.call(request.method as Method, request.params as AgentMuxRpcParams<Method>))
    probes.push(probe); await probe.start()
    const commands = [
      ['parallel-stop', '--browser', browserId, '--operation-id', operationId],
      ['parallel-continue', '--browser', browserId, '--operation-id', operationId, '--target', targetId, '--input', '-'],
      ...Array.from({ length: 2 }, () => ['parallel-inspect', '--browser', browserId, '--operation-id', operationId, '--continuation-id', input.continuationId, '--limit', '1'])
    ]
    for (const args of commands) {
      const result = await probe.run(['browser', 'task', ...args], args[0] === 'parallel-continue' ? JSON.stringify(input) : '')
      expect(result.code, result.stderr).toBe(0)
      const body = JSON.parse(result.stdout).result
      if (args[0] === 'parallel-continue') expect(body).toEqual({ run: summary, continuation })
      else if (args[0] === 'parallel-inspect') expect(body.inspection).toEqual(inspection)
      else expect(body.run).toEqual(summary)
      expect(result.stdout).not.toContain(input.parameters.value)
      expect(result.stdout).not.toContain(input.calls['original-call'].items[0]!.parameters.value)
    }
    expect(probe.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'browser.task.parallel-stop', params: stopParams },
      { method: 'browser.task.parallel-continue', params: continueParams },
      { method: 'browser.task.parallel-inspect', params: inspectParams },
      { method: 'browser.task.parallel-inspect', params: inspectParams }
    ])
    expect(controls.map(request => request.operation)).toEqual(probe.requests.map(request => request.method))
    expect(controls.filter(request => request.operation === 'browser.task.parallel-continue')).toHaveLength(1)
    const before = probe.requests.length
    const forged = await probe.run(['browser', 'task', 'parallel-continue', '--browser', browserId, '--operation-id', operationId, '--target', targetId, '--input', '-'], JSON.stringify({ ...input, approved: true }))
    expect(forged.code).toBe(1); expect(probe.requests).toHaveLength(before)
    const unbound = await probe.run(['browser', 'task', 'parallel-inspect', '--browser', browserId, '--continuation-id', input.continuationId])
    expect(unbound.code).toBe(1); expect(probe.requests).toHaveLength(before)
    expect(agentMuxCommandHelp('browser.task.parallel-continue')).toContain('continuationId')
    expect(agentMuxCommandHelp('browser.task.parallel-inspect')).toContain('--continuation-id')
    expect(agentMuxCommandHelp('browser.task.parallel-stop')).toContain('--operation-id')
  }, 45_000)

  it('makes the actual RPC client reject a foreign wire target without another mutation or inspection', async () => {
    const probe = new ObjectCliProbe(() => ({ run: summary, continuation: { ...continuation, targetId: 'another-target' } }))
    probes.push(probe); await probe.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath } })
    try {
      await expect(client.call('browser.task.parallel-continue', continueParams)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      expect(probe.requests.map(request => request.method)).toEqual(['browser.task.parallel-continue'])
    } finally { await client.dispose() }
  })
})
