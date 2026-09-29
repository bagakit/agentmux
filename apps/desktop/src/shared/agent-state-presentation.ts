import type { AgentDisplayState } from '@agentmux/core'

/** Words for existing Core facts. This table never decides activity or input readiness. */
const descriptions: Record<AgentDisplayState, { label: string; description: string }> = {
  starting: { label: 'Starting', description: 'The Agent is starting. This does not confirm that its input is ready.' },
  running: { label: 'Status unknown', description: 'The process is running, but its current activity is unknown. This does not mean working, idle, or input ready.' },
  disconnected: { label: 'Disconnected', description: 'The runtime connection is unavailable. The Agent may still be running; its current state is unconfirmed.' },
  working: { label: 'Working', description: 'The Agent has reported that it is working on a turn. This is an activity statement, separate from input readiness.' },
  waiting: { label: 'Waiting', description: 'The Agent has reported waiting. A specific permission or question is shown separately.' },
  blocked: { label: 'Blocked', description: 'The Agent has reported a blocker. This label does not identify a specific request or a stopped process.' },
  done: { label: 'Turn ended', description: 'The current turn has ended. This does not mean the process exited, the goal is complete, or every action succeeded.' },
  exited: { label: 'Stopped', description: 'The process has ended. Its Session and history can remain available for restoration.' },
  error: { label: 'Error reported', description: 'An error was reported. Its source and details explain what failed; the process may still be running.' }
}

export function describeAgentDisplayState(state: AgentDisplayState) {
  return descriptions[state]
}
