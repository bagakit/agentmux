import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { defaultAgentMuxControlSocketPath } from '@agentmux/core'
import { macosHostService } from '@agentmux/host/macos-service'
import { privatePackageSmokeEnvironment } from '../scripts/package-smoke-context.mjs'

const source = await readFile(process.env.AGENTMUX_PACKAGE_SMOKE_SOURCE ?? new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const functions = ['cleanupSmokeHost', 'verifyLaunchServices'].map(name => {
  const declarations = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name)
  assert.equal(declarations.length, 1)
  return declarations[0]!.getText(ast)
}).join('\n')

function smoke(options: { stopFailure?: Error; inspectFailure?: Error; registrationFailure?: Error; primary?: Error; liveEndpoint?: boolean } = {}) {
  const root = join(tmpdir(), 'amx-private-smoke-fixture'), app = join(root, 'AgentMux.app')
  const runtimeRoot = join(root, 'runtime'), verification = join(root, 'verification')
  const executable = join(app, 'Contents/MacOS/AgentMux'), daemonPath = join(app, 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux/fixture/bin/ctxmuxd')
  const owner = { owner: { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', processId: 83 },
    storePath: join(verification, 'user-data/agent-sessions.json'), process: { uid: process.getuid!(), pid: 83, ppid: 1, birth: 'original-birth' } }
  let launched = false, registered = false
  const events: string[] = [], services: ReturnType<typeof macosHostService>[] = []
  const inspect = vi.fn(async () => { events.push('inspect'); if (options.inspectFailure) throw options.inspectFailure; return owner })
  const stop = vi.fn(async () => { events.push('bootout-owner'); if (options.stopFailure) throw options.stopFailure; registered = false })
  const nativeCleanup = vi.fn(async () => { events.push('ctxmux-cleanup'); return { status: 'exited', signals: [], exitConfirmed: true } })
  const rm = vi.fn(async () => {})
  const ports = {
    assert, join, realpath: async (path: string) => path, mkdir: async () => {}, writeFile: async () => {}, rm,
    defaultAgentMuxControlSocketPath, privatePackageSmokeEnvironment,
    macosHostService: (input: Parameters<typeof macosHostService>[0]) => { const service = macosHostService(input); services.push(service); return service },
    macosHostServiceRegistration: async () => { events.push('registration'); if (launched && options.registrationFailure) throw options.registrationFailure; return registered ? { pid: 83 } : null },
    inspectMacosHostService: inspect, stopMacosHostService: stop,
    probeSocketLiveness: async () => options.liveEndpoint ? 'alive' : 'dead',
    createPrivateRuntimeScope: async () => ({ directory: runtimeRoot, socketPath: join(runtimeRoot, 'ctxmux.sock'), daemonPath,
      observeOwner: async () => {}, cleanup: nativeCleanup }),
    processIdsForApplication: async () => [], waitForProcessExit: async () => [], cleanupProcessScope: async () => [],
    waitForPath: async () => true, pathExists: async () => false,
    readFile: async (path: string) => JSON.stringify(path.endsWith('desktop-ready.json')
      ? { productName: 'AgentMux', version: 'fixture', packaged: true, executable }
      : { daemonPath, socketPath: join(runtimeRoot, 'ctxmux.sock') }),
    run: async () => { launched = true; registered = true; if (options.primary) throw options.primary },
    process: { env: { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'unrelated-runtime') }, stdout: { write: () => {} } },
    PRODUCT_NAME: 'AgentMux', manifest: { version: 'fixture' }
  }
  const invoke = new Function(...Object.keys(ports), functions + '\nreturn verifyLaunchServices')(...Object.values(ports))
  return { result: invoke(app, verification), services, owner, inspect, stop, nativeCleanup, rm, events, runtimeRoot, verification, executable }
}

it('the real smoke consumer removes only its exact private service before the original ctxmux cleanup', async () => {
  const f = smoke(); await expect(f.result).resolves.toBeUndefined()
  expect(f.services).toHaveLength(1)
  const service = f.services[0]!
  expect(service.socketPath).toBe(join(f.runtimeRoot, 'control.sock'))
  expect(service.storePath).toBe(join(f.verification, 'user-data/agent-sessions.json'))
  expect(service.executable).toBe(f.executable)
  expect(f.inspect).toHaveBeenCalledWith(service)
  expect(f.stop).toHaveBeenCalledWith(service, f.owner)
  expect(f.events.indexOf('bootout-owner')).toBeLessThan(f.events.indexOf('ctxmux-cleanup'))
  expect(f.nativeCleanup).toHaveBeenCalledOnce()
  expect(f.rm).toHaveBeenCalledWith(f.runtimeRoot, { recursive: true, force: true })
})

it.each(['inspectFailure', 'stopFailure', 'registrationFailure'] as const)('retains the exact Runtime when the original service %s is unconfirmed', async field => {
  const failure = new Error('original service owner unconfirmed'), f = smoke({ [field]: failure })
  const error = await f.result.catch((error: unknown) => error)
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toContain(failure)
  expect(error).toMatchObject({ privateSmokeCleanup: { status: 'unconfirmed', hostStopped: false } })
  expect(f.nativeCleanup).not.toHaveBeenCalled()
  expect(f.rm).not.toHaveBeenCalled()
})

it('keeps the primary verification failure before an independent cleanup error', async () => {
  const primary = new Error('original launch request failed'), cleanup = new Error('original owner changed')
  const f = smoke({ primary, stopFailure: cleanup }), error = await f.result.catch((error: unknown) => error)
  expect((error as AggregateError).errors[0]).toMatchObject({ cause: primary })
  expect((error as AggregateError).errors[1]).toBe(cleanup)
  expect(f.nativeCleanup).not.toHaveBeenCalled()
})

it('does not stop the private Runtime while the original semantic endpoint is still live', async () => {
  const f = smoke({ liveEndpoint: true })
  await expect(f.result).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'Launch smoke private Host endpoint exit is unconfirmed.' })] })
  expect(f.nativeCleanup).not.toHaveBeenCalled(); expect(f.rm).not.toHaveBeenCalled()
})
