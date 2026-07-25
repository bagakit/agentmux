import { describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxClient } from '../src/client.js'
import { diagnoseAgentMux } from '../src/doctor.js'
import type { AgentProviderId, AgentMuxRuntimeDiagnostics } from '../src/types.js'

const runtime: AgentMuxRuntimeDiagnostics = {
  nodeVersion: '24.0.0',
  platform: 'darwin',
  arch: 'arm64',
  supported: true,
  ctxmux: {
    version: '0.1.0',
    protocolVersion: 12,
    sourceCommit: 'a0897087fdd0eb131c39c43d4d6791901335d69e',
    artifactPlatform: 'darwin-arm64',
    ready: true,
    capabilities: {
      transport: 'local-unix',
      orderedOutputBytes: true,
      boundedReplay: true,
      recoverableInput: true,
      resize: true,
      interrupt: true,
      completeStop: true
    }
  }
}

function client(overrides: Partial<AgentMuxClient> = {}): AgentMuxClient {
  const catalog = new AgentProviderRegistry().catalog()
  return {
    catalog: () => catalog,
    connect: vi.fn(async () => {}),
    runtimeIdentity: () => ({
      hostId: 'local',
      buildIdentity: 'ctxmux-fixture',
      protocolVersion: 12,
      processId: null,
      instanceId: 'daemon-fixture'
    }),
    runtimeDiagnostics: vi.fn(async () => runtime),
    probeAgent: vi.fn(async (providerId: AgentProviderId) => ({
      providerId,
      executable: catalog.find((entry) => entry.id === providerId)!.executable,
      installed: providerId === 'codex',
      capabilities: catalog.find((entry) => entry.id === providerId)!.capabilities
    })),
    ...overrides
  } as unknown as AgentMuxClient
}

describe('AgentMux doctor', () => {
  it('reports the exact ctxmux capability, integration, permission, and Host boundaries', async () => {
    const report = await diagnoseAgentMux({ client: client() })

    expect(report.ok).toBe(true)
    expect(report.runtime?.ctxmux).toMatchObject({
      protocolVersion: 12,
      artifactPlatform: 'darwin-arm64',
      capabilities: {
        transport: 'local-unix',
        boundedReplay: true,
        recoverableInput: true,
        interrupt: true,
        completeStop: true
      }
    })
    expect(report.hosts).toEqual({
      local: { status: 'available', action: null },
      remote: {
        status: 'unsupported',
        action: 'Remote is unsupported until the ctxmux Remote contract is delivered.'
      }
    })
    expect(report.integration).toEqual({
      hookIngress: 'authenticated-loopback',
      hookInstallation: 'explicit-managed',
      permissionDefault: 'reject',
      semanticEvidence: 'native-hook-or-acp-only'
    })
    expect(report.agents.find((agent) => agent.id === 'codex')).toMatchObject({
      probe: 'found',
      hook: { kind: 'native' },
      permission: 'observe',
      acp: { kind: 'none' }
    })
  })

  it('does not advertise unsupported platforms or Remote as usable', async () => {
    const unsupported: AgentMuxRuntimeDiagnostics = {
      ...runtime,
      platform: 'linux',
      arch: 'x64',
      supported: false
    }
    const report = await diagnoseAgentMux({
      client: client({ runtimeDiagnostics: vi.fn(async () => unsupported) })
    })

    expect(report.ok).toBe(false)
    expect(report.runtimeAction).toContain('macOS arm64')
    expect(report.runtimeAction).not.toContain('Linux')
    expect(report.hosts.local.status).toBe('unavailable')
    expect(report.hosts.remote.status).toBe('unsupported')
  })

  it('turns an unreachable runtime into actionable blocked diagnostics', async () => {
    const report = await diagnoseAgentMux({
      client: client({ connect: vi.fn(async () => { throw new Error('owner receipt mismatch') }) })
    })

    expect(report).toMatchObject({
      ok: false,
      host: {
        reachable: false,
        error: 'owner receipt mismatch',
        action: 'Verify the bundled ctxmux artifacts, then rerun doctor.'
      },
      runtime: null,
      hosts: {
        local: { status: 'unavailable' },
        remote: { status: 'unsupported' }
      }
    })
    expect(report.agents.every((agent) => agent.probe === 'blocked')).toBe(true)
  })
})
