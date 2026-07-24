#!/usr/bin/env node
const args = process.argv.slice(2)
const prompt = args[0] === 'resume' ? `resumed-${args[1] ?? ''}` : args.at(-1) ?? ''
const hookUrl = process.env.AGENTMUX_HOOK_URL
const hookToken = process.env.AGENTMUX_HOOK_TOKEN
const agentSessionId = process.env.AGENTMUX_AGENT_SESSION_ID
const agentId = process.env.AGENTMUX_AGENT_ID

if (!hookUrl || !hookToken || !agentSessionId || !agentId) {
  throw new Error('missing AgentMux hook environment')
}

const request = async (body) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${hookToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      })
      if (response.ok) return response
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('AgentMux hook ingress did not return')
}

await request({
  eventName: 'SessionStart',
  payload: { session_id: `native-${agentSessionId}`, prompt }
})
await request({
  eventName: 'PermissionRequest',
  payload: { session_id: `native-${agentSessionId}`, tool_name: 'request_user_input' }
})
process.stdout.write(`codex-ready:${prompt}\n`)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  process.stdout.write(`codex-input:${data}`)
  if (data.includes('exit\n')) process.exit(0)
})
process.on('SIGINT', () => {
  process.stdout.write('codex-interrupt\n')
})
