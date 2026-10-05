import type { AppConfig, NativeAgentSessionsInput, NativeAgentSessionsResult, WorkspaceRecord } from '../../../shared/contracts'

export function launcherNativeSourceKey(source: import('@agentmux/core').AgentNativeResumeSource): string {
  const handle = source.nativeHandle
  return JSON.stringify([source.workspacePath, source.revision, handle.kind, handle.providerId, handle.sessionId, handle.transcriptPath])
}

/** Refreshed Settings objects do not invalidate an unchanged native source query. */
export function launcherNativeDiscovery(config: AppConfig | null, workspace: WorkspaceRecord | undefined, scope: 'project' | 'global') {
  const hosts = config?.hosts.filter(host => scope === 'global' || !workspace || host.id === workspace.hostId) ?? []
  const executors = Object.entries(config?.executors ?? {})
  const requests: NativeAgentSessionsInput[] = hosts.flatMap(host => executors.map(([executorId]) => ({ hostId: host.id, executorId })))
  const key = JSON.stringify([hosts.map(host => host.kind === 'local' ? [host.id, host.kind]
    : [host.id, host.kind, host.hostname, host.user, host.port, host.identityFile, host.remoteCommand, host.remoteSocketPath, host.runtimeId]),
    executors.map(([id, executor]) => [id, executor.providerId, Object.entries(executor.env).sort(([a], [b]) => a.localeCompare(b))])])
  return { requests, key }
}

export function launcherDiscoveryKey(input: NativeAgentSessionsInput): string { return JSON.stringify([input.hostId, input.executorId]) }

/** One completed source is published immediately; partial reads retain prior known candidates. */
export function mergeLauncherNativeCatalog(previous: NativeAgentSessionsResult[], catalog: NativeAgentSessionsResult): NativeAgentSessionsResult[] {
  const key = launcherDiscoveryKey(catalog)
  const old = previous.find(value => launcherDiscoveryKey(value) === key && value.providerId === catalog.providerId)
  let next = catalog
  if (catalog.issues.length && old) {
    const sessions = new Map(old.sessions.map(entry => [entry.source.nativeHandle.sessionId, entry]))
    for (const entry of catalog.sessions) sessions.set(entry.source.nativeHandle.sessionId, entry)
    next = { ...catalog, sessions: [...sessions.values()] }
  }
  return [...previous.filter(value => launcherDiscoveryKey(value) !== key), next]
}

export function launcherCatalogWarnings(catalog: NativeAgentSessionsResult): string[] {
  const groups = new Map<string, { count: number; message: string }>()
  for (const issue of catalog.issues) {
    const group = groups.get(issue.code) ?? { count: 0, message: issue.message }
    group.count += 1
    groups.set(issue.code, group)
  }
  return [...groups.values()].map(group => group.count === 1 ? group.message
    : `${group.count} discovery notices: ${group.message}`)
}
