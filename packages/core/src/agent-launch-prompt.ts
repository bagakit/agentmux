const AGENTMUX_RUNTIME_GUIDE = `AgentMux runtime guide:
You are running inside AgentMux, where you can open a terminal, a browser, or another agent into a split beside your view — left, right, above, or below — and rearrange a tab's layout. When a request needs any of that, run "$AGENTMUX_CLI" --skill for the exact commands before acting.`

const EMPTY_USER_REQUEST = 'No request yet. Wait for the user.'

export function composeAgentLaunchPrompt(
  prompt: string | undefined,
  injectAgentMuxGuide: boolean
): string {
  if (!injectAgentMuxGuide) return prompt ?? ''
  const userRequest = prompt?.trim() ? prompt : EMPTY_USER_REQUEST
  return `${AGENTMUX_RUNTIME_GUIDE}\n\nUser request:\n${userRequest}`
}
