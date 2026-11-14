// @vitest-environment happy-dom
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { parseMoteQuickDefaults } from '../../../packages/core/src/mote-preferences.js'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser.js'
import { rpcControlRequest, rpcControlResult, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { moteAppearanceSource } from './fixtures/mote-current-expression'
import { readMotePresentation } from '../src/renderer/src/lib/mobile-presentation'
import { executeSpatialControl, type SpatialControlPorts } from '../src/renderer/src/lib/space-agent-control'
import { prepareSourceCoreCli } from './helpers/source-core-cli.mjs'

let cli: Awaited<ReturnType<typeof prepareSourceCoreCli>>
beforeAll(async () => {
  cli = await prepareSourceCoreCli()
  if (process.env.SPATIAL_MOTE_CLI_RECEIPT) await writeFile(process.env.SPATIAL_MOTE_CLI_RECEIPT, JSON.stringify(cli) + '\n')
}, 60000)
afterAll(async () => { await cli?.cleanup() })

// Synthetic owner values; no preferences or identities copied from the live catalog.
const defaults = parseMoteQuickDefaults({ executorId: 'fixture', recovery: 'on-open',
  conversation: { hostId: 'local', sessionId: 'saved-original', displayWorkspaceId: 'saved-workspace', groupId: 'saved-group', tabId: 'saved-tab', regionId: 'saved-region' },
  conversationRevision: 'revision-original', conversationTransition: { operationId: 'transition-original', intentDigest: 'intent-original', effectiveAt: 1000 },
  presence: { enabled: true, intervalMs: 120000 }, conversationRollover: { kind: 'idle', idleMs: 60000 } })
function ownerSource() {
  const original = moteAppearanceSource()
  if (!original.target) throw new Error('The synthetic original Mote must be present')
  const target = original.target
  const topic = { ...original.topic, quickMode: { status: 'saved' as const, version: 'document-original', defaults } }
  const reads = vi.fn((catalog: Parameters<typeof readMotePresentation>[1]) => readMotePresentation(original.state, catalog, [topic]))
  const lifecycle = vi.fn(() => { throw new Error('A presentation read must preserve Agent lifecycle, selection and files') })
  const ports = { get: () => original.state, topics: async () => [topic], motePresentation: reads,
    patch: lifecycle, launch: lifecycle, creationSessionId: lifecycle, creation: lifecycle, createResource: lifecycle,
    attach: lifecycle, save: lifecycle, focus: lifecycle, isFocused: () => false, notice: lifecycle, closing: () => false } as unknown as SpatialControlPorts
  const read = async (presentation = true) => {
    const request = rpcControlRequest('space.ls', { target: { spaceId: target.key }, ...(presentation ? { presentation: true } : {}) })
    if (request.operation !== 'space.ls') throw new Error('Expected the original catalog read')
    const result = await executeSpatialControl(ports, request)
    if (result.operation !== 'space.ls') throw new Error('Expected the original catalog result')
    return result
  }
  return { ...original, target, topic, reads, lifecycle, ports, read }
}
function decode(result: Awaited<ReturnType<ReturnType<typeof ownerSource>['read']>>) {
  const { operation, ...body } = result
  return parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'original-read', ok: true, operation, result: body })
}
it('original presentation producer and public read preserve every saved defaults field', async () => {
  const owner = ownerSource(), result = await owner.read()
  const receipt = decode(result)
  expect(receipt.ok).toBe(true)
  if (!receipt.ok || receipt.operation !== 'space.ls') throw new Error('Expected original public catalog')
  expect(receipt.result.catalog.motePresentation).toHaveLength(1)
  expect(receipt.result.catalog.motePresentation![0]!.quickMode).toEqual(owner.topic.quickMode)
  // An unavailable saved occurrence remains a reference, never a launch/focus request.
  expect(receipt.result.catalog.motePresentation![0]!.conversation).toBeNull()
  expect(owner.reads).toHaveBeenCalledTimes(1)
  expect((await owner.read(false)).catalog.motePresentation).toBeUndefined()
  expect(owner.reads).toHaveBeenCalledTimes(1); expect(owner.lifecycle).not.toHaveBeenCalled()
})
it('strict public consumers retain invalid defaults and conversation mismatch rejection', async () => {
  const owner = ownerSource(), result = await owner.read()
  const presentation = result.catalog.motePresentation![0]!
  const invalid = [ { ...defaults, extraAuthority: true }, { ...defaults, presence: { enabled: true, intervalMs: 1 } },
    { ...defaults, conversationTransition: { operationId: 'original', intentDigest: 'original', effectiveAt: -1 } } ]
  for (const bad of invalid) {
    const value = { ...result, catalog: { ...result.catalog, motePresentation: [{ ...presentation, quickMode: { ...owner.topic.quickMode, defaults: bad } }] } }
    expect(() => parseMoteQuickDefaults(bad)).toThrow()
    expect(() => decode(value)).toThrow()
    expect(() => parseRpcControlResult('space.ls', rpcControlResult('space.ls', value), { target: {}, presentation: true })).toThrow()
  }
  const mismatch = { ...result, catalog: { ...result.catalog, motePresentation: [{ ...presentation, conversation: { ...defaults.conversation!, regionId: 'different-region' } }] } }
  expect(() => decode(mismatch)).toThrow('Confirmed Mote conversation differs from its saved reference')
  expect(owner.lifecycle).not.toHaveBeenCalled()
})
it('fresh Source CLI reads the original presentation owner without changing topology or lifecycle', async () => {
  const owner = ownerSource()
  const probe = new ObjectCliProbe(async request => {
    if (request.method !== 'space.ls') throw new Error('Expected the original read method')
    const input = rpcControlRequest('space.ls', request.params)
    if (input.operation !== 'space.ls') throw new Error('Expected the original catalog read')
    const result = await executeSpatialControl(owner.ports, input)
    if (result.operation !== 'space.ls') throw new Error('Expected the original catalog result')
    // Existing public receipt consumer rejects malformed owner output before delivery.
    decode(result)
    return rpcControlResult('space.ls', result)
  })
  await probe.start()
  try {
    const run = (args: string[]) => promisify(execFile)(process.execPath, [cli.cliPath, ...args], { env: probe.environment(), timeout: 15000 })
    const presentation = await run(['space', 'ls', '--space', owner.target.key, '--presentation'])
    expect(presentation.stderr).toBe('')
    expect(JSON.parse(presentation.stdout).result.catalog.motePresentation[0].quickMode).toEqual(owner.topic.quickMode)
    expect(probe.requests.at(-1)?.params.presentation).toBe(true)
    const topology = await run(['space', 'ls', '--space', owner.target.key])
    expect(JSON.parse(topology.stdout).result.catalog.motePresentation).toBeUndefined()
    expect(probe.requests.at(-1)?.params).not.toHaveProperty('presentation')
    expect(owner.reads).toHaveBeenCalledTimes(1); expect(owner.lifecycle).not.toHaveBeenCalled()
  } finally { await probe.stop() }
}, 30000)
