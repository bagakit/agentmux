import { useRef, useState } from 'react'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { FocusContext } from '../lib/focus-context'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusScanLane } from '../lib/focus-collection-lanes'
import { FOCUS_GROUP_TASKS, focusGroupProjectKey, focusGroupTaskPrompt, focusGroupTaskScopeKey } from '../lib/focus-group-task'
import { openFocusGroupAgentLauncher, type FocusGroupLauncher } from '../lib/focus-group-launcher'
import { useAppStore } from '../store'
import { MoteTaskAction } from './MoteTaskAction'
import { SelectionField } from './SelectionField'

/** The menu owns one retained discussion. It consumes loaded members, not a second directory. */
export function FocusGroupDiscussion({ lane, contexts, identities, active, container }: {
  lane: FocusScanLane; contexts: readonly FocusContext[]; identities: ReadonlyMap<string, FocusContextIdentity>
  active: boolean; container: HTMLElement | null
}) {
  const workspaces = useAppStore(state => state.config?.workspaces)
  const hosts = useAppStore(state => state.config?.hosts)
  const projects = (workspaces ?? []).filter(project => project.id !== SCRATCH_WORKSPACE_ID && !project.closeout)
  const exactProject = !lane.collection ? projects.find(project => project.id === lane.projectId && project.hostId === lane.hostId) : undefined
  const scopeKey = focusGroupTaskScopeKey(lane)
  const [choice, setChoice] = useState<{ scopeKey: string; projectKey: string } | null>(null)
  const selectedKey = exactProject ? focusGroupProjectKey(exactProject) : choice?.scopeKey === scopeKey ? choice.projectKey : ''
  const project = projects.find(project => focusGroupProjectKey(project) === selectedKey)
  const prepared = useRef(new Map<string, FocusGroupLauncher>())
  return <MoteTaskAction scopeKey={scopeKey} orientation="vertical" active={active} portalContainer={container}
    actions={FOCUS_GROUP_TASKS.map(action => ({ ...action, createTask: async recipient => focusGroupTaskPrompt(action.id, lane, contexts, identities, recipient) }))}
    newAgent={{ key: selectedKey || JSON.stringify(['unselected-project', scopeKey]), label: '新 Agent',
      details: <div className="focus-group-discussion__project"><SelectionField label="Project for new Agent" value={selectedKey} menuContainer={container}
        options={projects.map(project => ({ value: focusGroupProjectKey(project), label: project.name,
          description: `${hosts?.find(host => host.id === project.hostId)?.label ?? project.hostId} · ${project.path}` }))}
        missingOptionLabel="Choose a project" missingOptionDescription="Choose the exact project and Host for this new Agent."
        onValueChange={projectKey => setChoice({ scopeKey, projectKey })} />
        <small>The task opens in this project’s Launcher. Choose an Executor there to start.</small></div>,
      onTask(prompt, current) {
        if (!project) throw new Error('Choose the exact project for this new Agent. Nothing was started; the group and its task are kept.')
        const target = openFocusGroupAgentLauncher(project, prompt, current)
        if (target) prepared.current.set(prompt, target)
      },
      onOpen(prompt) {
        const target = prepared.current.get(prompt), state = useAppStore.getState()
        const tab = target ? state.tabs[target.tabId] : undefined
        if (!target || !tab?.regions[target.regionId]) {
          state.reportError(new Error('The original project Launcher is no longer open. Its task was not sent again; use the original project to review it.'))
          return
        }
        state.focusRegion(target.workspaceId, target.tabId, target.regionId, 'navigation', target.groupId)
        state.setMainSurface('workbench')
      }
    }} />
}
