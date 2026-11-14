import { useRef, useState } from 'react'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { FocusContext } from '../lib/focus-context'
import type { FocusScanLane } from '../lib/focus-collection-lanes'
import { FOCUS_GROUP_TASKS, focusGroupProjectKey, focusGroupTask, focusGroupTaskScopeKey } from '../lib/focus-group-task'
import { moteTaskPacketKey } from '../lib/mote-task-packet'
import { openFocusGroupAgentLauncher, type FocusGroupLauncher } from '../lib/focus-group-launcher'
import { useAppStore } from '../store'
import { MoteTaskAction } from './MoteTaskAction'
import { SelectionField } from './SelectionField'

const taskIcons = { organize: 'object.list', analyze: 'action.inspect', learn: 'object.notebook' } as const

/** The menu owns one retained discussion. It consumes loaded members, not a second directory. */
export function FocusGroupDiscussion({ lane, contexts, active, container }: {
  lane: FocusScanLane; contexts: readonly FocusContext[]
  active: boolean; container: HTMLElement | null
}) {
  const workspaces = useAppStore(state => state.config?.workspaces)
  const hosts = useAppStore(state => state.config?.hosts)
  const projects = (workspaces ?? []).filter(project => project.id !== SCRATCH_WORKSPACE_ID && !project.closeout)
  const exactProject = !lane.collection ? projects.find(project => project.id === lane.projectId && project.hostId === lane.hostId) : undefined
  const resources = [...workspaces ?? [], ...contexts.flatMap(context => context.workspace ? [context.workspace] : [])]
  const scopeKey = focusGroupTaskScopeKey(lane, resources)
  const [choice, setChoice] = useState<{ scopeKey: string; projectKey: string } | null>(null)
  const selectedKey = exactProject ? focusGroupProjectKey(exactProject) : choice?.scopeKey === scopeKey ? choice.projectKey : ''
  const project = projects.find(project => focusGroupProjectKey(project) === selectedKey)
  const prepared = useRef(new Map<string, { target: FocusGroupLauncher; projectKey: string }>())
  return <MoteTaskAction scopeKey={scopeKey} orientation="vertical" active={active} portalContainer={container}
    actions={FOCUS_GROUP_TASKS.map(action => ({ ...action, icon: taskIcons[action.id], createTask: async recipient => focusGroupTask(action.id, lane, resources, recipient) }))}
    newAgent={{ key: selectedKey || JSON.stringify(['unselected-project', scopeKey]), label: '新 Agent',
      details: <div className="focus-group-discussion__project"><SelectionField label="Project for new Agent" value={selectedKey} menuContainer={container}
        options={projects.map(project => ({ value: focusGroupProjectKey(project), label: project.name,
          description: `${hosts?.find(host => host.id === project.hostId)?.label ?? project.hostId} · ${project.path}` }))}
        missingOptionLabel="Choose a project" missingOptionDescription="Choose the exact project and Host for this new Agent."
        onValueChange={projectKey => setChoice({ scopeKey, projectKey })} />
        <small>The task opens in this project’s Launcher. Choose an Executor there to start.</small></div>,
      onTask(prompt, current, focusTask) {
        if (!project) throw new Error('Choose the exact project for this new Agent. Nothing was started; the group and its task are kept.')
        const target = openFocusGroupAgentLauncher(project, prompt, current, focusTask)
        if (target) prepared.current.set(moteTaskPacketKey(prompt, focusTask), { target, projectKey: focusGroupProjectKey(project) })
      },
      onOpen(prompt, focusTask) {
        const original = prepared.current.get(moteTaskPacketKey(prompt, focusTask)), target = original?.target, state = useAppStore.getState()
        const tab = target ? state.tabs[target.tabId] : undefined
        const resources = state.config?.workspaces.filter(workspace => workspace.id === target?.workspaceId) ?? []
        if (!target || !tab?.regions[target.regionId] || tab.workspaceId !== target.workspaceId || resources.length !== 1 || focusGroupProjectKey(resources[0]!) !== original?.projectKey) {
          state.reportError(new Error('The original project Launcher is no longer open. Its task was not sent again; use the original project to review it.'))
          return
        }
        state.focusRegion(target.workspaceId, target.tabId, target.regionId, 'navigation', target.groupId)
        state.setMainSurface('workbench')
      }
    }} />
}
