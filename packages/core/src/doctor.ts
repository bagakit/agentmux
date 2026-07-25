import type { AgentMuxClient } from './client.js'
import type { AgentProviderId, AgentCapabilities, AgentCatalogEntry } from './types.js'

export type AgentMuxDoctorProbeState = 'found' | 'missing' | 'blocked'

export type AgentMuxDoctorAgent = {
  id: AgentProviderId
  label: string
  executable: string
  probe: AgentMuxDoctorProbeState
  action: string | null
  capabilities: AgentCapabilities
  hook: AgentCatalogEntry['hookStrategy']
  permission: AgentCapabilities['permission']
  acp: AgentCatalogEntry['acpStrategy']
}

export type AgentMuxDoctorReport = {
  ok: boolean
  host: {
    kind: 'local'
    reachable: boolean
    hostId: string | null
    buildIdentity: string | null
    protocolVersion: number | null
    runtimeInstanceId: string | null
    error: string | null
    action: string | null
  }
  runtime: Awaited<ReturnType<AgentMuxClient['runtimeDiagnostics']>> | null
  runtimeAction: string | null
  hosts: {
    local: {
      status: 'available' | 'unavailable'
      action: string | null
    }
    remote: {
      status: 'unsupported'
      action: string
    }
  }
  agents: AgentMuxDoctorAgent[]
  integration: {
    hookIngress: 'authenticated-loopback'
    hookInstallation: 'explicit-managed'
    permissionDefault: 'reject'
    semanticEvidence: 'native-hook-or-acp-only'
  }
}

export type DiagnoseAgentMuxOptions = {
  client: AgentMuxClient
  commandOverrides?: Readonly<Record<string, string>>
}

function blockedAgent(catalog: AgentCatalogEntry): AgentMuxDoctorAgent {
  return {
    id: catalog.id,
    label: catalog.label,
    executable: catalog.executable,
    probe: 'blocked',
    action: 'Restore the Runtime connection, then rerun doctor.',
    capabilities: { ...catalog.capabilities },
    hook: { ...catalog.hookStrategy },
    permission: catalog.capabilities.permission,
    acp: { ...catalog.acpStrategy }
  }
}

async function probeAgent(
  client: AgentMuxClient,
  catalog: AgentCatalogEntry,
  commandOverride: string | undefined
): Promise<AgentMuxDoctorAgent> {
  try {
    const capability = await client.probeAgent(catalog.id, commandOverride)
    return {
      id: catalog.id,
      label: catalog.label,
      executable: capability.executable,
      probe: capability.installed ? 'found' : 'missing',
      action: capability.installed
        ? null
        : `Install ${catalog.label} on this Host or configure an explicit executable.`,
      capabilities: { ...capability.capabilities },
      hook: { ...catalog.hookStrategy },
      permission: catalog.capabilities.permission,
      acp: { ...catalog.acpStrategy }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ...blockedAgent(catalog),
      action: `Fix the ${catalog.label} executable probe, then rerun doctor: ${detail}`
    }
  }
}

export async function diagnoseAgentMux(options: DiagnoseAgentMuxOptions): Promise<AgentMuxDoctorReport> {
  const catalog = options.client.catalog()
  try {
    await options.client.connect()
    const identity = options.client.runtimeIdentity()
    const [runtime, agents] = await Promise.all([
      options.client.runtimeDiagnostics(),
      Promise.all(catalog.map(async (entry) => await probeAgent(
        options.client,
        entry,
        options.commandOverrides?.[entry.id]
      )))
    ])
    return {
      ok: runtime.supported && runtime.ctxmux.ready && agents.every((agent) => agent.probe !== 'blocked'),
      host: {
        kind: 'local',
        reachable: true,
        hostId: identity.hostId,
        buildIdentity: identity.buildIdentity,
        protocolVersion: identity.protocolVersion,
        runtimeInstanceId: identity.instanceId,
        error: null,
        action: null
      },
      runtime,
      runtimeAction: !runtime.supported
        ? 'Use Node 24 or newer on macOS arm64 with the bundled darwin-arm64 ctxmux artifacts.'
        : !runtime.ctxmux.ready
          ? 'Reinstall @agentmux/core and verify the pinned ctxmux artifact manifest.'
          : null,
      hosts: {
        local: {
          status: runtime.supported && runtime.ctxmux.ready ? 'available' : 'unavailable',
          action: runtime.supported && runtime.ctxmux.ready
            ? null
            : 'Restore the pinned local ctxmux runtime, then rerun doctor.'
        },
        remote: {
          status: 'unsupported',
          action: 'Remote is unsupported until the ctxmux Remote contract is delivered in T-021.'
        }
      },
      agents,
      integration: {
        hookIngress: 'authenticated-loopback',
        hookInstallation: 'explicit-managed',
        permissionDefault: 'reject',
        semanticEvidence: 'native-hook-or-acp-only'
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      host: {
        kind: 'local',
        reachable: false,
        hostId: null,
        buildIdentity: null,
        protocolVersion: null,
        runtimeInstanceId: null,
        error: detail,
        action: 'Verify the bundled ctxmux artifacts, then rerun doctor.'
      },
      runtime: null,
      runtimeAction: null,
      hosts: {
        local: {
          status: 'unavailable',
          action: 'Verify the bundled ctxmux artifacts, then rerun doctor.'
        },
        remote: {
          status: 'unsupported',
          action: 'Remote is unsupported until the ctxmux Remote contract is delivered in T-021.'
        }
      },
      agents: catalog.map(blockedAgent),
      integration: {
        hookIngress: 'authenticated-loopback',
        hookInstallation: 'explicit-managed',
        permissionDefault: 'reject',
        semanticEvidence: 'native-hook-or-acp-only'
      }
    }
  }
}
