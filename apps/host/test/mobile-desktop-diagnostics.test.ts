import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { connectRelayHostedClient } from '../../../packages/core/src/relay-hosted.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import type { AgentMuxClientIncidentTarget } from '../../../packages/core/src/client-incident.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { ClientIncidentArchive } from '../src/client-incident-archive.js'
import { createHostMobileIncidents } from '../src/mobile-incidents.js'
import { MobileWebReporter } from '../../mobile/src/mobile-web/reporter.js'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'
const WebSocket = createRequire(join(process.cwd(), 'packages/relay/package.json'))('ws')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const selector = (ref: { logId: string; authority: { kind: string; id: string } }): AgentMuxClientIncidentTarget =>
  ({ domain: 'client.incident', hostId: 'local', logId: ref.logId, authority: { kind: ref.authority.kind, id: ref.authority.id } })

it('actual Mobile reporter and exact diagnostic references retain their original owners across Desktop exit', async () => {
  const f = await mobileWebFixture(); cleanup.push(f.close)
  const connect = async () => {
    const controller = new AbortController()
    const phone = await connectRelayHostedClient({ offer: f.info.offer, name: 'Private Mobile diagnostic reader', signal: controller.signal, createWebSocket: url => new WebSocket(url) })
    cleanup.push(async () => { controller.abort(); await phone.dispose() }); return phone
  }
  const phone = await connect()
  const page = { documentId: 'original-mobile-document', buildId: 'original-mobile-build', namespaceDigest: 'sha256:' + 'a'.repeat(64) }
  const reporter = new MobileWebReporter(page); cleanup.push(() => reporter.dispose())
  reporter.bindClient(phone); reporter.setConnected(true)
  reporter.observeCatalog({ spaces: [{ spaceId: 'original-space', issue: { code: 'CONTROL_UNAVAILABLE' } }] } as any)
  const receipt = await until(async () => reporter.snapshot(), state => Boolean(state.receipt) || Boolean(state.issue), 'the actual Mobile reporter confirms its original observation without Main')
  expect(receipt.issue).toBeNull(); expect(receipt.receipt).toMatchObject({ accepted: true, producer: { documentId: page.documentId } })
  expect(receipt.receipt?.producer.devicePrincipalId).toEqual(expect.any(String))
  const original = selector(receipt.receipt!.recordRef as any)
  const inspect = async (target: AgentMuxClientIncidentTarget) => (await phone.forwardRpc('system.diagnostics.inspect', { target, includeRaw: false })).reads[0]!
  const exact = await until(() => inspect(original), read => read.availability === 'found', 'the exact Host reference remains readable')
  expect(exact).toMatchObject({ availability: 'found', authorityStatus: 'verified', completeness: 'complete', readAuthority: original.authority,
    data: { producer: { kind: 'mobile-web', ...page, devicePrincipalId: receipt.receipt!.producer.devicePrincipalId }, report: { mobile: { kind: 'catalog-partial' } } } })
  const recent: AgentMuxClientIncidentTarget = { domain: 'client.incident', hostId: 'local', recent: { limit: 8 } }
  const unscopedBefore = await inspect(recent)
  expect(unscopedBefore).toMatchObject({ availability: 'found', completeness: 'partial', issue: { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE' } })
  expect(unscopedBefore.data).toMatchObject({ items: [expect.objectContaining({ recordRef: expect.objectContaining({ logId: original.logId }) })] })
  const hostRecent = await inspect({ ...recent, authority: original.authority })
  expect(hostRecent).toMatchObject({ readAuthority: original.authority, completeness: 'complete', issue: null })
  expect(await inspect({ domain: 'client.incident', hostId: 'local', logId: original.logId })).toMatchObject({ availability: 'unavailable', authorityStatus: 'unconfirmed', issue: { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE' } })

  await f.startMain()
  const state = f.native.env.AGENTMUX_STATE_DIRECTORY!
  const main = JSON.parse(await readFile(join(state, 'mobile-test-main-incident.json'), 'utf8'))
  const mainIndex = await readFile(join(state, 'client-incidents/index.json'), 'utf8')
  const mainRead = await inspect(selector(main.recordRef))
  expect(mainRead).toMatchObject({ availability: 'found', readAuthority: main.authority, data: { producer: { kind: 'main', producerInstanceId: 'original-main-producer' } } })
  expect(await readFile(join(state, 'client-incidents/index.json'), 'utf8')).toBe(mainIndex)
  const desktop = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.native.socketPath + '.desktop' } }); cleanup.push(() => desktop.dispose())
  const mainDefault = await desktop.call('system.diagnostics.inspect', { target: recent })
  expect(mainDefault.reads[0]).toMatchObject({ readAuthority: original.authority, completeness: 'partial' })
  expect(mainDefault.reads[0]!.data).toMatchObject({ items: [expect.objectContaining({ recordRef: expect.objectContaining({ logId: original.logId }) })] })
  expect((await desktop.call('system.diagnostics.inspect', { target: original })).reads[0]).toMatchObject({ availability: 'found', readAuthority: original.authority })
  expect((await inspect(recent)).data).toEqual(unscopedBefore.data)
  await desktop.dispose(); await f.stopMain()
  expect(await inspect(selector(main.recordRef))).toMatchObject({ availability: 'unavailable', issue: { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE' } })
  expect(await inspect({ ...recent, authority: { kind: main.authority.kind, id: main.authority.id } })).toMatchObject({ availability: 'unavailable', issue: { code: 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE' } })
  expect(await inspect({ ...recent, authority: { kind: 'client-incident-archive', id: 'unknown-original-archive' } })).toMatchObject({ availability: 'unavailable', issue: { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH' } })
  expect(await inspect(original)).toMatchObject({ availability: 'found', readAuthority: original.authority })
  expect((await inspect(recent)).data).toEqual(unscopedBefore.data)
  const newPhone = await connect(), newReporter = new MobileWebReporter({ ...page, documentId: 'new-mobile-document' }); cleanup.push(() => newReporter.dispose())
  newReporter.bindClient(newPhone); newReporter.setConnected(true)
  newReporter.observeCatalog({ spaces: [{ spaceId: 'original-space', issue: { code: 'CONTROL_UNAVAILABLE' } }] } as any)
  const newReceipt = await until(async () => newReporter.snapshot(), state => Boolean(state.receipt) || Boolean(state.issue), 'a newly authorized Mobile document reports after Main exits')
  expect(newReceipt.issue).toBeNull(); expect(newReceipt.receipt).toMatchObject({ accepted: true, producer: { documentId: 'new-mobile-document' } })
  expect(newReceipt.receipt!.producer.devicePrincipalId).not.toBe(receipt.receipt!.producer.devicePrincipalId)
  const forged = { ...page, occurrenceId: 'forged-device', observedAt: 1, reporter: { droppedCount: 0, queuedCount: 0, queuedBytes: 0 },
    observation: { kind: 'catalog-partial', source: 'space.ls', code: null, issueCount: 1, spaceIds: [], omittedCount: 1 }, devicePrincipalId: 'forged' }
  await expect(phone.forwardRpc('app.mobile.report', forged as any)).rejects.toHaveProperty('code')
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'system', 'diagnostics', 'inspect', '--domain', 'client.incident', '--host-id', 'local', '--recent', '--authority', original.authority!.id, '--limit', '8'], f.native.env)
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.reads[0]).toMatchObject({ readAuthority: original.authority, completeness: 'complete', issue: null })
  expect((await phone.statusAgent(f.session.agentSessionId)).run).toMatchObject({ runId: f.session.run.runId, state: 'running' })
}, 120_000)

it('foreign archive observation preserves the original device fence and cancellation without borrowing another writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-mobile-diagnostics-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const main = new ClientIncidentArchive(join(root, 'main')); await main.flush()
  const original = { domain: 'client.incident' as const, hostId: 'local', recent: {}, authority: { kind: main.authority!.kind, id: main.authority!.id } }
  // A failed new archive must not prevent reads from the independent original Main authority.
  const blocked = join(root, 'blocked'); await writeFile(blocked, 'occupied')
  const abort = new AbortController(), bounds = { signal: new AbortController().signal, maxBytes: 128 * 1024 }
  const principal = { kind: 'device' as const, id: 'original-device' }, assertCurrent = vi.fn(async () => {})
  const disposed = vi.fn(async () => {}), call = vi.fn(async (_method, params, options) => {
    expect(params.target).toEqual(original); expect(options.signal.aborted).toBe(false)
    abort.abort(); return { reads: [] }
  })
  const desktop = vi.fn(async context => { expect(context.principal).toBe(principal); expect(context.assertCurrent).toBe(assertCurrent); return { call, dispose: disposed } })
  const owner = createHostMobileIncidents({ directory: blocked, originalMainDirectory: main.directory, desktop: desktop as any }); cleanup.push(owner.flush)
  const port = await owner.clientIncidents({ transport: 'relay', principal, assertCurrent, signal: abort.signal })
  const read = await port.read(original, bounds)
  expect(read).toMatchObject({ availability: 'unavailable', issue: { code: 'DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED' } })
  expect(call).toHaveBeenCalledTimes(1); expect(disposed).toHaveBeenCalledTimes(1); expect(assertCurrent).toHaveBeenCalledTimes(2)
  const again = await port.read(original, bounds)
  expect(again).toMatchObject({ issue: { code: 'DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED' } }); expect(desktop).toHaveBeenCalledTimes(1)
  const unknown = await (await owner.clientIncidents({ transport: 'relay', principal })).read({ ...original, authority: { kind: main.authority!.kind, id: 'unknown-authority' } }, bounds)
  expect(unknown).toMatchObject({ issue: { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH' } }); expect(desktop).toHaveBeenCalledTimes(1)
})
