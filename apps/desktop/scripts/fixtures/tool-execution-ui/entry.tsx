import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { replaceWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import type { AgentExecutionInspection } from '@agentmux/core'
mountThemeRuntime(window, { appAppearance: 'dark' })
api.executors.discover = async hostId => ({ routeHostId: hostId, runtimeId: `fixture-runtime-${hostId}`, executors: [
  { executorId: 'codex', providerId: 'codex', label: 'Codex · research', command: 'codex', source: 'registered', configRevision: `fixture-revision-${hostId}`, availability: 'available' },
  { executorId: 'claude-code', providerId: 'claude-code', label: 'Claude Code', command: 'claude', source: 'registered', configRevision: `fixture-revision-${hostId}`, availability: 'available' }
] })
await import('../launcher-launchpad/entry')
const fixture = (window as any).launchpad
const host = { id: 'agent-server', kind: 'ssh' as const, label: 'Research server · Singapore', hostname: 'fixture.invalid' }
const workspace = { id: 'agent-home', hostId: host.id, name: 'Agent runtime', path: '/srv/agents/research', kind: 'folder' as const }
const initial = useAppStore.getState()
useAppStore.setState({ config: { ...initial.config!, hosts: [...initial.config!.hosts.filter(item => item.id !== host.id), host], workspaces: [...initial.config!.workspaces.filter(item => item.id !== workspace.id), workspace] } })
const target = { tabId: fixture.tabId, regionId: fixture.regionId }
const original = useAppStore.getState().tabs[target.tabId]!
const agent = useAppStore.getState().sessions.find(item => item.kind === 'agent')!
const fact: AgentExecutionInspection = { bindingId: 'fixture-binding', agentHostId: agent.hostId, agentSessionId: agent.id, resourceHostId: host.id, resourceWorkspacePath: workspace.path, state: 'connected', notices: [
  { providerId: 'codex', role: 'frontend', capability: 'hooks', state: 'unqualified', code: 'HOOKS_UNQUALIFIED', message: 'Native remote Hooks are not qualified for this execution binding.', action: 'Use the original Agent terminal and status until native Hooks are qualified.' },
  { providerId: 'codex', role: 'frontend', capability: 'skills', state: 'unverified', code: 'SKILLS_UNVERIFIED', message: 'Skill loading has not been verified on the Agent runtime.', action: 'Inspect the original runtime skill discovery before relying on it.' },
  { providerId: 'codex', role: 'executor', capability: 'mcp', state: 'unsupported', code: 'MCP_UNSUPPORTED', message: 'MCP calls are not supported by this execution helper.', action: 'Keep using the original runtime MCP configuration.' },
  { providerId: 'codex', role: 'executor', capability: 'agent-control', state: 'unconfigured', code: 'CONTROL_UNCONFIGURED', message: 'Tool-side Agent control is not configured.', action: 'Use the original Agent Host control endpoint until tool-side Agent control is configured.' }
] }
const readers = new Set<(value: AgentExecutionInspection | null) => void>()
api.sessions.executionBinding = async () => fact
api.sessions.observeExecutionBinding = (_id, listener) => { readers.add(listener); queueMicrotask(() => { if (readers.has(listener)) listener(fact) }); return () => { readers.delete(listener) } }
Object.assign(window, { toolExecutionUI: {
  target, workspace, theme: updateThemeSelection,
  facts: () => ({ surface: useAppStore.getState().tabs[target.tabId]!.regions[target.regionId], draft: useAppStore.getState().agentComposerDrafts[target.regionId], warm: Object.values(useAppStore.getState().warmTerminals).flat().map(item => item.session.id) }),
  async discoveryFailure() { api.executors.discover = async () => { throw new Error('Host observation is unavailable. Previously read configuration is retained.') }; await useAppStore.getState().detectExecutors(host.id, { source: 'host' }) },
  notice() { const session = { ...agent, toolExecution: { bindingId: fact.bindingId, resourceHostId: fact.resourceHostId, workspacePath: fact.resourceWorkspacePath } }; useAppStore.setState(state => ({ sessions: state.sessions.map(item => item.id === agent.id ? session : item), tabs: { ...state.tabs, [target.tabId]: replaceWorkbenchRegion(original, target.regionId, { kind: 'agent', phase: 'attached', regionId: target.regionId, sessionId: agent.id, workspaceId: fixture.workspaceId }) } })) },
  unknown() { for (const listener of readers) listener({ ...fact, state: 'unavailable', diagnostic: { code: 'CHANNEL_UNAVAILABLE', message: 'The observation channel is unavailable. The original Agent is still running.' } }) }
} })
