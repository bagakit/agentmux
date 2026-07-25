const AGENTMUX_RUNTIME_GUIDE = `AgentMux runtime guide:
You are running inside AgentMux. For requests involving tabs, splits, directions, or other agents, run "$AGENTMUX_CLI" --skill before acting.`

const EMPTY_USER_REQUEST = 'No request yet. Wait for the user.'

export function composeAgentLaunchPrompt(
  prompt: string | undefined,
  injectAgentMuxGuide: boolean
): string {
  if (!injectAgentMuxGuide) return prompt ?? ''
  const userRequest = prompt?.trim() ? prompt : EMPTY_USER_REQUEST
  return `${AGENTMUX_RUNTIME_GUIDE}\n\nUser request:\n${userRequest}`
}
