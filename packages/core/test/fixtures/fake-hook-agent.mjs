const prompt = process.argv.at(-1) ?? ''
const hookUrl = process.env.AGENTMUX_HOOK_URL
const hookToken = process.env.AGENTMUX_HOOK_TOKEN
const agentSessionId = process.env.AGENTMUX_AGENT_SESSION_ID
const runId = process.env.AGENTMUX_RUN_ID
const incarnationId = process.env.AGENTMUX_RUN_INCARNATION_ID
const agentId = process.env.AGENTMUX_AGENT_ID

if (!hookUrl || !hookToken || !agentSessionId || !runId || !incarnationId || !agentId) {
  throw new Error('missing AgentMux hook environment')
}

const request = async (body) => await fetch(hookUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${hookToken}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify(body)
})

await request({
  agentSessionId,
  runId,
  incarnationId: 'forged-incarnation',
  agentId,
  eventName: 'PermissionRequest',
  payload: { session_id: 'forged-native-session' }
})

const response = await request({
  agentSessionId,
  runId,
  incarnationId,
  agentId,
  eventName: 'SessionStart',
  payload: {
    session_id: `native-${agentSessionId}`,
    prompt
  }
})

if (!response.ok) throw new Error(`hook rejected: ${response.status}`)
process.stdout.write(`hook-agent-ready:${prompt}\n`)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  process.stdout.write(`hook-agent-input:${data}`)
})
