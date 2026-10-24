import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile, symlink } from 'node:fs/promises'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { mobileRelease, mobileWebFixture } from './helpers/mobile-web-fixture.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('actual managed CLI keeps its injected Host endpoint and original Main reverse route activates complete HTTP candidates', async () => {
  const f = await mobileWebFixture(); cleanup.push(f.close)
  const env = { ...f.native.env, ...f.managedEnv }
  expect(env.AGENTMUX_RPC_ENDPOINT).toBe('unix:' + f.native.socketPath)
  const invoke = (args: string[], input: unknown, main = false) => runCompiledObjectCli([
    ...(main ? ['--endpoint', 'unix:' + f.native.socketPath + '.desktop'] : []), ...args, '--input', '-'], env, JSON.stringify(input))
  const inspect = await invoke(['app', 'mobile', 'assets', 'inspect'], { hostId: 'local' })
  expect(inspect.code, inspect.stderr).toBe(0); expect(JSON.parse(inspect.stdout).result.active.buildId).toBe('private-initial')
  const initialDocument = await fetch(f.info.origin), initialAsset = new URL('./assets/app.js', initialDocument.url).href
  const manifest = await mobileRelease(join(f.native.root, 'candidate-a'), 'build-a')
  const input = { hostId: 'local', operationId: 'original-activation', candidatePath: 'candidate-a', candidateDigest: manifest.digest, expectedActiveRevision: 0 }
  const activated = await invoke(['app', 'mobile', 'assets', 'activate'], input)
  expect(activated.code, activated.stderr).toBe(0); const receipt = JSON.parse(activated.stdout).result
  expect(receipt).toMatchObject({ status: 'active', activeRevision: 1, candidate: { buildId: 'build-a' }, persistence: 'not-requested' })
  const documentA = await fetch(f.info.origin), assetA = new URL('./assets/app.js', documentA.url).href
  expect(documentA.headers.get('X-AgentMux-Mobile-Build')).toBe('build-a')
  expect(await (await fetch(assetA)).text()).toContain('build-a')
  expect(await (await fetch(initialAsset)).text()).toContain('initialMobileFixture')
  const duplicate = await invoke(['app', 'mobile', 'assets', 'activate'], input)
  expect(duplicate.code, duplicate.stderr).toBe(0); expect(JSON.parse(duplicate.stdout).result).toEqual(receipt)
  const reordered = await invoke(['app', 'mobile', 'assets', 'activate'], Object.fromEntries(Object.entries(input).reverse()))
  expect(reordered.code, reordered.stderr).toBe(0); expect(JSON.parse(reordered.stdout).result).toEqual(receipt)
  await f.startMain()
  const next = await mobileRelease(join(f.native.root, 'candidate-b'), 'build-b')
  const mainResult = await invoke(['app', 'mobile', 'assets', 'activate'], { ...input, operationId: 'main-original-activation',
    candidatePath: 'candidate-b', candidateDigest: next.digest, expectedActiveRevision: 1 }, true)
  expect(mainResult.code, mainResult.stderr).toBe(0); expect(JSON.parse(mainResult.stdout).result).toMatchObject({ status: 'active', activeRevision: 2, candidate: { buildId: 'build-b' } })
  expect((await fetch(f.info.origin)).headers.get('X-AgentMux-Mobile-Build')).toBe('build-b')
  expect((await fetch(initialAsset)).status).toBe(410)
  const mainInspect = await invoke(['app', 'mobile', 'assets', 'inspect'], { hostId: 'local', operationId: 'main-original-activation' }, true)
  expect(mainInspect.code, mainInspect.stderr).toBe(0); expect(JSON.parse(mainInspect.stdout).result.operation.receipt).toEqual(JSON.parse(mainResult.stdout).result)
  const raw = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.native.socketPath } }); cleanup.push(() => raw.dispose())
  await expect(raw.call('app.mobile.assets.activate', { ...input, operationId: 'unmanaged-publish', expectedActiveRevision: 2 })).rejects.toMatchObject({ code: 'MANAGED_AGENT_CONTEXT_REQUIRED' })
  const bad = await mobileRelease(join(f.native.root, 'bad-candidate'), 'bad-build')
  await writeFile(join(f.native.root, 'bad-candidate/assets/app.js'), 'same-size-wrong-byte'.padEnd(bad.files[0]!.bytes, 'x').slice(0, bad.files[0]!.bytes))
  const rejected = await invoke(['app', 'mobile', 'assets', 'activate'], { ...input, operationId: 'bad-digest', candidatePath: 'bad-candidate', candidateDigest: bad.digest, expectedActiveRevision: 2 })
  expect(rejected.code, rejected.stderr).toBe(0); expect(JSON.parse(rejected.stdout).result).toMatchObject({ status: 'rejected', reason: 'candidate-invalid', activeRevision: 2 })
  await symlink(join(f.native.root, 'candidate-b'), join(f.native.root, 'symlink-candidate'))
  const symlinked = await invoke(['app', 'mobile', 'assets', 'activate'], { ...input, operationId: 'symlink-source', candidatePath: 'symlink-candidate', candidateDigest: next.digest, expectedActiveRevision: 2 })
  expect(JSON.parse(symlinked.stdout).result).toMatchObject({ status: 'rejected', reason: 'candidate-invalid' })
  expect((await f.client.statusAgent(f.session.agentSessionId)).run).toMatchObject({ runId: f.session.run.runId, state: 'running' })
})

