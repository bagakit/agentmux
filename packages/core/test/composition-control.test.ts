import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxCompositionServer,
  parseAgentMuxCompositionRequest,
  requestAgentMuxComposition
} from '../src/composition-control.js'
import {
  AGENTMUX_COMPOSITION_SCHEMA_VERSION,
  resolveAgentMuxRegion,
  type AgentMuxCompositionResult,
  type AgentMuxRegion
} from '../src/composition.js'
import { AgentMuxError } from '../src/errors.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

const regions: AgentMuxRegion[] = [
  {
    viewId: 'view-main',
    regionId: 'agent-left',
    kind: 'agent',
    agentSessionId: 'semantic-1',
    workspaceId: 'workspace',
    tabGroupId: 'group-main'
  },
  {
    viewId: 'view-main',
    regionId: 'terminal-right',
    kind: 'terminal',
    runId: 'run-terminal',
    workspaceId: 'workspace',
    tabGroupId: 'group-main'
  }
]
const agentRegion = regions[0] as Extract<AgentMuxRegion, { kind: 'agent' }>

describe('Composition domain', () => {
  it('resolves only an exact Region or the unique Region for an Agent Session', () => {
    expect(resolveAgentMuxRegion(regions, { kind: 'region', regionId: 'terminal-right' })).toEqual(regions[1])
    expect(resolveAgentMuxRegion(regions, { kind: 'agent-session', agentSessionId: 'semantic-1' })).toEqual(regions[0])
    expect(() => resolveAgentMuxRegion(regions, { kind: 'region', regionId: 'closed' })).toThrow('not currently open')
    expect(() => resolveAgentMuxRegion([...regions, {
      ...regions[0]!,
      viewId: 'view-two',
      regionId: 'agent-right'
    }], { kind: 'agent-session', agentSessionId: 'semantic-1' })).toThrow('ambiguous')
  })

  it('accepts only the closed Placement and Relative Region vocabulary', () => {
    const base = {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId: 'request-1',
      operation: 'region.open',
      caller: { agentSessionId: 'caller' },
      agentSessionId: 'target',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }
    expect(parseAgentMuxCompositionRequest(base)).toEqual(base)
    expect(() => parseAgentMuxCompositionRequest({ ...base, placement: 'right' })).toThrow('placement')
    expect(() => parseAgentMuxCompositionRequest({
      ...base,
      relativeTo: { kind: 'recent' }
    })).toThrow('Relative Region')
  })
})

