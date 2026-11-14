import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { flushSync } from 'react-dom'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { MountedSpaceWorkbench } from '../../../src/renderer/src/components/MountedSpaceWorkbench'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { spaceMountKey } from '../../../src/shared/space-mount'
import '../../../src/renderer/src/styles/index.css'

// Actual Workbench/Store/production styles. Only original public external facts
// are controlled. No installed App, original SG1 or Native recovery is claimed.
mountThemeRuntime(window, { appAppearance: 'dark' })
const config = await api.config.get()
const reference = { runtimeId: 'source-runtime-4957f58e-d4e9-49eb-b684-d1750a86fc23', spaceId: 'original-source-project' }
const target = { hostId: 'source', reference, workspaceId: 'project', zoneId: 'project-zone' }
const source = { runtimeId: reference.runtimeId, ownerInstanceId: 'original-source-instance' }
const member = { regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'original-session-WtWoFZCEx52r', runId: null,
  creationOperationId: 'original-creation-3e0a7393-7118-4fe9-a239-66040327e802', execution: { hostId: 'remote-agent', runtimeId: 'agent-runtime-TFRFe7s232At', cwd: '/remote/user' } }
const snapshot: any = { reference, source, revision: 1, scope: { space: { spaceId: reference.spaceId, kind: 'folder', name: 'Sample Project', hostId: 'local', directoryPath: '/original/project', projectId: null },
  zones: [{ zoneId: target.zoneId, workspaceId: target.workspaceId, kind: 'directory', hostId: 'local', directoryPath: '/original/project', projectId: null, name: 'Sample Project' }],
  tabs: [{ tabId: member.tabId, zoneId: target.zoneId, workspaceId: target.workspaceId, name: 'Original remote task', regionIds: [member.regionId] }], regions: [member], bindings: [{ spaceId: reference.spaceId, zoneId: target.zoneId }], resources: {} } }
const execution = { coordinatorRuntimeId: reference.runtimeId, reference: { bindingId: 'original-binding', agentSessionId: member.agentSessionId, createOperationId: member.creationOperationId },
  inspection: { bindingId: 'original-binding', agentHostId: 'remote-agent', resourceHostId: 'local', agentSessionId: member.agentSessionId, resourceWorkspacePath: '/original/project', state: 'unavailable',
    continuation: { bindingId: 'original-binding', agentSessionId: member.agentSessionId, createOperationId: member.creationOperationId },
    helperStarts: { executor: { outcome: 'not-submitted', runId: null }, frontend: { outcome: 'not-submitted', runId: null } },
    diagnostic: { code: 'EXECUTION_HELPER_UNAVAILABLE', message: 'The original project helper could not be prepared. Its startup has not been acknowledged.' } } }
let failure = false, effectCount = 0, variant = 'pending'
api.spaceMounts.call = (async (method: string) => {
  if (method !== 'inspect') { effectCount++; throw Error('This visual fixture never starts an Agent: ' + method) }
  if (failure) throw Error('The latest Source observation is unavailable. The last confirmed original request is retained.')
  const confirmed = variant === 'confirmed' || variant === 'retired'
  const agent = confirmed ? { agentSessionId: member.agentSessionId, runId: 'original-run', providerId: 'codex', executorId: 'original-executor', hostId: member.execution.hostId, cwd: member.execution.cwd, createOperationId: member.creationOperationId, initialPrompt: 'not-requested', ...(variant === 'retired' ? { retirement: { source: 'user', observedAt: 2 } } : {}) } : null
  return { request: { known: true, operationId: member.creationOperationId, report: { operationId: member.creationOperationId, outcome: variant === 'retired' ? 'retired' : confirmed ? 'partial' : 'unknown', from: null, to: null, agent, resource: null,
    execution, save: { layoutApplied: true, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'confirmed', reason: null }, issues: [] } } }
}) as typeof api.spaceMounts.call
api.spaceMounts.watch = async () => ({ initial: snapshot, dispose() {} })
api.spaceMounts.sessions = async () => ({ initial: { reference, source, revision: 1 }, dispose() {} })
useAppStore.setState({ config: { ...config, hosts: [{ id: 'source', kind: 'ssh', label: 'Original project device', hostname: 'private-route.example' }] }, sessions: [], loading: false })
useAppStore.getState().mountSpace(target)
const key = spaceMountKey(reference), root = createClientUiRoot(document.getElementById('root')!)
useAppStore.getState().editSpaceMountDraft(key, member.tabId, member.regionId, 'Investigate the original Sample Project task. Keep this private draft unsent.')
flushSync(() => root.render(<MountedSpaceWorkbench mountKey={key} visible />))
Object.assign(window, { mountedCreation: { failObservation() { failure = true }, scenario(next: string) { variant = next; failure = false }, theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }), facts: () => ({ effectCount, draft: document.querySelector<HTMLTextAreaElement>('textarea')?.value }) } })
