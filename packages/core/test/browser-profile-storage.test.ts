import { expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBrowserProfileStoragePayload, parseBrowserProfileStorageSnapshot, parseBrowserProfileStorageReceipt, parseBrowserProfileStorageResult,
  assertBrowserProfileStorageTarget, type BrowserProfileStorageSnapshot, type BrowserProfileStorageReceipt } from '../src/browser-profile-storage'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../src/control-codec'
import { rpcControlRequest, rpcControlResult, parseRpcControlResult } from '../src/rpc-business-codec'
import { agentMuxCliMatch, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands'

const origin = 'https://offline.example.invalid', otherOrigin = 'https://second.example.invalid'
const storageKeys = [origin + '/', origin + '/^0https://embedding.example.invalid', otherOrigin + '/']
const sites = [{ origin, storageKeys: storageKeys.slice(0, 2) }, { origin: otherOrigin, storageKeys: storageKeys.slice(2) }]
const input = { profileId: 'original-profile', expectedRevision: 'original-revision', operationId: 'original-cleanup', sites }
const usage = { logicalBytes: 6000, allocatedBytes: 8192, complete: true }
const snapshot = (): BrowserProfileStorageSnapshot => ({ profileId: input.profileId, profileRevision: input.expectedRevision, observedAt: 1, usage,
  sites: sites.map(site => ({ ...site, usage })), unattributed: { logicalBytes: 0, allocatedBytes: 0, complete: true }, issues: [] })
const receipt = (): BrowserProfileStorageReceipt => ({ ...input, status: 'completed', requestedAt: 1, finishedAt: 2,
  results: storageKeys.map(storageKey => ({ storageKey, status: 'acknowledged' })), before: snapshot(), after: snapshot(), issues: [] })

it('carries the exact opaque partition set and original operation through public RPC and Control in both directions', () => {
  const request = rpcControlRequest('browser.profile.storage.clear', input)
  expect(request).toMatchObject({ operation: 'browser.profile.storage.clear', ...input })
  expect(parseAgentMuxControlRequest(request)).toEqual(request)
  const result = { operation: 'browser.profile.storage.clear' as const, receipt: receipt() }
  const wire = rpcControlResult('browser.profile.storage.clear', result)
  expect(parseRpcControlResult('browser.profile.storage.clear', wire, input)).toEqual({ receipt: receipt() })
  const inspect = rpcControlRequest('browser.profile.storage.inspect', { profileId: input.profileId, operationId: input.operationId })
  expect(inspect).toMatchObject({ operation: 'browser.profile.storage.inspect', operationId: input.operationId })
  const observation = { operation: 'browser.profile.storage.inspect' as const, snapshot: snapshot(), receipt: receipt(), pending: [] }
  expect(parseBrowserProfileStorageResult(observation.operation, observation)).toEqual(observation)
})

it('accepts a native acknowledgement with unchanged disk usage without claiming freed bytes', () => {
  const parsed = parseBrowserProfileStorageReceipt(receipt())
  expect(parsed.after!.usage).toEqual(parsed.before!.usage)
  const incomplete = snapshot(); incomplete.usage = { logicalBytes: 3000, allocatedBytes: null, complete: false }; incomplete.issues = ['One bucket could not be read']
  expect(parseBrowserProfileStorageSnapshot(incomplete).usage).toEqual(incomplete.usage)
  expect(() => parseBrowserProfileStorageSnapshot({ ...incomplete, usage: { complete: false } })).toThrow()
})

it('rejects expanded authority, empty/duplicate key selections and invalid accounting shapes', () => {
  const clear = { operation: 'browser.profile.storage.clear', ...input }
  for (const bad of [{ ...clear, approved: true }, { ...clear, path: 'outside-profile' }, { ...clear, sites: [] }, { ...clear, sites: [sites[0], sites[0]] }, { ...clear, sites: [{ origin, storageKeys: [] }] }, { ...clear, sites: [{ origin, storageKeys: [storageKeys[0], storageKeys[0]] }] }]) {
    expect(() => parseBrowserProfileStoragePayload(bad)).toThrow()
  }
  const duplicate = snapshot(); duplicate.sites.push({ ...duplicate.sites[0]!, origin: 'https://another.example.invalid' })
  expect(() => parseBrowserProfileStorageSnapshot(duplicate)).toThrow()
  expect(() => parseBrowserProfileStorageSnapshot({ ...snapshot(), usage: { ...usage, allocatedBytes: -1 } })).toThrow()
})

it('refuses receipts for another Profile, origin, operation or storage-key set', () => {
  const request = { operation: 'browser.profile.storage.clear' as const, ...input }
  for (const changed of [{ profileId: 'other-profile' }, { sites: [{ ...sites[0]!, origin: 'https://other.example.invalid' }, sites[1]!] }, { operationId: 'other-operation' }, { expectedRevision: 'other-revision' }, { sites: [{ origin, storageKeys: storageKeys.slice(0, 1) }] }]) {
    expect(() => assertBrowserProfileStorageTarget(request, { operation: request.operation, receipt: { ...receipt(), ...changed } })).toThrow()
  }
  const inspect = { operation: 'browser.profile.storage.inspect' as const, profileId: input.profileId, operationId: input.operationId }
  expect(() => assertBrowserProfileStorageTarget(inspect, { operation: inspect.operation, snapshot: snapshot(), pending: [], receipt: { ...receipt(), operationId: 'other-operation' } })).toThrow()
})

it('cannot call a partial or unknown native outcome completed', () => {
  const original = receipt(); original.results[1] = { storageKey: storageKeys[1]!, status: 'unknown' }
  expect(() => parseBrowserProfileStorageReceipt(original)).toThrow()
  expect(parseBrowserProfileStorageReceipt({ ...original, status: 'partial' }).results[1]!.status).toBe('unknown')
  expect(() => parseBrowserProfileStorageReceipt({ ...receipt(), status: 'cancelled' })).toThrow()
  const envelope = { schemaVersion: 5, requestId: 'transport', ok: true, operation: 'browser.profile.storage.clear', result: { receipt: receipt() } }
  expect(parseAgentMuxControlReceipt(envelope)).toEqual(envelope)
  const r = { ...receipt(), before: { ...snapshot(), profileId: 'foreign-profile' } }
  expect(() => parseAgentMuxControlReceipt({ ...envelope, result: { receipt: r } })).toThrow()
})

it('discovers both actual CLI leaves and preserves literal exact input through their production parser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-storage-cli-'))
  try {
    const path = join(directory, 'input.json'); await writeFile(path, JSON.stringify(input))
    const selected = agentMuxCliMatch(['browser', 'profile', 'storage', 'clear', '--input', path])
    expect(selected?.command.method).toBe('browser.profile.storage.clear')
    const parsed = await parseAgentMuxCliInvocation(['browser', 'profile', 'storage', 'clear', '--input', path])
    expect(parsed).toMatchObject({ command: { method: 'browser.profile.storage.clear' }, params: input })
    await writeFile(path, JSON.stringify({ profileId: input.profileId, operationId: input.operationId }))
    const read = await parseAgentMuxCliInvocation(['browser', 'profile', 'storage', 'inspect', '--input', path])
    expect(read).toMatchObject({ command: { method: 'browser.profile.storage.inspect' }, params: { profileId: input.profileId, operationId: input.operationId } })
    await writeFile(path, JSON.stringify({ ...input, operation: 'browser.profile.storage.clear' }))
    await expect(parseAgentMuxCliInvocation(['browser', 'profile', 'storage', 'clear', '--input', path])).rejects.toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
