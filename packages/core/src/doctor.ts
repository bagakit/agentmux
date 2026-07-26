import type { AgentMuxClient } from './client.js'
import {
  endpointDirectoryUsage,
  type EndpointDirectoryUsage,
  type EndpointReclaimOutcome
} from './runtime-endpoint-reclaim.js'
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
  /**
   * 每个 endpoint 目录当前占多少盘，当前那个标 `current`。
   *
   * artifact 每升一次版就派生一个新 endpoint 目录，旧的连同 100MB 级的 state.sqlite3 留在盘上。
   * 回收在启动时自动做，但「现在到底占了多少」得有地方看得见，否则只有磁盘告警时才会发现。
   */
  endpointStorage: EndpointDirectoryUsage[]
  /**
   * 启动时那趟孤儿目录回收的结果；未连上运行时则为 null。
   *
   * 回收失败不阻断启动，所以失败本身是静默的——这里是它唯一能被看见的地方。`failed` 非空意味着有
   * 目录每次启动都删不掉（典型是权限被收紧），会一直堆着。
   */
  endpointReclaim: EndpointReclaimOutcome | null
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
      // 与失败路径同样兜底。这个 helper 目前内部是全函数（每个 readdir/stat 都有 .catch），但若哪天
      // 那个性质回退，一次体积扫描失败会被外层 try/catch 吞成「运行时不可达」——把一个健康的运行时
      // 误报成 ok:false、所有 agent 全部 blocked。容量统计不该有权否决整份诊断。
      endpointStorage: await endpointDirectoryUsage().catch(() => []),
      endpointReclaim: options.client.endpointReclaim(),
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
          action: 'Remote is unsupported until the ctxmux Remote contract is delivered.'
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
      // 这条是失败路径：诊断本身已经出错了，容量统计再抛就会把真正的病因盖掉。兜底成空表。
      endpointStorage: await endpointDirectoryUsage().catch(() => []),
      // 连都没连上，本次就没跑过回收——不是「回收成功且无失败」，所以是 null 而不是空 outcome。
      endpointReclaim: null,
      runtimeAction: null,
      hosts: {
        local: {
          status: 'unavailable',
          action: 'Verify the bundled ctxmux artifacts, then rerun doctor.'
        },
        remote: {
          status: 'unsupported',
          action: 'Remote is unsupported until the ctxmux Remote contract is delivered.'
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
