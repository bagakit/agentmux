// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { readAgentPresentation } from '../../desktop/src/renderer/src/lib/mobile-presentation'

it('the actual CLI consumes the original App project grouping and state shapes through the strict public service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mobile-presentation-cli-'))
  const state = { config: { workspaces: [{ id: 'project-original', hostId: 'local', path: root, name: 'Original Project', kind: 'folder' }], executors: {}, appearance: {} },
    sessions: [{ kind: 'agent', id: 'original-session', label: 'Original Agent', providerId: 'codex', executorId: 'original', hostId: 'local', workspacePath: root, processState: 'running', capabilities: {}, status: { state: 'running', source: 'run-process', observedAt: Date.now() }, control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-session', run: { runId: 'original-run' } } }], timelines: {}, agentNames: {}, scratchTopicSnapshots: {}, spaceObjectIcons: {}, spaceZoneBindings: {}, tabs: {} } as any
  const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: readAgentPresentation(state) }
  let compiled: string | undefined
  const server = new AgentMuxControlServer({ execute: async request => ({ operation: request.operation, catalog } as never) }, join(root, 'rpc.sock'))
  try {
    const require = createRequire(resolve(import.meta.dirname, '../../desktop/package.json')), { build } = createRequire(require.resolve('vite'))('esbuild')
    await mkdir(resolve(import.meta.dirname, '../../../packages/core/.tmp'), { recursive: true })
    compiled = await mkdtemp(resolve(import.meta.dirname, '../../../packages/core/.tmp/mobile-cli-'))
    const cli = join(compiled, 'cli.mjs')
    await build({ absWorkingDir: resolve(import.meta.dirname, '../../..'), entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli, bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent' })
    await server.start()
    const result = await promisify(execFile)(process.execPath, [cli, 'space', 'ls', '--presentation'], { env: { PATH: process.env.PATH, AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path, AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json') } })
    const receipt = JSON.parse(result.stdout)
    expect(receipt.ok).toBe(true)
    expect(receipt.result.catalog.agentPresentation).toEqual(catalog.agentPresentation)
    expect(receipt.result.catalog.agentPresentation[0].projectGroup.projectId).toBe('project-original')
    expect(receipt.result.catalog.agentPresentation[0].stateMark).toBe('unknown')
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); if (compiled) await rm(compiled, { recursive: true, force: true }) }
}, 30_000)
