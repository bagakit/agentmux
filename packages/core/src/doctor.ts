import type { AgentMuxClient } from './client.js'
import type { AgentId, AgentCapabilities, AgentCatalogEntry } from './types.js'

export type AgentMuxDoctorHostKind = 'local' | 'ssh'
export type AgentMuxDoctorProbeState = 'found' | 'missing' | 'blocked'

export type AgentMuxDoctorAgent = {
  id: AgentId
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
    kind: AgentMuxDoctorHostKind
    reachable: boolean
    hostId: string | null
    buildIdentity: string | null
    protocolVersion: number | null
    daemonInstanceId: string | null
    error: string | null
    action: string | null
  }
  runtime: Awaited<ReturnType<AgentMuxClient['daemonDiagnostics']>> | null
  runtimeAction: string | null
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
  hostKind: AgentMuxDoctorHostKind
  commandOverrides?: Readonly<Record<string, string>>
}

function blockedAgent(catalog: AgentCatalogEntry): AgentMuxDoctorAgent {
  return {
    id: catalog.id,
    label: catalog.label,
    executable: catalog.executable,
    probe: 'blocked',
    action: 'Restore the daemon connection, then rerun doctor.',
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
    const identity = options.client.daemonIdentity()
    const [runtime, agents] = await Promise.all([
      options.client.daemonDiagnostics(),
      Promise.all(catalog.map(async (entry) => await probeAgent(
        options.client,
        entry,
        options.commandOverrides?.[entry.id]
      )))
    ])
    return {
      ok: runtime.supported && runtime.pty.ready && agents.every((agent) => agent.probe !== 'blocked'),
      host: {
        kind: options.hostKind,
        reachable: true,
        hostId: identity.hostId,
        buildIdentity: identity.buildIdentity,
        protocolVersion: identity.protocolVersion,
        daemonInstanceId: identity.daemonInstanceId,
        error: null,
        action: null
      },
      runtime,
      runtimeAction: !runtime.supported
        ? 'Use Node 22 or newer on macOS or Linux with x64 or arm64.'
        : !runtime.pty.ready
          ? 'Reinstall @agentmux/core for this platform and verify the node-pty prebuild and Helper permissions.'
          : null,
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
        kind: options.hostKind,
        reachable: false,
        hostId: null,
        buildIdentity: null,
        protocolVersion: null,
        daemonInstanceId: null,
        error: detail,
        action: options.hostKind === 'local'
          ? 'Run agentmuxd activate, then rerun doctor.'
          : 'Verify system SSH authentication and the explicit remote agentmuxd Build and Socket paths.'
      },
      runtime: null,
      runtimeAction: null,
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
