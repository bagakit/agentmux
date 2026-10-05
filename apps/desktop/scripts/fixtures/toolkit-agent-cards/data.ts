import type { ToolkitResultDocument, ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'

/** A plain user-authored script declaration; identity is supplied by its real original owner. */
export function toolkitAgentCardsCustomDocument(hostId: string, sessionId: string): ToolkitResultDocument {
  return { schema: 'agentmux.toolkit.result.v1', summary: 'Workspace review', items: [], links: [], notice: '',
    agentCards: { fields: ['avatar', 'name', 'status', 'provider', 'workspace', 'host', 'sessionId'], omittedItems: 0,
      items: [{ reference: { kind: 'session', hostId, sessionId }, metrics: [{ label: 'Reviewed tasks', value: '7' }, { label: 'Next step', value: 'Review changes' }] }] } }
}

export function toolkitAgentCardsCustomDefinition(workspacePath: string, document: ToolkitResultDocument): ToolkitToolDefinition {
  return { id: 'ordinary-agent-cards', revision: 'r1', name: 'Workspace review', icon: 'terminal', enabled: true,
    statusBar: 'label', workspacePath, script: `console.log(JSON.stringify(${JSON.stringify(document)}))`, args: [] }
}

/** Accept the captured execution verbatim; a scene may not manufacture script or Runtime success. */
export function toolkitAgentCardsCustomSnapshot(definition: ToolkitToolDefinition, execution: NonNullable<ToolkitScriptSnapshot['latestConfirmed']>): ToolkitScriptSnapshot {
  return { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: execution.state,
    reason: execution.reason, admission: null, latestConfirmed: execution, consumerCount: 1, sequence: 1 }
}
