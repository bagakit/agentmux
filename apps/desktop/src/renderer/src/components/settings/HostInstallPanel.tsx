import { mintObjectId } from '@agentmux/core/object-id'
import type { RemoteCoreInstallCheck, RemoteCoreInstallReceipt, RemoteCoreKeepRunning } from '@agentmux/core'
import { useEffect, useRef, useState } from 'react'
import type { SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import './host-install.css'

type Operation = { input: SshHostConfig; id: string; receipt?: RemoteCoreInstallReceipt; error?: string | undefined }
type Entry = { input: SshHostConfig; check?: RemoteCoreInstallCheck; operation?: Operation | undefined; busy?: 'check' | 'install' | 'inspect' | 'connect' | undefined; error?: string | undefined }
const stages: [RemoteCoreInstallReceipt['stage'], string][] = [
  ['preparing', 'Check the machine'], ['pushing-node', 'Copy Node runtime'], ['staging-core', 'Install Core'],
  ['starting', 'Start the service'], ['confirming', 'Verify its identity'], ['completed', 'Ready to connect']
]
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function matches(a: SshHostConfig, b: SshHostConfig): boolean {
  const { label: _a, ...left } = a, { label: _b, ...right } = b
  return configValuesEqual(left, right)
}
function belongs(entry: Entry, host: SshHostConfig): boolean {
  if (matches(entry.input, host)) return true
  const installed = entry.operation?.receipt?.installed
  return Boolean(installed && matches({ ...entry.input, remoteCommand: installed.remoteCommand,
    remoteSocketPath: installed.remoteSocketPath, runtimeId: installed.runtimeId }, host))
}

/** The Core owns the operation; this view retains its original input and ID through observation failures. */
export function useHostInstall({ host, committed, active, onManageUpdates }: {
  host: SshHostConfig; committed: SshHostConfig | undefined; active: boolean; onManageUpdates?: (() => void) | undefined
}) {
  const [entries, setEntries] = useState<Entry[]>([])
  const checkHost = useAppStore(state => state.checkHost)
  const [connection, setConnection] = useState<{ input: SshHostConfig; detail: string }>()
  const connectionFeedback = (detail: string) => setConnection({ input: structuredClone(host), detail })
  const [selection, setSelection] = useState<{ input: SshHostConfig; mode: RemoteCoreKeepRunning }>()
  const mode = selection && matches(selection.input, host) ? selection.mode : 'start-script'
  const setMode = (mode: RemoteCoreKeepRunning) => setSelection({ input: structuredClone(host), mode })
  const current = useRef({ host, committed, active })
  current.current = { host, committed, active }
  const state = entries.find(entry => belongs(entry, host))
  const operation = state?.operation, receipt = operation?.receipt, check = state?.check
  const saved = committed !== undefined && matches(host, committed)
  const busy = Boolean(state?.busy)
  const unresolved = Boolean(operation && (!receipt || receipt.status === 'running' || receipt.status === 'unknown'))
  const ready = saved && active && !busy && !state?.error && !operation && check?.eligible && check.expected
  function update(input: SshHostConfig, change: (entry: Entry) => Entry) {
    setEntries(previous => {
      const index = previous.findIndex(entry => belongs(entry, input))
      return index < 0 ? [...previous, change({ input })] : previous.map((entry, i) => i === index ? change(entry) : entry)
    })
  }
  async function checkMachine() {
    if (!saved || !active || busy || unresolved) return
    const input = structuredClone(host)
    update(input, entry => ({ ...entry, busy: 'check', error: undefined }))
    try {
      const result = await api.hosts.installCheck(input)
      update(input, entry => ({ ...entry, check: result, ...(result.latestOperation && !(result.eligible && result.latestOperation.status === 'failed') ? { operation: {
        input: result.latestOperation.input as SshHostConfig, id: result.latestOperation.operationId, receipt: result.latestOperation
      } } : { operation: undefined }) }))
    } catch (error) { update(input, entry => ({ ...entry, error: message(error) })) }
    finally { update(input, entry => ({ ...entry, busy: undefined })) }
  }
  async function inspect(original: Operation, manual = false) {
    if (manual) update(original.input, entry => ({ ...entry, busy: 'inspect' }))
    try {
      const result = await api.hosts.installInspect(original.input, original.id)
      update(original.input, entry => {
        if (result && entry.operation?.receipt && (entry.operation.receipt.updatedAt > result.updatedAt || entry.operation.receipt.status === 'completed' && result.status !== 'completed')) return entry
        return { ...entry, operation: { ...original, ...(result ? { receipt: result } : {}),
          ...(!result ? { error: 'No record was found for this original operation. Its outcome remains unconfirmed; keep this ID for diagnosis.' } : {}) } }
      })
    } catch (error) { update(original.input, entry => ({ ...entry, operation: { ...entry.operation!, error: message(error) } })) }
    finally { if (manual) update(original.input, entry => ({ ...entry, busy: undefined })) }
  }
  // Only an explicitly submitted install is observed. Hiding the page detaches this reader.
  useEffect(() => {
    if (!active || state?.busy !== 'install' || !operation || receipt && receipt.status !== 'running') return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (disposed) return
      await inspect(operation)
      if (!disposed) timer = setTimeout(read, 1500)
    }
    timer = setTimeout(read, 1500)
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, state?.busy, operation?.id, receipt?.status])
  async function confirm() {
    const now = current.current
    if (!ready || !check?.expected || !now.active || !now.committed || !matches(host, now.host) || !matches(host, now.committed)) return
    if (!check.keepRunning?.some(option => option.mode === mode && option.available)) return
    const input = structuredClone(host), expected = { ...structuredClone(check.expected), keepRunning: mode }, id = mintObjectId()
    update(input, entry => ({ ...entry, busy: 'install', error: undefined, operation: { input, id } }))
    try {
      const result = await api.hosts.install(input, expected, id)
      update(input, entry => ({ ...entry, operation: { input, id, receipt: result } }))
    } catch (error) { update(input, entry => ({ ...entry, operation: { ...entry.operation!, error: message(error) } })) }
    finally { update(input, entry => ({ ...entry, busy: undefined })) }
  }
  const step = receipt ? stages.findIndex(([key]) => key === receipt.stage) : -1
  const systemd = check?.keepRunning?.find(option => option.mode === 'systemd')
  return { host, active, entries, state, operation, receipt, check, saved, busy, unresolved, ready, mode, setMode, systemd, step, connection, connectionFeedback, update, checkMachine, confirm, inspect, checkHost, onManageUpdates }
}

