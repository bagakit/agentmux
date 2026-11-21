import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AgentOpenDescription } from '@agentmux/core/agent-open-contract'
import type { AgentMuxSpaceAgentTarget } from '@agentmux/core'
import type { HostRouteChoices } from '@agentmux/core/host-route'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AppConfig } from '../../../shared/contracts'
import type { SpaceMountHostChoices, SpaceMountResources } from '../../../shared/space-mount'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { configValuesEqual } from '../../../shared/config-edit'
import { mountedRegistrationInput, mountedRegistrationKey, type MountedSpaceRegistrationInput } from '../lib/space-mount-view'
import { checkpointMountedSpaceInputs, useAppStore, type LauncherExecutionSelection } from '../store'
import { SelectionField } from './SelectionField'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { AgentWorkProjectAnchor } from './AgentWorkProjectAnchor'
import type { LauncherSourceCoordinatorExecution } from '../lib/launcher-source'

const RefreshIcon = semanticIconComponent('action.refresh')

/** Chooses identities in the project's original Core realm. Preparation creates no Agent. */
export function SourceAgentTargetSetup({ config, active, initialSelection, fixedResourceWorkspaceId, actionLabel, preparationNote, disabled, onApply, onCancel, onOpenHost, presentation, menuBoundary, onChooseCustom, setupRef, showRoleLabels }: {
  config: Pick<AppConfig, 'hosts' | 'workspaces'>; active: boolean; initialSelection?: LauncherExecutionSelection | undefined
  fixedResourceWorkspaceId?: string | undefined; actionLabel: string; disabled?: boolean | undefined
  preparationNote?: string | undefined
  onApply(selection: LauncherExecutionSelection): boolean | void | Promise<boolean | void>
  onCancel?: (() => void) | undefined; onOpenHost?: ((hostId: string) => void) | undefined
  presentation?: 'anchored-editor' | undefined; menuBoundary?: HTMLElement | null | undefined
  onChooseCustom?: (() => void) | undefined
  setupRef?: RefObject<HTMLDivElement | null> | undefined
  showRoleLabels?: boolean
}) {
  const [projectId, setProjectId] = useState(fixedResourceWorkspaceId ?? initialSelection?.resourceWorkspaceId ?? '')
  const project = config.workspaces.find(item => item.id === (fixedResourceWorkspaceId ?? projectId))
  const hostId = project?.hostId ?? initialSelection?.source?.target.hostId
  const host = config.hosts.find(item => item.id === hostId)
  const [resources, setResources] = useState<SpaceMountResources>(), [choices, setChoices] = useState<SpaceMountHostChoices>()
  const [routes, setRoutes] = useState<HostRouteChoices>(), [description, setDescription] = useState<AgentOpenDescription>()
  const [resourceIssue, setResourceIssue] = useState<string>(), [choiceIssue, setChoiceIssue] = useState<string>(), [routeIssue, setRouteIssue] = useState<string>(), [contractIssue, setContractIssue] = useState<string>()
  const [selected, setSelected] = useState<AgentMuxSpaceAgentTarget | undefined>(initialSelection?.source?.kind === 'source-coordinator' ? undefined : initialSelection?.source?.agentTarget)
  const [independent, setIndependent] = useState(initialSelection?.source?.kind === 'source-coordinator')
  const [coordinator, setCoordinator] = useState<LauncherSourceCoordinatorExecution['coordinator']>(), [coordinatorIssue, setCoordinatorIssue] = useState<string>()
  const localHost = config.hosts.find(item => item.kind === 'local')
  const [pending, setPending] = useState(false), [issue, setIssue] = useState<string>(), [refresh, setRefresh] = useState(0)
  const projectAddress = (value: typeof project) => value ? [value.id, value.hostId, value.path, value.repoPath] : null
  const hostAddress = (value: typeof host) => {
    if (value) { const { label: _label, ...route } = value; return route }
    return hostId ? { id: hostId } : null
  }
  const identity = JSON.stringify([projectAddress(project), hostAddress(host)]), current = useRef({ identity, active }); current.current = { identity, active }
  const initiallyConfigured = useRef({
    project: Boolean(useAppStore.getState().config?.workspaces.find(item => item.id === project?.id)),
    host: Boolean(useAppStore.getState().config?.hosts.find(item => item.id === hostId))
  })
  const producer = useRef(false)
  useEffect(() => () => { current.current = { ...current.current, active: false } }, [])
  useEffect(() => {
    setResources(undefined); setResourceIssue(undefined); setChoices(undefined); setRoutes(undefined); setDescription(undefined)
    setChoiceIssue(undefined); setRouteIssue(undefined); setContractIssue(undefined)
    if (!active || !project || !hostId) return
    const controller = new AbortController()
    void api.spaceMounts.call('resources', { hostId }, controller.signal).then(reply => {
      if (!controller.signal.aborted) setResources(reply)
    }).catch(cause => { if (!controller.signal.aborted) setResourceIssue(presentError(cause)) })
    return () => controller.abort()
  }, [identity, active, refresh])
  useEffect(() => {
    if (!active || !resources) return
    const controller = new AbortController(), source = { hostId: resources.hostId, expectedRuntimeId: resources.runtimeId }
    // Independent reads: a route catalogue cannot hold back the project device or Source contract.
    void api.spaceMounts.call('hostChoices', source, controller.signal).then(reply => { if (!controller.signal.aborted) setChoices(reply) })
      .catch(cause => { if (!controller.signal.aborted) setChoiceIssue(presentError(cause)) })
    void api.spaceMounts.call('routeChoices', source, controller.signal).then(reply => { if (!controller.signal.aborted) setRoutes(reply) })
      .catch(cause => { if (!controller.signal.aborted) setRouteIssue(presentError(cause)) })
    void api.spaceMounts.call('describe', source, controller.signal).then(reply => { if (!controller.signal.aborted) setDescription(reply) })
      .catch(cause => { if (!controller.signal.aborted) setContractIssue(presentError(cause)) })
    return () => controller.abort()
  }, [resources, active])
  useEffect(() => {
    setCoordinator(undefined); setCoordinatorIssue(undefined)
    if (!active || !independent || !localHost) return
    const controller = new AbortController(), originalHost = structuredClone(localHost)
    // This read belongs only to the explicit independent A choice. B and its
    // saved D routes continue without acquiring or waiting for A.
    void (async () => {
      const target = await api.sessions.executionCoordinatorTarget()
      controller.signal.throwIfAborted()
      if (target.hostId !== originalHost.id) throw Error('The original Coordinator belongs to another device. Your selection is retained.')
      const home = await api.hosts.home(originalHost, { signal: controller.signal })
      if (home.routeHostId !== originalHost.id) throw Error('The Coordinator home belongs to another device. No project was registered.')
      if (!controller.signal.aborted) setCoordinator({ ...target, homeDirectory: home.homeDirectory })
    })().catch(cause => { if (!controller.signal.aborted) setCoordinatorIssue(presentError(cause)) })
    return () => controller.abort()
  }, [active, independent, localHost?.id, refresh])
  // 'local' is the Core's canonical self selector (HostConfig also fixes its id).
  // Reading other saved Hosts must not take away the confirmed Source device.
  const target = selected ?? (resources ? { hostId: 'local', runtimeId: resources.runtimeId } : undefined)
  const choiceKey = independent ? 'independent-coordinator' : target ? JSON.stringify(target.adoptedRoute ? ['route', target] : ['host', target.hostId]) : ''
  const projects = resources?.workspaces.filter(item => item.hostId === 'local' && item.path === project?.path &&
    (item.repoPath ?? item.path) === (project?.repoPath ?? project?.path)) ?? []
  async function prepare() {
    if (producer.current || !active || disabled || !project || !hostId || !resources || !target || independent && !coordinator) return
    const originalProject = project, originalHostId = hostId, originalIdentity = identity, originalTarget = target, originalCoordinator = independent ? coordinator : undefined
    producer.current = true; setPending(true); setIssue(undefined)
    try {
      if (projects.length !== 1) throw Error(projects.length ? 'More than one original project matches this folder. Review its original project catalogue; your selection is kept.'
        : 'This folder has not been confirmed in the project device’s registered projects. Register that exact folder on the project device before preparing this new arrangement. Your original Launcher remains available.')
      const sourceProject = projects[0]!, registration = { runtimeId: resources.runtimeId, workspaceId: sourceProject.workspaceId,
        expectedResource: { hostId: sourceProject.hostId, workspacePath: sourceProject.path, projectRootPath: sourceProject.repoPath ?? sourceProject.path } }
      // A direct Host with no learned pin gets its Runtime only from its original selected inventory.
      const confirmedTarget = originalCoordinator || originalTarget.runtimeId ? originalTarget : { ...originalTarget,
        runtimeId: (await api.spaceMounts.call('executors', { hostId: originalHostId, expectedRuntimeId: resources.runtimeId, agentHostId: originalTarget.hostId })).runtimeId }
      const input: MountedSpaceRegistrationInput = { kind: 'folder-registration', hostId: originalHostId, registration, submitted: false }
      const key = mountedRegistrationKey(input), store = useAppStore.getState()
      const retained = mountedRegistrationInput(useAppStore.getState().mountedSpaceInputs, key)
      // A first explicit preparation uses the original idempotent registration owner.
      // Only a retained possible submission needs read-only recovery; no observation gate is added to a first request.
      let found = retained?.submitted ? await api.spaceMounts.call('inspectRegistration', { hostId: retained.hostId, registration: retained.registration }) : null
      if (!found) {
        if (retained?.submitted) throw Error('The original project registration is retained and currently not found. Its result remains unknown; it has not been submitted again. Check the original registration in this device’s project settings.')
        const frozen = retained ?? input
        store.retainSpaceMountRegistration(key, () => ({ ...frozen, submitted: true }))
        let dispatched = false
        try {
          await checkpointMountedSpaceInputs(); dispatched = true
          found = await api.spaceMounts.call('register', { hostId: frozen.hostId, registration: frozen.registration })
          store.retainSpaceMountRegistration(key, original => original?.registration === frozen.registration ? { ...original, confirmed: true } : original)
        } catch (cause) {
          store.retainSpaceMountRegistration(key, original => original?.registration === frozen.registration ? { ...original, submitted: dispatched,
            issue: `${dispatched ? 'The original registration result is unknown.' : 'This registration was not sent.'} ${presentError(cause)}` } : original)
          throw cause
        }
      }
      const now = useAppStore.getState().config
      if (!current.current.active || current.current.identity !== originalIdentity) return
      const originalSource = initialSelection?.source
      const unconfiguredSourceProject = !initiallyConfigured.current.project && originalSource &&
        configValuesEqual(projectAddress(originalSource.project as typeof project), projectAddress(originalProject))
      const unconfiguredSourceHost = !initiallyConfigured.current.host && originalSource?.target.hostId === originalHostId
      const currentProject = now?.workspaces.find(item => item.id === originalProject.id) ?? (unconfiguredSourceProject ? originalProject : undefined)
      const currentHost = now?.hosts.find(item => item.id === originalHostId) ?? (unconfiguredSourceHost ? host : undefined)
      if (!configValuesEqual(projectAddress(currentProject), projectAddress(originalProject)) ||
        !configValuesEqual(hostAddress(currentHost), hostAddress(host))) throw Error('The original project or connection changed. Its confirmed registration and your draft are retained; review the current selection.')
      const applied = await onApply({ resourceWorkspaceId: originalProject.id, agentWorkspaceId: null, source: {
        project: { id: project.id, hostId: project.hostId, path: project.path, ...(project.repoPath === undefined ? {} : { repoPath: project.repoPath }) },
        target: { hostId: originalHostId, reference: found.reference, zoneId: found.zoneId, workspaceId: found.workspaceId },
        ...(originalCoordinator ? { kind: 'source-coordinator' as const, coordinator: originalCoordinator } : { agentTarget: confirmedTarget }) } })
      if (applied === false) throw Error('The original Launcher could not accept this arrangement. Its project and draft are retained.')
    } catch (cause) { if (current.current.active && current.current.identity === originalIdentity) setIssue(presentError(cause)) }
    finally { producer.current = false; setPending(false) }
  }
  const anchored = presentation === 'anchored-editor'
  const projectChoice = <SelectionField label="Project for this arrangement" value={projectId} disabled={disabled || !active || pending} menuBoundary={menuBoundary ?? null}
    options={[{ value: '', label: 'Choose a registered project…' }, ...config.workspaces.filter(item => !isScratchWorkspaceId(item.id)).map(item => ({ value: item.id, label: item.name, description: `${config.hosts.find(host => host.id === item.hostId)?.label ?? item.hostId} · ${item.path}` }))]}
    onValueChange={id => { setProjectId(id); setSelected(undefined); setIndependent(false); setIssue(undefined) }} />
  const supported = description && (independent ? description.contracts.externalAssociation : description.contracts.ordinaryLaunch)
  const requiredContract = independent ? description?.contracts.externalAssociation : description?.contracts.ordinaryLaunch
  const hostRecovery = Boolean(description && !requiredContract) || Boolean(contractIssue)
  const hostLink = host && onOpenHost ? <button type="button" className={anchored ? 'small-button' : 'agent-work-text-action'} onClick={() => onOpenHost(host.id)}>{description && !requiredContract ? `Open ${host.label} to update Core` : 'Project device settings'}</button> : null
  const compatibilityText = `${independent ? 'The project device accepts a link to the original Coordinator’s Agent.' : 'The project device accepts complete launch fields.'} Native tool qualification is checked during Launch preparation.`
  const compatibility = supported ? <div className="agent-work-compatibility"><strong>Launch compatibility</strong><p>{compatibilityText}</p></div> : null
  return <div ref={setupRef} tabIndex={-1} className="agent-work-setup" data-source-arrangement data-presentation={presentation} aria-busy={pending || undefined}>
    <div className="agent-work-setup__body">
    {fixedResourceWorkspaceId ? <AgentWorkProjectAnchor project={project} hostLabel={host?.label} compact={anchored} />
      : showRoleLabels ? <div className="agent-work-project-choice"><span className="agent-work-end__label">Project &amp; tools</span>{projectChoice}
        {!project ? <p className="agent-work-setup__note">Choose the folder that holds your files.</p> : null}</div> : projectChoice}
    <div className="agent-work-device-choice">
      {anchored || showRoleLabels ? <div className="agent-work-device-choice__label"><span className="agent-work-end__label">Agent runs on</span>
        {anchored ? <IconButton type="button" aria-label="Refresh Agent device choices" title="Refresh Agent devices known by the project device" disabled={!active || pending} onClick={() => setRefresh(value => value + 1)}><RefreshIcon size={13} /></IconButton> : null}</div> : null}
      <SelectionField label="Agent runs on" value={choiceKey} disabled={disabled || !active || pending} menuBoundary={menuBoundary ?? null} onValueChange={value => {
        if (value === 'independent-coordinator') { setIndependent(true); setSelected(undefined); return }
        setIndependent(false)
        const route = routes?.routes.find(item => JSON.stringify(['route', item.agentTarget]) === value)
        if (route) setSelected(route.agentTarget)
        else if (value === JSON.stringify(['host', 'local'])) setSelected(undefined)
        else { const host = choices?.hosts.find(item => JSON.stringify(['host', item.hostId]) === value); if (host) setSelected({ hostId: host.hostId, runtimeId: host.runtimeId ?? '' }) }
      }} options={[...(!resources ? [{ value: '', label: project ? 'Reading this project device…' : 'Choose a project first', disabled: true }] : []),
        ...(target && target.adoptedRoute && !routes?.routes.some(route => configValuesEqual(route.agentTarget, target)) ? [{ value: choiceKey, label: `Retained route · ${target.hostId}` }] : []),
        ...(resources ? [{ value: JSON.stringify(['host', 'local']), label: 'Project device', description: host?.label ?? hostId ?? 'Original project device' }] : []),
        ...(localHost && host?.kind !== 'local' ? [{ value: 'independent-coordinator', label: localHost.label, description: 'Reach · Agent here, files on the project device' }] : []),
        ...(choices?.hosts.filter(host => host.kind !== 'local').map(host => ({ value: JSON.stringify(['host', host.hostId]), label: host.label, description: 'Agent device known by the project device' })) ?? []),
        ...(routes?.routes.map(route => ({ value: JSON.stringify(['route', route.agentTarget]), label: route.id, description: `Saved route · ${route.agentTarget.adoptedRoute.hops.length} hops` })) ?? [])]} />
      <p className="agent-work-setup__note">{!project && showRoleLabels ? null : !project ? 'Choose the folder that holds your files.' : !target ? 'Waiting for the project device to confirm where the Agent can run.' : independent ? 'Reach · Agent here, files and tools on the project device.' : target.runtimeId === resources?.runtimeId ? 'Agent and files on this project’s device.' : 'Outpost · files and tools stay with this project.'}</p>
      {independent && !coordinator ? <p role="status">{coordinatorIssue ? `This device’s Coordinator is unconfirmed: ${coordinatorIssue}` : 'Reading this device’s original Coordinator and home…'}</p> : null}
    </div>
    {project && !(independent ? description?.contracts.externalAssociation : description?.contracts.ordinaryLaunch) ? <p className="agent-work-setup__note" role="status">{description
      ? independent ? `Update AgentMux Core on ${host?.label ?? 'the project device'} before linking this Reach Agent. This Core does not support an external Coordinator reference.`
        : `Update AgentMux Core on ${host?.label ?? 'the project device'} before launching this arrangement. The current Core cannot retain its complete launch fields.`
      : contractIssue ? `The project device’s launch support is unconfirmed. ${contractIssue}` : 'Reading launch support…'}</p> : null}
    {anchored ? (compatibility || hostLink && !hostRecovery || onChooseCustom ? <details className="agent-work-startup"><summary>Startup & device details</summary><div className="agent-work-setup__details-body">
      {compatibility}
      <div className="agent-work-setup__utility-actions">{!hostRecovery ? hostLink : null}{onChooseCustom ? <Button type="button" className="agent-work-setup__custom-startup" onClick={onChooseCustom}>Choose a custom startup directory</Button> : null}</div>
    </div></details> : null) : compatibility ? <details><summary>Launch compatibility</summary><p>{compatibilityText}</p></details> : null}
    {issue || resourceIssue ? <p className="agent-work-setup__error" role="status">{issue ?? resourceIssue}</p> : null}
    {choiceIssue || routeIssue ? <details><summary>Other Agent devices unconfirmed</summary><p>{choiceIssue}</p><p>{routeIssue}</p></details> : null}
    {!anchored || hostRecovery ? hostLink : null}
    </div>
    <footer className="agent-work-setup__actions"><span>{preparationNote ?? 'Applies to this Launcher. Launch starts the task.'}</span><div>
      {onCancel ? <Button type="button" onClick={onCancel}>Cancel</Button> : null}
      {!anchored ? <Button type="button" disabled={!active || pending} onClick={() => setRefresh(value => value + 1)}>Refresh</Button> : null}
      <Button type="button" variant="primary" disabled={disabled || !active || pending || !project || !target || independent && !coordinator} onClick={() => void prepare()}>{pending ? 'Preparing…' : actionLabel}</Button>
    </div></footer>
  </div>
}
