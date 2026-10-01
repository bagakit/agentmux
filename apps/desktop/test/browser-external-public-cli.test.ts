import { spawn } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, parseAgentMuxControlRequest } from '../../../packages/core/src/control-host.js'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest } from '../../../packages/core/src/control.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'

const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url))
const { build } = require('esbuild')
let directory: string
let cli: string
let server: AgentMuxControlServer
const seen: AgentMuxControlRequest[] = []
let wrongWorkspace = false
let invalidSource = false
const external = { id: 'original-shared-target', workspaceId: 'workspace-one', source: 'external', status: 'ready',
  url: 'https://fixture.invalid/form', title: 'Fixture', navigationId: 'document-one', capabilities: ['snapshot', 'js'], cdpMethods: ['Runtime.evaluate'] } as const
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentmux-external-cli-source-'))
  cli = join(directory, 'agentmux.mjs')
  await symlink(fileURLToPath(new URL('../../../packages/core/node_modules', import.meta.url)), join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: [fileURLToPath(new URL('../../../packages/core/src/agentmux.ts', import.meta.url))],
    outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], async execute(request) {
    seen.push(request)
    if (request.operation === 'browser.targets') return { operation: request.operation,
      targets: wrongWorkspace ? [{ ...external, workspaceId: 'another-workspace' }] : invalidSource ? [{ ...external, source: 'invented-active-tab' } as any] : !request.workspaceId || request.workspaceId === external.workspaceId ? [external] : [] }
    if (request.operation === 'browser.run') return { operation: request.operation, result: { target: request.browserId, code: request.code }, logs: [], outcome: { kind: 'completed' }, runOperation: { id: request.operationId ?? 'source-operation', browserId: request.browserId, operator: { id: 'protocol-fixture', name: 'Protocol fixture' }, startedAt: 1, finishedAt: 2, phase: 'completed', summary: 'Source protocol receipt', url: external.url, steps: [] } }
    throw new Error(`Unexpected control operation ${request.operation}`)
  } })
  await server.start()
}, 15_000)
afterAll(async () => { await server?.stop(); if (directory) await rm(directory, { recursive: true }) })
async function run(args: string[], code = '') {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: directory,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_STATE_DIRECTORY: join(directory, 'state'), AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Source CLI did not finish its bounded request.')) }, 10_000)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); resolve({ code: code ?? -1, stdout, stderr }) })
    child.stdin.end(code)
  })
}
function receipt(output: Awaited<ReturnType<typeof run>>) {
  expect(output.code, output.stderr).toBe(0)
  const value = objectCliReceipt(JSON.parse(output.stdout))
  expect(value.ok).toBe(true)
  if (!value.ok) throw new Error(value.error.message)
  return value
}
describe('actual Source public Browser targets CLI', () => {
  it('routes typed SDK discovery through the same JSON-RPC owner and rejects another Workspace result or extra fields', async () => {
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      expect(await client.call('browser.targets', { workspaceId: 'workspace-one' })).toEqual({ targets: [external] })
      wrongWorkspace = true
      await expect(client.call('browser.targets', { workspaceId: 'workspace-one' })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      wrongWorkspace = false
      invalidSource = true
      await expect(client.call('browser.targets', { workspaceId: 'workspace-one' })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      invalidSource = false
      const start = seen.length
      await expect(client.call('browser.targets', { workspaceId: 'workspace-one', activeTab: true } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      expect(seen.slice(start)).toEqual([])
    } finally { wrongWorkspace = false; invalidSource = false; await client.dispose() }
  })
  it('discovers an explicitly shared target and sends only its exact chosen id through the original run command', async () => {
    const start = seen.length
    const listed = receipt(await run(['browser', 'targets', '--workspace', 'workspace-one']))
    expect(listed.operation).toBe('browser.targets')
    expect(listed.result).toEqual({ targets: [external] })
    const program = 'return await snapshot();\n// literal $data and `syntax`'
    const result = receipt(await run(['browser', 'run', '--browser', external.id, '--operation-id', 'source-operation'], program))
    expect(result.result).toEqual(expect.objectContaining({ result: { target: external.id, code: program }, logs: [], outcome: { kind: 'completed' }, runOperation: expect.objectContaining({ id: 'source-operation', browserId: external.id }) }))
    expect(seen.slice(start).map(({ requestId, ...row }) => row)).toEqual([
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'browser.targets', workspaceId: 'workspace-one' },
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'browser.run', browserId: external.id, operationId: 'source-operation', code: program }
    ])
  })
  it('retains honest source/status/navigation and an embedded null Workspace, while refusing duplicate or invented facts', () => {
    const embedded = { ...external, id: 'embedded-page', source: 'embedded', workspaceId: null, status: 'unavailable', warning: 'Original page unavailable' }
    expect(parseBrowserTargetsResult({ targets: [external, embedded] })).toEqual({ targets: [external, embedded] })
    for (const targets of [[external, external], [{ ...external, workspaceId: null }], [{ ...external, source: 'active-tab' }], [{ ...external, status: 'guessed-ready' }], [{ ...external, capabilities: ['invented'] }]]) {
      expect(() => parseBrowserTargetsResult({ targets })).toThrow()
    }
    const offline = { ...external, status: 'disconnected', warning: 'Reconnect the original shared tab' }
    expect(parseBrowserTargetsResult({ targets: [offline] })).toEqual({ targets: [offline] })
  })
  it('supports bounded read-only discovery without selecting, sharing or focusing a tab', async () => {
    const start = seen.length
    expect(receipt(await run(['browser', 'targets', '--workspace', 'absent-workspace'])).result).toEqual({ targets: [] })
    expect(receipt(await run(['browser', 'targets'])).result).toEqual({ targets: [external] })
    expect(seen.slice(start).map(row => row.operation)).toEqual(['browser.targets', 'browser.targets'])
    expect(() => parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'bad-target-read', operation: 'browser.targets', workspaceId: '' })).toThrow()
  })
})
