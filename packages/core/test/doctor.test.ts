import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxDaemonServer } from '../src/daemon-server.js'
import { diagnoseAgentMux } from '../src/doctor.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('AgentMux doctor', () => {
  it('reports daemon, native PTY, Agent, Hook, ACP, and permission facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-doctor-'))
    roots.push(root)
    const socketPath = join(root, 'agentmuxd.sock')
    const server = new AgentMuxDaemonServer({ socketPath })
    const client = new AgentMuxClient({ socketPath })
    await server.start()
    try {
      const overrides = Object.fromEntries(client.catalog().map((entry) => [entry.id, process.execPath]))
      const report = await diagnoseAgentMux({ client, hostKind: 'local', commandOverrides: overrides })

      expect(report.ok).toBe(true)
      expect(report.host).toMatchObject({
        kind: 'local',
        reachable: true,
        hostId: 'local',
        buildIdentity: '0.1.0',
        protocolVersion: 5,
        error: null
      })
      expect(report.runtime).toMatchObject({
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        supported: true,
        pty: {
          packageName: 'node-pty',
          version: '1.2.0-beta.15',
          artifactPresent: true,
          ready: true
        }
      })
      expect(report.runtimeAction).toBeNull()
      expect(report.agents).toHaveLength(5)
      expect(report.agents.every((agent) => agent.probe === 'found')).toBe(true)
      expect(report.agents.find((agent) => agent.id === 'codex')).toMatchObject({
        hook: { kind: 'native', installation: 'explicit-managed' },
        permission: 'observe',
        acp: { kind: 'none' }
      })
      expect(report.integration).toEqual({
        hookIngress: 'authenticated-loopback',
        hookInstallation: 'explicit-managed',
        permissionDefault: 'reject',
        semanticEvidence: 'native-hook-or-acp-only'
      })
    } finally {
      await client.dispose()
      await server.stop()
    }
  })

  it('reports a blocked probe with an action when the requested Host is unreachable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-doctor-offline-'))
    roots.push(root)
    const client = new AgentMuxClient({ socketPath: join(root, 'missing.sock') })
    const report = await diagnoseAgentMux({ client, hostKind: 'ssh' })

    expect(report.ok).toBe(false)
    expect(report.host).toMatchObject({
      kind: 'ssh',
      reachable: false,
      hostId: null,
      action: expect.stringContaining('SSH')
    })
    expect(report.runtime).toBeNull()
    expect(report.runtimeAction).toBeNull()
    expect(report.agents.every((agent) => agent.probe === 'blocked')).toBe(true)
    expect(JSON.stringify(report)).not.toContain('UNKNOWN')
    await client.dispose()
  })

  it('keeps a reachable Host distinct from one invalid Agent probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-doctor-probe-'))
    roots.push(root)
    const socketPath = join(root, 'agentmuxd.sock')
    const server = new AgentMuxDaemonServer({ socketPath })
    const client = new AgentMuxClient({ socketPath })
    await server.start()
    try {
      const report = await diagnoseAgentMux({
        client,
        hostKind: 'local',
        commandOverrides: { codex: 'invalid\ncommand' }
      })
      expect(report.ok).toBe(false)
      expect(report.host).toMatchObject({ reachable: true, error: null })
      expect(report.agents.find((agent) => agent.id === 'codex')).toMatchObject({
        probe: 'blocked',
        action: expect.stringContaining('executable probe')
      })
    } finally {
      await client.dispose()
      await server.stop()
    }
  })
})
