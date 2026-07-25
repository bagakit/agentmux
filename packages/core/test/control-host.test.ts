import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxControlServer,
  parseAgentMuxControlReceipt,
  parseAgentMuxControlRequest,
  requestAgentMuxControl
} from '../src/control-host.js'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  resolveAgentMuxRegion,
  type AgentMuxAgentRegion,
  type AgentMuxControlResult,
  type AgentMuxRegion
} from '../src/control.js'

const roots: string[] = []
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))))

const agentRegion: AgentMuxAgentRegion = {
  tabId: 'tab-main',
  regionId: 'agent-left',
  workspaceId: 'workspace',
  kind: 'agent',
  agentSessionId: 'semantic-1',
  providerId: 'codex',
  executorId: 'codex'
}
const regions: AgentMuxRegion[] = [agentRegion, {
  tabId: 'tab-main',
  regionId: 'browser-right',
  workspaceId: 'workspace',
  kind: 'browser',
  browserId: 'browser-1'
}]

describe('Control protocol', () => {
  it('uses only closed Tab, Region, AgentSession, Run, and owner surface identities', () => {
    expect(resolveAgentMuxRegion(regions, { kind: 'region', regionId: 'browser-right' })).toEqual(regions[1])
    expect(resolveAgentMuxRegion(regions, { kind: 'agent-session', agentSessionId: 'semantic-1' })).toEqual(agentRegion)
    expect(() => parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'inspect',
      ok: true,
      operation: 'inspect.region',
      result: {
        region: {
          tabId: 'tab-main',
          regionId: 'unknown',
          workspaceId: 'workspace',
          kind: 'other',
          bounds: { x: 0, y: 0, width: 1, height: 1 }
        }
      }
    })).toThrow('Region result')
  })

  it('requires one typed self caller and rejects legacy operations', () => {
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'self-tab',
      operation: 'inspect.tab',
      target: { kind: 'self' },
      caller: { agentSessionId: 'semantic-1' }
    })).toMatchObject({ operation: 'inspect.tab', target: { kind: 'self' } })
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'missing-caller',
      operation: 'inspect.tab',
      target: { kind: 'self' }
    })).toThrow('managed caller')
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'legacy',
      operation: 'context',
      caller: { agentSessionId: 'semantic-1' }
    })).toThrow('operation')
  })

  it('keeps open content and destinations as closed discriminated unions', () => {
    expect(parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'open-right',
      operation: 'open.agent',
      caller: { agentSessionId: 'semantic-1' },
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'Review' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'self' } }
    })).toMatchObject({ operation: 'open.agent', destination: { kind: 'split', direction: 'right' } })
    expect(() => parseAgentMuxControlRequest({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'invalid-destination',
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex' },
      destination: { kind: 'recent' }
    })).toThrow('destination')
  })

  it('preserves typed ambiguous message candidates through receipts', () => {
    expect(parseAgentMuxControlReceipt({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'send-tab',
      ok: false,
      operation: 'send',
      error: {
        code: 'MESSAGE_TARGET_NOT_UNIQUE',
        message: 'Tab contains multiple Agent Sessions.',
        candidates: [
          { agentSessionId: 'writer', regionIds: ['region-writer'] },
          { agentSessionId: 'reviewer', regionIds: ['region-reviewer', 'region-reviewer-two'] }
        ]
      }
    })).toMatchObject({
      ok: false,
      error: { candidates: [{ agentSessionId: 'writer' }, { agentSessionId: 'reviewer' }] }
    })
  })
})

describe('external Control control', () => {
  it('carries the new protocol through one owner endpoint', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-composition-control-')
    roots.push(root)
    const path = join(root, 'control.sock')
    const seen: string[] = []
    const server = new AgentMuxControlServer({
      async execute(request): Promise<AgentMuxControlResult> {
        seen.push(request.operation)
        if (request.operation === 'inspect.tab') {
          return {
            operation: request.operation,
            tab: {
              tabId: 'tab-main',
              workspaceId: 'workspace',
              regions: [{ ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
            }
          }
        }
        if (request.operation === 'list.agents') return { operation: request.operation, agents: [{ executorId: 'codex', providerId: 'codex', label: 'Codex', available: true }] }
        if (request.operation === 'open.agent') return { operation: request.operation, region: agentRegion }
        if (request.operation === 'send') return { operation: request.operation, agentSessionId: 'semantic-1' }
        if (request.operation === 'focus') return { operation: request.operation, tabId: 'tab-main', regionId: 'agent-left' }
        if (request.operation === 'inspect.region') return { operation: request.operation, region: { ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 } } }
        if (request.operation === 'resume') return { operation: request.operation, agentSessionId: 'semantic-1', runId: 'run-resumed' }
        return { operation: request.operation, agentSessionId: 'semantic-1' }
      }
    }, path)
    await server.start()
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'inspect-tab',
      operation: 'inspect.tab',
      target: { kind: 'tab', tabId: 'tab-main' }
    }, path)).resolves.toMatchObject({ operation: 'inspect.tab', result: { tab: { tabId: 'tab-main' } } })
    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'open-agent',
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'agent-left' } }
    }, path)).resolves.toMatchObject({ operation: 'open.agent', result: { region: { tabId: 'tab-main' } } })
    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'send',
      operation: 'send',
      target: { kind: 'tab', tabId: 'tab-main' },
      text: 'Continue'
    }, path)).resolves.toMatchObject({ operation: 'send', result: { agentSessionId: 'semantic-1' } })
    expect(seen).toEqual(['inspect.tab', 'open.agent', 'send'])
    await server.stop()
  })

  it('decodes UTF-8 only after all socket chunks are joined', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-composition-utf8-')
    roots.push(root)
    const path = join(root, 'control.sock')
    let seen = ''
    const server = new AgentMuxControlServer({
      async execute(request) {
        if (request.operation !== 'send') throw new Error('Unexpected operation')
        seen = request.text
        return { operation: request.operation, agentSessionId: 'semantic-1' }
      }
    }, path)
    await server.start()
    await requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'utf8-send',
      operation: 'send',
      target: { kind: 'agent-session', agentSessionId: 'semantic-1' },
      text: '继续检查'
    }, path)
    expect(seen).toBe('继续检查')
    await server.stop()
  })
})
