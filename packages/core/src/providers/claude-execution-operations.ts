import type { AgentExecutionProtocol } from '../agent-execution-protocol.js'
import { createClaudeExecutionShell, type ClaudeExecutionBashInput } from './claude-execution-shell.js'

/** One original resource helper's shell owner, shared across its MCP connections. */
export function createClaudeExecutionOperations(options: { workspacePath: string; outputDirectory: string; agentSessionId?: string | undefined }): Pick<AgentExecutionProtocol, 'execute' | 'dispose'> {
  const shell = createClaudeExecutionShell({ workspacePath: options.workspacePath, outputDirectory: options.outputDirectory,
    env: { AGENTMUX_TOOL_CONTEXT: 'unconfigured', AGENTMUX_AGENT_SESSION_ID: options.agentSessionId, AGENTMUX_AGENT_CAPABILITY: undefined } })
  return {
    async execute(request, _generation, environment) {
      if (request.method !== 'tools/call' || !['Bash', 'TaskStop'].includes(String(request.params?.name))) return undefined
      const args = request.params!.arguments as Record<string, unknown>
      try {
        let result, isError = false
        if (request.params!.name === 'Bash') {
          const { exitCode, ...record } = await shell.run(args as unknown as ClaudeExecutionBashInput, environment)
          result = record; isError = exitCode !== undefined && exitCode !== 0 || record.interrupted
        } else result = await shell.stop(args)
        return { jsonrpc: '2.0', id: request.requestId, result: { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(result) }] } }
      } catch (error) {
        return { jsonrpc: '2.0', id: request.requestId, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } }
      }
    },
    dispose: () => shell.close(),
  }
}
