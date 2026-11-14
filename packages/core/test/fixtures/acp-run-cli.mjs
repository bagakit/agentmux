#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout } from 'node:timers/promises'

if (process.argv.length !== 3 || process.argv[2] !== 'acp' || !process.env.ACP_RUN_TRACE || !process.env.ACP_RUN_RELEASE) process.exit(2)
if (process.env.AGENTMUX_ACP_ACTOR_TOKEN || process.env.AGENTMUX_HOOK_TOKEN) process.exit(3)
const sessionId = process.env.ACP_RUN_NATIVE_HISTORY_ID ?? 'fixture-original-acp-session'
const options = [
  { optionId: 'native-allow-exact', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'native-deny-exact', name: 'Reject once', kind: 'reject_once' }
]
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const update = update => send({ method: 'session/update', params: { sessionId, update } })
const permission = (id, toolCallId) => send({ id, method: 'session/request_permission',
  params: { sessionId, toolCall: { toolCallId, title: 'Original tool permission' }, options } })

const configuration = [
  { id: 'native-mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'native-ask',
    options: [{ value: 'native-ask', name: 'Ask' }, { value: 'native-plan', name: 'Plan' }] },
  { id: 'native-model', name: 'Model', type: 'select', category: 'model', currentValue: 'native-small',
    options: [{ group: 'available', name: 'Available models', options: [
      { value: 'native-small', name: 'Small' }, { value: 'native-large', name: 'Large' }
    ] }] },
  { id: 'native-verbose', name: 'Verbose', type: 'boolean', currentValue: false }
]

let pendingPrompt, cancelNotified = false
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line)
  appendFileSync(process.env.ACP_RUN_TRACE, JSON.stringify({ pid: process.pid, id, method: method ?? 'client-response', params, result }) + '\n')
  const reply = result => send({ id, result })
  if (method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} },
    ...(process.env.ACP_RUN_IMAGES === 'enabled' ? { promptCapabilities: { image: true } } : {}) } })
  else if (method === 'session/new') {
    while (!existsSync(process.env.ACP_RUN_RELEASE)) await setTimeout(20)
    reply({ sessionId, configOptions: configuration })
  } else if (method === 'session/resume' && params.sessionId === sessionId && process.env.ACP_RUN_RESUME_RELEASE) {
    while (!existsSync(process.env.ACP_RUN_RESUME_RELEASE)) await setTimeout(20)
    reply(readFileSync(process.env.ACP_RUN_RESUME_RELEASE, 'utf8') === 'mismatch' ? { sessionId: 'fixture-foreign-acp-session' } : {})
  } else if (method === 'session/set_config_option' && params.sessionId === sessionId && typeof id === 'string') {
    if (params.configId === 'native-model' && params.value === 'native-large') {
      configuration[1].currentValue = params.value
      configuration[0].currentValue = 'native-plan'
      while (!existsSync(process.env.ACP_RUN_CONFIGURATION_RELEASE)) await setTimeout(20)
    } else if (params.configId === 'native-verbose' && params.type === 'boolean' && params.value === true) {
      configuration[2].currentValue = true
    } else process.exit(5)
    reply({ configOptions: configuration })
  } else if (method === 'session/prompt' && params.sessionId === sessionId && typeof id === 'string' && !pendingPrompt) {
    const draft = params.prompt?.[0]?.text
    if (draft?.endsWith('Original creation draft') || draft?.endsWith('Original resumed draft') || draft?.startsWith('Read the original ')) {
      if (process.env.ACP_RUN_NATIVE_HISTORY_ID) {
        const directory = join(homedir(), '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs')
        mkdirSync(directory, { recursive: true })
        const lines = [
          { source: 'USER_EXPLICIT', type: 'USER_INPUT', step_index: 0, content: '<USER_REQUEST>' + draft + '</USER_REQUEST>' },
          { source: 'MODEL', type: 'PLANNER_RESPONSE', step_index: 1, content: 'Original native history reply' }
        ].map(row => JSON.stringify(row)).join('\n') + '\n'
        for (const name of ['transcript.jsonl', 'transcript_full.jsonl']) appendFileSync(join(directory, name), lines)
      }
      reply({ stopReason: 'end_turn' })
    } else {
      pendingPrompt = id
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'original-msg', content: { type: 'text', text: 'ACP fixture ' } })
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'original-msg', content: { type: 'text', text: 'assistant content' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'original-tool-call', title: 'Original tool activity', status: 'pending' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'original-tool-call', status: 'completed' })
      send({ method: 'session/update', params: { sessionId: 'foreign-session', update: { sessionUpdate: 'agent_message_chunk',
        messageId: 'foreign-msg', content: { type: 'text', text: 'Foreign message' } } } })
      permission(41, 'original-tool-call')
    }
  } else if (method === 'session/cancel' && params.sessionId === sessionId && id === undefined && pendingPrompt) {
    cancelNotified = true
  } else if (method === undefined && pendingPrompt) {
    if (id === 41 && result?.outcome?.outcome === 'selected' && result.outcome.optionId === 'native-deny-exact') permission('41', 'second-tool-call')
    else if (id === '41' && result?.outcome?.outcome === 'cancelled' && cancelNotified) {
      while (!existsSync(process.env.ACP_RUN_CANCEL_RELEASE)) await setTimeout(20)
      send({ id: pendingPrompt, result: { stopReason: 'cancelled' } })
      pendingPrompt = undefined
      cancelNotified = false
    } else process.exit(4)
  } else process.exit(2)
}
