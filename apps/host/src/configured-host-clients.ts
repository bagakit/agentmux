import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { connectSshAgentMux, type AgentMuxSshHostedClient } from '@agentmux/core'
import { parseHostConfigurations, type SshHostConfig } from './host-configuration.js'

type Lease = { config: SshHostConfig; client: AgentMuxSshHostedClient }
/** Read the original application configuration; own only these SSH consumer leases. */
export function configuredHostClients(path: string | undefined) {
  const leases = new Map<string, Lease>()
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) { try { listener() } catch (error) {
    process.emitWarning('Observing original Host leases is unconfirmed: ' + (error instanceof Error ? error.message : String(error)), { code: 'HOST_LEASE_OBSERVATION_UNCONFIRMED' })
  } } }
  const configurationRead = new AbortController()
  const routes = new Map<string, { config: SshHostConfig; controller: AbortController }>()
  const work = new Set<Promise<void>>()
  let watcher: FSWatcher | undefined, pending: Promise<void> | undefined, retry: NodeJS.Timeout | undefined
  let dirty = false, closed = false, started = false, lastIssue: string | undefined
  const issue = (step: string) => {
    if (lastIssue === step || closed) return
    lastIssue = step
    process.emitWarning(`${step} Original Host connections and healthy Agents are retained; restore the original configuration or authenticated route.`, { code: 'HOST_CONFIGURATION_UNCONFIRMED' })
  }
  const track = (task: Promise<void>) => { work.add(task); void task.then(() => work.delete(task), () => work.delete(task)) }
  const current = () => !closed && !dirty
  const apply = async () => {
    if (!path || !isAbsolute(path)) { if (path !== undefined) issue('The original Host configuration path must be absolute.'); return }
    let value: unknown
    try { value = JSON.parse(await readFile(path, { encoding: 'utf8', signal: configurationRead.signal })) }
    catch { issue('Reading the original Host configuration failed.'); return }
    const parsed = parseHostConfigurations(value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).hosts : undefined)
    if (!parsed.success) { issue('The original Hosts configuration is invalid: ' + parsed.issues.map(problem => [...problem.path, problem.message].join('.')).join('; ')); return }
    if (!current()) return
    lastIssue = undefined
    const configured = parsed.data.filter((host): host is SshHostConfig => host.kind === 'ssh')
    const desired = new Map(configured.map(config => [config.id, config]))
    for (const [id, route] of routes) if (!isDeepStrictEqual(route.config, desired.get(id))) {
      routes.delete(id); route.controller.abort()
    }
    for (const [id, lease] of leases) if (!desired.has(id)) {
      leases.delete(id); changed()
      track(lease.client.dispose().catch(() => issue(`Host ${id} consumer cleanup is unconfirmed.`)))
    }
    for (const config of configured) {
      const previous = leases.get(config.id)
      if (!config.runtimeId) { issue(`Host ${config.id} has no original confirmed Runtime binding. Confirm it through its existing settings owner.`); continue }
      const runtimeId = config.runtimeId
      if (previous?.config.runtimeId !== undefined && previous.config.runtimeId !== config.runtimeId) { issue(`Host ${config.id} cannot replace its original Runtime identity.`); continue }
      if (previous && isDeepStrictEqual(previous.config, config)) continue
      if (routes.has(config.id)) continue
      const { label: _label, ...route } = config
      const candidate = { config, controller: new AbortController() }
      routes.set(config.id, candidate)
      const accepted = () => !closed && routes.get(config.id) === candidate
      track((async () => { try {
        if (previous) {
          const { label: _previousLabel, ...original } = previous.config
          if (isDeepStrictEqual(original, route)) { previous.config = config; return }
          const { remoteCommand: _command, ...target } = route
          const { remoteCommand: _previousCommand, ...originalTarget } = original
          if (!isDeepStrictEqual(target, originalTarget)) {
            const prepared = await previous.client.prepareRoute({ ...config, hostId: config.id }, candidate.controller.signal)
            try { if (!accepted() || leases.get(config.id) !== previous) return; prepared.assertCurrent(); prepared.activate() }
            finally { await prepared.dispose() }
          }
          if (!accepted()) return
          previous.client.setRemoteCommand(config.remoteCommand); previous.config = config
        } else {
          const client = await connectSshAgentMux({ expectedRuntimeId: runtimeId, waitForReady: false, target: { ...config, hostId: config.id } })
          if (!accepted()) { await client.dispose(); return }
          leases.set(config.id, { config, client }); changed()
        }
      } catch { issue(`Host ${config.id} could not confirm its original Runtime on the configured route.`) }
      finally { if (routes.get(config.id) === candidate) routes.delete(config.id) } })())
    }
  }
  const retryObservation = () => {
    if (closed || retry) return
    // Only a failed exact-directory watcher is retried; healthy observation does no polling.
    retry = setTimeout(() => { retry = undefined; void refresh() }, 1000).unref()
  }
  const observe = () => {
    if (closed || watcher || !path || !isAbsolute(path)) return
    try {
      const exact = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (name === null || String(name) === basename(path)) void refresh()
      })
      watcher = exact
      exact.on('error', () => { if (watcher === exact) watcher = undefined; exact.close(); issue('Watching the original Host configuration failed.'); retryObservation() })
    } catch { issue('Watching the original Host configuration failed.'); retryObservation() }
  }
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve()
    dirty = true
    if (pending) return pending
    observe() // Parent-directory observation survives the original atomic rename.
    const work = (async () => { while (dirty && !closed) { dirty = false; await apply() } })()
    pending = work.finally(() => { pending = undefined })
    return pending
  }
  return {
    start() { if (!started && !closed) { started = true; void refresh() } },
    subscribeClients(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    clients: () => [...leases].map(([hostId, lease]) => ({ hostId, client: lease.client })),
    async close() {
      closed = true; configurationRead.abort(); if (retry) clearTimeout(retry); watcher?.close(); watcher = undefined
      for (const route of routes.values()) route.controller.abort()
      await pending
      const results = await Promise.allSettled([...work, ...[...leases.values()].map(lease => lease.client.dispose())])
      leases.clear(); changed(); listeners.clear()
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Configured Host consumer cleanup is unconfirmed. Original Runs were retained.')
    }
  }
}
