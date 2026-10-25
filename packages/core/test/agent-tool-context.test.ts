import { expect, it } from 'vitest'
import { assertAgentToolContextAvailable } from '../src/agent-tool-context.js'
it.each([{}, { AGENTMUX_AGENT_SESSION_ID: 'original-B' }, { AGENTMUX_AGENT_SESSION_ID: 'stale-A', AGENTMUX_AGENT_CAPABILITY: 'stale-cap' }])('refuses only the explicitly unconfigured Agent control context independent of inherited credentials %j', credentials => {
  expect(() => assertAgentToolContextAvailable({ ...credentials, AGENTMUX_TOOL_CONTEXT: 'unconfigured' })).toThrow(expect.objectContaining({ code: 'AGENT_TOOL_CONTEXT_UNAVAILABLE' }))
})
it('does not require the tool-only context marker in ordinary local or managed launch environments', () => {
  expect(() => assertAgentToolContextAvailable({})).not.toThrow()
  expect(() => assertAgentToolContextAvailable({ AGENTMUX_AGENT_SESSION_ID: 'local-agent', AGENTMUX_AGENT_CAPABILITY: 'local-cap' })).not.toThrow()
})
