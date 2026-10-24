import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { mobileRelease, mobileWebFixture } from './helpers/mobile-web-fixture.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('rejects cross-Host and escaped publication intents and device authority without taking away healthy original capabilities', async () => {
  const f = await mobileWebFixture(); cleanup.push(f.close)
  const manifest = await mobileRelease(join(f.native.root, 'security-candidate'), 'security-build')
  const original = { hostId: 'local', operationId: 'security-original', candidatePath: 'security-candidate',
    candidateDigest: manifest.digest, expectedActiveRevision: 0 }
  const env = { ...f.native.env, ...f.managedEnv }
  const activate = (input: unknown) => runCompiledObjectCli(['app', 'mobile', 'assets', 'activate', '--input', '-'], env, JSON.stringify(input))
  const crossHost = await activate({ ...original, hostId: 'another-host', operationId: 'security-cross-host' })
  expect(crossHost.code).toBe(1); expect(JSON.parse(crossHost.stderr).error.code).toBe('CONTROL_PERMISSION_DENIED')
  for (const [index, candidatePath] of [join(f.native.root, 'security-candidate'), '../security-candidate', 'security-candidate/../security-candidate'].entries()) {
    const escaped = await activate({ ...original, operationId: 'security-escaped-' + index, candidatePath })
    expect(escaped.code).toBe(1); expect(JSON.parse(escaped.stderr).error.code).toBe('INVALID_CONTROL_REQUEST')
  }
  const phone = await f.relay()
  await expect(phone.call('app.mobile.assets.activate', { ...original, operationId: 'security-device' })).rejects.toMatchObject({ code: 'MANAGED_AGENT_CONTEXT_REQUIRED' })
  expect((await phone.call('runtime.owner.identity', {})).owner.runtimeId).toBe(f.native.owner.runtimeId)
  const good = await activate(original)
  expect(good.code, good.stderr).toBe(0)
  expect(JSON.parse(good.stdout).result).toMatchObject({ status: 'active', operationId: original.operationId })
  expect((await f.client.statusAgent(f.session.agentSessionId)).run).toMatchObject({ runId: f.session.run.runId, state: 'running' })
})
