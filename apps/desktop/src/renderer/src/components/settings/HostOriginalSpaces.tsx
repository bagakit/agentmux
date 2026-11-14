import { useEffect, useMemo, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { HostConfig } from '../../../../shared/contracts'
import type { SpaceMountResources } from '../../../../shared/space-mount'
import type { FolderSpaceRegistrationInspection } from '@agentmux/core/space-folder'
import { api } from '../../lib/api'
import { mountedRegistrationInput, mountedRegistrationKey, mountedSpaceInputs, type MountedSpaceRegistrationInput } from '../../lib/space-mount-view'
import { checkpointMountedSpaceInputs, useAppStore } from '../../store'
import { configValuesEqual } from '../../../../shared/config-edit'
import '../mounted-space.css'

/** These projects belong to the answering Core, not this Desktop's folder catalogue. */
export function HostOriginalSpaces({ host, active, onClose }: { host: HostConfig; active: boolean; onClose?: (() => void) | undefined }) {
  const inputs = useAppStore(state => state.mountedSpaceInputs)
  const [resources, setResources] = useState<SpaceMountResources>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  const [inspections, setInspections] = useState<Record<string, FolderSpaceRegistrationInspection | null>>({})
  const inspectionReader = useRef<AbortController | undefined>(undefined)
  const current = useRef({ host, active }); current.current = { host, active }
  useEffect(() => () => { current.current = { ...current.current, active: false }; inspectionReader.current?.abort() }, [])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setResources(undefined); setError(undefined)
    void api.spaceMounts.call('resources', { hostId: host.id }, controller.signal).then(result => {
      if (!controller.signal.aborted) setResources(result)
    }).catch(cause => { if (!controller.signal.aborted) setError(presentError(cause)) })
    return () => { controller.abort(); inspectionReader.current?.abort() }
  }, [host, active, refresh])
  const retained = useMemo(() => {
    const result: Array<{ key: string; input: MountedSpaceRegistrationInput }> = []
    try { for (const key of Object.keys(mountedSpaceInputs(inputs))) {
      try { const input = mountedRegistrationInput(inputs, key); if (input?.hostId === host.id) result.push({ key, input }) } catch { /* Other entries retain their original bytes and are not this registration reader. */ }
    } } catch { /* The original storage issue remains with its owner; ordinary work stays available. */ }
    return result
  }, [inputs, host.id])
  async function register(project: SpaceMountResources['workspaces'][number]) {
    if (!resources || busy) return
    const savedHost = host, input: MountedSpaceRegistrationInput = { kind: 'folder-registration', hostId: host.id,
      registration: { runtimeId: resources.runtimeId, workspaceId: project.workspaceId, expectedResource: {
        hostId: project.hostId, workspacePath: project.path, projectRootPath: project.repoPath ?? project.path } }, submitted: false }
    const key = mountedRegistrationKey(input), store = useAppStore.getState()
    // An uncertain original request is inspected from its own retained action, never silently replaced.
    if (mountedRegistrationInput(store.mountedSpaceInputs, key)) { setError('This original registration request is retained below. Inspect it before submitting another request.'); return }
    await sendOriginal(key, input, savedHost)
  }
  async function sendOriginal(key: string, originalInput: MountedSpaceRegistrationInput, savedHost = host) {
    if (busy || originalInput.submitted) return
    const store = useAppStore.getState(), input = { ...originalInput, submitted: true }
    // Persist possible submission before dispatch; a crash must never restore a false "not sent" claim.
    store.retainSpaceMountRegistration(key, () => input)
    setBusy(true); setError(undefined)
    let submitted = false, confirmed = false
    try {
      await checkpointMountedSpaceInputs()
      submitted = true
      const reply = await api.spaceMounts.call('register', { hostId: input.hostId, registration: input.registration })
      confirmed = true
      const reveal = current.current.active && configValuesEqual(current.current.host, savedHost)
      store.mountSpace({ hostId: input.hostId, reference: reply.reference, zoneId: reply.zoneId, workspaceId: reply.workspaceId }, reveal)
      store.retainSpaceMountRegistration(key, original => original?.registration === input.registration ? undefined : original)
      if (reveal) onClose?.()
    } catch (cause) {
      const issue = `${confirmed ? 'The original registration is confirmed. Opening this private view did not complete.' : submitted ? 'The original registration result is unknown.' : 'The registration was not sent.'} ${presentError(cause)}`
      store.retainSpaceMountRegistration(key, original => original?.registration === input.registration ? { ...original, submitted, confirmed, issue } : original)
      if (current.current.active && configValuesEqual(current.current.host, savedHost)) setError(issue)
    } finally { setBusy(false) }
  }
  async function inspectOriginal(key: string, input: MountedSpaceRegistrationInput) {
    inspectionReader.current?.abort()
    const controller = new AbortController(); inspectionReader.current = controller
    try {
      const result = await api.spaceMounts.call('inspectRegistration', { hostId: input.hostId, registration: input.registration }, controller.signal)
      if (!controller.signal.aborted) { setInspections(values => ({ ...values, [key]: result })); setError(undefined) }
    } catch (cause) {
      if (!controller.signal.aborted) setError(presentError(cause) + (cause && typeof cause === 'object' && 'detail' in cause && typeof cause.detail === 'string' ? ` ${cause.detail}` : ''))
    }
  }
  return <section className="host-original-spaces" aria-label={`Original Spaces on ${host.label}`}>
    <header><div><strong>Spaces on {host.label}</strong><small>Shared membership · private window and task drafts</small></div>
      <button type="button" className="small-button" onClick={() => setRefresh(value => value + 1)}>Refresh Spaces</button></header>
    <p className="settings-group-note">Open a project registered by this Host's own Core. It keeps the same original Space and Agents in each window.</p>
    {error ? <p role="status" className="mounted-space-issue">{error}</p> : null}
    {resources ? resources.workspaces.length ? <ul>{resources.workspaces.map(project => <li key={project.workspaceId}>
      <div><strong>{project.name}</strong><code>{project.path}</code><small>Project device: {project.hostId} · Source {resources.runtimeId}</small></div>
      <button type="button" className="small-button" disabled={busy || retained.some(entry => entry.input.registration.runtimeId === resources.runtimeId && entry.input.registration.workspaceId === project.workspaceId)} onClick={() => void register(project)}>Open original Space</button>
    </li>)}</ul> : <p className="settings-group-note">This Core has no registered project. Add a folder in its original configuration before mounting its Space.</p>
      : !error ? <p role="status" className="settings-group-note">Reading the original project catalogue…</p> : null}
    {retained.map(({ key, input }) => <section key={key} className="host-original-spaces__retained" aria-label="Original Space registration request">
      <strong>{input.confirmed ? 'Original registration confirmed' : input.submitted ? 'Original registration result unknown' : 'Registration not sent'}</strong><code>{input.registration.expectedResource.workspacePath}</code>
      <p>{input.issue ?? 'The frozen original request is retained. Inspect its source before taking another action.'}</p>
      {!input.submitted ? <button type="button" className="small-button" disabled={busy} onClick={() => void sendOriginal(key, input)}>Send original registration</button> : null}
      <button type="button" className="small-button" onClick={() => void inspectOriginal(key, input)}>Inspect original registration</button>
      {Object.hasOwn(inspections, key) ? inspections[key] ? <div role="status"><p>The exact original Space is currently registered. This observation does not confirm the original write response.</p>
        <button type="button" className="small-button" onClick={() => { try { const found = inspections[key]!; useAppStore.getState().mountSpace({ hostId: input.hostId, reference: found.reference, zoneId: found.zoneId, workspaceId: found.workspaceId }); onClose?.() } catch (cause) { setError(presentError(cause)) } }}>Open found original Space</button>
      </div> : <p role="status">The frozen resource's registration was not found in the current source observation. The original request remains unknown and has not been sent again.</p> : null}
      <details><summary>Original request</summary><pre>{JSON.stringify({ hostId: input.hostId, registration: input.registration }, null, 2)}</pre></details>
    </section>)}
  </section>
}