describe('external Composition control', () => {
  it('carries context, open, focus, and launch through one versioned endpoint', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-composition-control-')
    roots.push(root)
    const path = join(root, 'composition.sock')
    const seen: unknown[] = []
    const server = new AgentMuxCompositionServer({
      async execute(request): Promise<AgentMuxCompositionResult> {
        seen.push(request)
        if (request.operation === 'context') {
          return {
            operation: request.operation,
            context: {
              agentSessionId: request.caller.agentSessionId,
              workspaceId: 'workspace',
              viewId: 'view-main',
              regionId: 'agent-left',
              tabGroupId: 'group-main',
              regions: [
                {
                  regionId: 'agent-left',
                  kind: 'agent',
                  providerId: 'codex',
                  executorId: 'codex',
                  agentSessionId: request.caller.agentSessionId,
                  bounds: { x: 0, y: 0, width: 0.5, height: 1 }
                },
                {
                  regionId: 'terminal-right',
                  kind: 'terminal',
                  runId: 'run-terminal',
                  bounds: { x: 0.5, y: 0, width: 0.5, height: 1 }
                }
              ],
              executors: [{ executorId: 'codex', label: 'Codex', providerId: 'codex', available: true }]
            }
          }
        }
        if (request.operation === 'region.open') {
          return { operation: request.operation, region: { ...agentRegion, agentSessionId: request.agentSessionId } }
        }
        if (request.operation === 'region.focus') {
          return {
            operation: request.operation,
            region: resolveAgentMuxRegion(regions, { kind: 'region', regionId: request.regionId })
          }
        }
        return {
          operation: request.operation,
          agentSessionId: 'launched',
          region: { ...agentRegion, agentSessionId: 'launched' }
        }
      }
    }, path)
    await server.start()
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    const context = await requestAgentMuxComposition({
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId: 'context-1',
      operation: 'context',
      caller: { agentSessionId: 'semantic-1' }
    }, path)
    expect(context).toMatchObject({
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId: 'context-1',
      ok: true,
      operation: 'context',
      result: {
        context: {
          viewId: 'view-main',
          regionId: 'agent-left',
          tabGroupId: 'group-main',
          regions: [
            { regionId: 'agent-left', bounds: { x: 0, y: 0, width: 0.5, height: 1 } },
            { regionId: 'terminal-right', bounds: { x: 0.5, y: 0, width: 0.5, height: 1 } }
          ]
        }
      }
    })
    await expect(requestAgentMuxComposition({
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId: 'open-1',
      operation: 'region.open',
      caller: { agentSessionId: 'semantic-1' },
      agentSessionId: 'target-session',
      placement: 'tab',
      relativeTo: { kind: 'self' }
    }, path)).resolves.toMatchObject({
      operation: 'region.open',
      result: { region: { agentSessionId: 'target-session' } }
    })
    await expect(requestAgentMuxComposition({
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId: 'focus-1',
      operation: 'region.focus',
      regionId: 'closed'
    }, path)).rejects.toMatchObject({ code: 'REGION_NOT_OPEN' })
    await expect(requestAgentMuxComposition({
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId: 'launch-1',
      operation: 'launch',
      caller: { agentSessionId: 'semantic-1' },
      executorId: 'codex',
      prompt: 'Inspect the tests',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    }, path)).resolves.toMatchObject({ operation: 'launch', result: { agentSessionId: 'launched' } })
    expect(seen.map((request) => (request as { operation: string }).operation)).toEqual([
      'context', 'region.open', 'region.focus', 'launch'
    ])

    await server.stop()
    await expect(requestAgentMuxComposition({
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId: 'unavailable-1',
      operation: 'region.focus',
      regionId: 'agent-left'
    }, path)).rejects.toMatchObject({ code: 'COMPOSITION_UNAVAILABLE' })
  })

  it('decodes a UTF-8 request only after all socket chunks are joined', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-composition-utf8-')
    roots.push(root)
    const path = join(root, 'composition.sock')
    let seenPrompt = ''
    const server = new AgentMuxCompositionServer({
      async execute(request): Promise<AgentMuxCompositionResult> {
        if (request.operation !== 'launch') throw new Error('Unexpected operation')
        seenPrompt = request.prompt ?? ''
        return {
          operation: request.operation,
          agentSessionId: 'launched',
          region: { ...agentRegion, agentSessionId: 'launched' }
        }
      }
    }, path)
    await server.start()
    const request = {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId: 'utf8-launch',
      operation: 'launch',
      caller: { agentSessionId: 'semantic-1' },
      executorId: 'codex',
      prompt: '检查你的位置',
      placement: 'split-right',
      relativeTo: { kind: 'self' }
    } as const
    const payload = Buffer.from(`${JSON.stringify(request)}\n`)
    const splitAt = payload.indexOf(Buffer.from('你')) + 1
    const socket = createConnection(path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(payload.subarray(0, splitAt))
    await new Promise((resolve) => setTimeout(resolve, 10))
    socket.end(payload.subarray(splitAt))
    const response: Buffer[] = []
    for await (const chunk of socket) response.push(chunk as Buffer)

    expect(JSON.parse(Buffer.concat(response).toString('utf8'))).toMatchObject({ ok: true })
    expect(seenPrompt).toBe('检查你的位置')
    await server.stop()
  })

  it('rejects when an endpoint closes without a response', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-composition-close-')
    roots.push(root)
    const path = join(root, 'composition.sock')
    const server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    try {
      await expect(requestAgentMuxComposition({
        schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
        requestId: 'closed-response',
        operation: 'context',
        caller: { agentSessionId: 'semantic-1' }
      }, path)).rejects.toBeDefined()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
