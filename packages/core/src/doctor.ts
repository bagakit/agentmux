import type { AgentMuxClient } from './client.js'
import {
  endpointDirectoryUsage,
  type EndpointDirectoryUsage,
  type EndpointReclaimOutcome
} from './runtime-endpoint-reclaim.js'
import type { AgentProviderId, AgentCapabilities, AgentCatalogEntry } from './types.js'

/**
 * 探测结果的四态。
 *
 * `'unverifiable'` 与 `'missing'` 必须分开：前者是「我们没查成」（环境退化，比如相对命令名 + 空
 * PATH——一个候选都算不出），后者是「查成了，确实没装」。折成一个 boolean 会让诊断当着用户的面
 * 说「没装，去装一个」，而真正的病因是 shell 环境没加载全，于是用户去追一个不存在的安装问题。
 * 这正是 37e32665 在启动闸上修掉的那次误报——诊断面是它漏掉的第三个消费者。
 */
export type AgentMuxDoctorProbeState = 'found' | 'missing' | 'unverifiable' | 'blocked'

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
    // 三态探测问的是同一个 Executor 的同一件事，但它区分「查不成」与「没装」，而 `capability.installed`
    // 把两者折成 false。诊断恰恰是最不能折的地方：用户来这里就是为了知道病因。两次探测共用
    // probeCapabilities 里那一份命令解析（commandOverride 优先，否则 catalog executable），所以它们
    // 看的一定是同一条命令，不会各自解析出不同的东西。
    const availability = await client.probeExecutorAvailability(catalog.id, commandOverride)
    const probe = availability === 'available'
      ? 'found'
      : availability === 'check-failed' ? 'unverifiable' : 'missing'
    return {
      id: catalog.id,
      label: catalog.label,
      executable: capability.executable,
      probe,
      action: probe === 'found'
        ? null
        : probe === 'unverifiable'
          // 指向环境，不是指向安装。这句话与启动闸拒绝时说的是同一件事，措辞也应当同源地读起来一致。
          ? `Could not verify ${catalog.label} on this Host: no candidate path to probe. Check PATH and your shell environment, then rerun doctor.`
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