it('real encrypted device reports retain exact producer/build in the original Main archive and original diagnostics CLI', async () => {
  const f = await mobileWebFixture(); cleanup.push(f.close)
  const phone = await f.relay()
  const loadedInput = { documentId: 'original-phone-document', buildId: 'old-actually-loaded-build', namespaceDigest: 'sha256:' + 'a'.repeat(64), occurrenceId: 'loaded-once', observedAt: 10 }
  const loaded = await phone.call('app.mobile.assets.loaded', loadedInput)
  expect(loaded).toMatchObject({ hostId: 'local', accepted: true, buildId: loadedInput.buildId, producer: { documentId: loadedInput.documentId } })
  const base = { documentId: loadedInput.documentId, buildId: loadedInput.buildId, namespaceDigest: loadedInput.namespaceDigest, observedAt: 11,
    reporter: { droppedCount: 0, queuedCount: 1, queuedBytes: 100 } }
  const partial = { ...base, occurrenceId: 'catalog-original-occurrence', observation: { kind: 'catalog-partial' as const, source: 'space.ls' as const,
    code: null, issueCount: 1, spaceIds: ['["local","/private/explicit-steer"]'], omittedCount: 0 } }
  await expect(phone.call('app.mobile.report', partial)).rejects.toHaveProperty('code')
  expect((await phone.call('runtime.owner.identity', {})).owner.runtimeId).toBe(f.native.owner.runtimeId)
  await f.startMain()
  const firstReport = phone.call('app.mobile.report', partial)
  await expect(firstReport).resolves.toMatchObject({ accepted: true })
  const first = await firstReport
  expect(first).toMatchObject({ hostId: 'local', accepted: true, producer: loaded.producer, recordRef: { domain: 'client.incident', logId: first.logId } })
  const connected = await phone.call('app.mobile.report', { ...base, occurrenceId: 'connection-original-occurrence',
    observation: { kind: 'connection-state', source: 'connection-state', code: null, state: 'lost', boundary: 'core-ctxmux' } })
  expect(connected.accepted).toBe(true)
  const env = { ...f.native.env, ...f.managedEnv }
  const input = { target: { domain: 'client.incident', hostId: 'local', recent: { limit: 8,
    producer: { kind: 'mobile-web', ...loaded.producer, buildId: loadedInput.buildId } } }, includeRaw: false }
  const recent = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath + '.desktop', 'system', 'diagnostics', 'inspect', '--input', '-'], env, JSON.stringify(input))
  expect(recent.code, recent.stderr).toBe(0)
  const page = JSON.parse(recent.stdout).result.reads[0].data
  expect(page.items.map((item: any) => item.occurrenceId).sort()).toEqual(['catalog-original-occurrence', 'connection-original-occurrence'])
  const detail = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath + '.desktop', 'system', 'diagnostics', 'inspect', '--input', '-'], env,
    JSON.stringify({ target: { domain: 'client.incident', hostId: first.hostId, logId: first.logId,
      authority: { kind: first.recordRef!.authority.kind, id: first.recordRef!.authority.id } }, includeRaw: false }))
  expect(detail.code, detail.stderr).toBe(0); const record = JSON.parse(detail.stdout).result.reads[0].data
  expect(record.producer).toMatchObject({ kind: 'mobile-web', ...loaded.producer, buildId: loadedInput.buildId })
  expect(record.report.mobile).toEqual(partial.observation); expect(record.report.code).toBeNull()
  expect(JSON.stringify(record)).not.toContain('Filesystem Space discovery is unavailable')
  const exact = await phone.call('app.mobile.assets.inspect', { hostId: loaded.hostId, client: loaded.producer })
  expect(exact.client).toMatchObject({ loaded: { buildId: loadedInput.buildId }, namespace: 'not-retained' })
  const secondPhone = await f.relay()
  await expect(secondPhone.call('app.mobile.assets.inspect', { hostId: loaded.hostId, client: loaded.producer })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(phone.call('app.mobile.report', { ...partial, devicePrincipalId: 'forged' } as any)).rejects.toHaveProperty('code')
  expect((await f.client.statusAgent(f.session.agentSessionId)).run.runId).toBe(f.session.run.runId)
})
