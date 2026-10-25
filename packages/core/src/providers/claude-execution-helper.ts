import { fileURLToPath } from 'node:url'
import type { AgentExecutionHelperContext, AgentExecutionHelperLaunchPlan } from '../agent-execution-helper.js'
import { qualifyClaudeExecutionExecutable } from './claude-tool-execution-launch.js'

export async function prepareClaudeExecutionHelper(context: AgentExecutionHelperContext): Promise<AgentExecutionHelperLaunchPlan> {
  const executable = await qualifyClaudeExecutionExecutable(context.executable, { env: process.env, workspacePath: context.workspacePath })
  return { command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./claude-execution-run.js', import.meta.url)), '--agentmux-execution-helper', JSON.stringify({ ...context, executable })],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    ...(context.role === 'frontend' ? { notices: [{ providerId: 'claude', role: 'frontend' as const, capability: 'hooks' as const, state: 'unverified' as const,
      code: 'CLAUDE_RESOURCE_TOOL_CONTEXT_LIMITED', message: 'Remote tools run through native MCP hooks. Original tool-name hooks and child write permissions are not equivalent; child operations require a native read-only classification and an existing allow.',
      action: 'Keep working with the main Agent; inspect the exact child operation or tool Hook configuration when needed.' }] }
    : { notices: [{ providerId: 'claude', role: 'executor' as const, capability: 'agent-control' as const, state: 'unconfigured' as const,
      code: 'AGENT_TOOL_CONTEXT_UNAVAILABLE', message: 'Tool-side Agent control has not yet confirmed its original Agent route. Resource tools remain available.',
      action: 'Inspect the original binding route without replacing its Agent or helper Runs.' }] }),
  }
}