/** Installation review and original receipt; the composition owns its controller. */
export function HostInstallPanel({ maintenance }: { maintenance: ReturnType<typeof useHostInstall> }) {
  const { host, active, state, operation, receipt, check, saved, busy, unresolved, ready, mode, setMode, systemd, step, connection, connectionFeedback, update, checkMachine, confirm, inspect, checkHost, onManageUpdates } = maintenance
  return <section className="host-install" data-host-install aria-label="First Core installation" aria-busy={busy}>
    <header className="host-install__header">
      <div><span className="host-install__eyebrow">CORE</span><h3>{operation ? 'Core installation' : 'Ready to install Core'}</h3></div>
      <span className="host-install__badge">Linux x64 · SSH</span>
    </header>
    <p className="host-install__intro">{operation ? 'The original installation and its result are retained.' : 'No Core is installed at the checked location. Review how it stays running, then install.'}</p>
    {!operation && <div className="host-install__actions">
      <button className="small-button" type="button" data-install-check disabled={!saved || !active || busy} onClick={() => void checkMachine()}>
        {state?.busy === 'check' ? 'Checking machine…' : check ? 'Check again' : 'Check installation'}</button>
      {!saved && <span>Save this Host before checking.</span>}
    </div>}
    {state?.error && <p role="status" className="host-install__notice">{state.error}</p>}
    <HostInstallRecords maintenance={maintenance} />
    {check?.unreadableOperations?.length ? <details><summary>Unconfirmed installation records</summary>
      <p>These original records could not be read. Their targets and outcomes remain unknown; no installation is replayed.</p>
      <code>{check.unreadableOperations.join(', ')}</code></details> : null}
    {check && !operation && <>
      <div className="host-install__machine">
        <strong>{host.label}</strong><span>{host.hostname}</span>
        {check.probe && <dl><div><dt>Platform</dt><dd>{check.probe.platform} · {check.probe.machine} · glibc {check.probe.glibc ?? 'unknown'}</dd></div>
          <div><dt>Install location</dt><dd><code>{check.probe.prefix}</code></dd></div></dl>}
        <details><summary>Machine details</summary><p>{check.detail}</p></details>
      </div>
      {check.eligible && <div className="host-install__review" role="group" aria-label="Review Core installation">
        <div><h4>How should Core stay running?</h4><p>Choose what happens after this machine restarts.</p></div>
        <div className="host-install__choices" role="radiogroup" aria-label="Keep Core running">
          <label className="host-install__choice" data-selected={mode === 'start-script'}>
            <input type="radio" name={'core-running-' + host.id} value="start-script" checked={mode === 'start-script'} disabled={busy} onChange={() => setMode('start-script')} />
            <strong>Start script</strong><span>Start when you need it</span><p>Saves a start.sh script. After a reboot, run the script to bring Core back.</p>
          </label>
          <label className="host-install__choice" data-selected={mode === 'systemd'} aria-disabled={!systemd?.available}>
            <input type="radio" name={'core-running-' + host.id} value="systemd" checked={mode === 'systemd'} disabled={busy || !systemd?.available} onChange={() => setMode('systemd')} />
            <strong>User service</strong><span>Managed by systemd</span><p>{!systemd?.available ? 'The systemd user manager is unavailable on this machine.' : systemd.startsAtBoot === true ? 'Starts at boot. Linger is already enabled.' : systemd.startsAtBoot === false ? 'Starts at login. Boot startup needs linger, which this app does not enable.' : 'Startup at boot is unknown. Linger could not be read.'}</p>
          </label>
        </div>
        <div className="host-install__confirm"><span>Core {check.candidate?.version ?? 'version unknown'} · {check.candidate?.sourceCommit ? 'Source ' + check.candidate.sourceCommit.slice(0, 10) : 'Bundled candidate'}</span>
          <button type="button" className="primary-button" data-install-confirm disabled={!ready || !check.keepRunning?.some(option => option.mode === mode && option.available)} onClick={() => void confirm()}>Install on {host.label}</button></div>
      </div>}
    </>}
    {operation && <div className="host-install__operation">
      <h4>{receipt?.status === 'completed' ? 'Core installed' : receipt?.status === 'failed' ? 'Installation did not complete' : unresolved && !busy ? 'Original install needs checking' : 'Setting up Core'}</h4>
      <ol className="host-install__steps" aria-label="Installation stages">
        {stages.map(([key, label], index) => <li key={key} data-state={receipt?.status === 'completed' || index < step ? 'done' : index === step ? 'current' : 'pending'}>
          <span className="host-install__step-mark" aria-hidden="true">{receipt?.status === 'completed' || index < step ? '✓' : index + 1}</span><span>{label}</span>
          {index === step && receipt?.status === 'running' && <span className="host-install__pulse" aria-label="In progress" />}
        </li>)}
      </ol>
      <p role="status">{receipt?.detail ?? 'Waiting for the original installation receipt.'}</p>
      {operation.error && <p role="status" className="host-install__notice">{operation.error}</p>}
      {receipt?.connectionAdoption && <p role="status">{receipt.connectionAdoption.detail}</p>}
      {receipt?.installed && <details><summary>Installed service</summary><dl>
        <div><dt>Runtime</dt><dd><code>{receipt.installed.runtimeId}</code></dd></div>
        <div><dt>Service entry</dt><dd><code>{receipt.installed.remoteCommand}</code></dd></div>
        <div><dt>Start script</dt><dd><code>{receipt.installed.startScript}</code></dd></div></dl></details>}
      {receipt?.status === 'completed' && <button type="button" className="primary-button" data-install-connect disabled={!active || !saved || busy} onClick={() => {
        const original = operation
        update(original.input, entry => ({ ...entry, busy: 'connect' }))
        connectionFeedback('Checking the saved connection…')
        const connect = async () => {
          if (matches(original.input, host)) {
            // The original completed ID reads the retained deployment; only Main adopts its connection.
            const result = await api.hosts.install(original.input, receipt.expected, original.id)
            update(original.input, entry => ({ ...entry, operation: { input: original.input, id: original.id, receipt: result } }))
            connectionFeedback(result.connectionAdoption?.detail ?? 'The original installation is retained. See this Host’s connection status.')
          } else {
            await checkHost(host)
            connectionFeedback('Connection check completed. See this Host’s connection status.')
          }
        }
        void connect().catch(error => connectionFeedback(message(error))).finally(() => update(original.input, entry => ({ ...entry, busy: undefined })))
      }}>Connect to this Host</button>}
      {connection && matches(connection.input, host) && <p role="status">{connection.detail}</p>}
      {receipt?.status === 'completed' && onManageUpdates && <button type="button" className="small-button" data-install-updates
        disabled={!saved || !active || busy || matches(operation.input, host)} onClick={onManageUpdates}>Manage updates</button>}
      <details><summary>Original operation</summary><code>{operation.id}</code></details>
      {receipt?.status === 'failed' && <button type="button" className="small-button" data-install-recheck disabled={busy || !saved || !active} onClick={() => void checkMachine()}>Check installation again</button>}
      <button type="button" className="small-button" data-install-inspect disabled={busy || !active} onClick={() => void inspect(operation, true)}>Check original install</button>
    </div>}
  </section>
}

/** Original operations stay discoverable after the current connection is edited. */
export function HostInstallRecords({ maintenance }: { maintenance: ReturnType<typeof useHostInstall> }) {
  const { entries, host, active, inspect } = maintenance
  return <>{entries.filter(entry => entry.operation && !belongs(entry, host)).map(entry => <aside className="host-install__notice" key={entry.operation!.id}>
      <h4>Original install on {entry.input.hostname}</h4>
      <p>{entry.operation!.receipt?.detail ?? 'The original installation outcome is not confirmed.'}</p>
      <code>{entry.operation!.id}</code>
      <button type="button" className="small-button" disabled={!active} onClick={() => void inspect(entry.operation!, true)}>Check this original install</button>
    </aside>)}</>
}
