import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { durableWriteFile } from '../durable-write.js'
import { AgentMuxError } from '../errors.js'
import { CLAUDE_EXECUTION_TOOL_NAMES, CLAUDE_EXECUTION_SHELL_TASK_PREFIX } from './claude-execution-protocol.js'

/** Provider-owned native middleware. Native Claude still owns its tool pool and permission engine. */
export function claudeExecutionPolicySource(serverName: string, pluginName: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(serverName) || !/^[A-Za-z0-9_-]+$/u.test(pluginName))
    throw new AgentMuxError('An exact native execution server and plugin name are required.', 'INVALID_EXECUTION_BINDING')
  return `// AgentMux managed Claude execution routing. Generated for one original binding.
const nativeTools = ${JSON.stringify(CLAUDE_EXECUTION_TOOL_NAMES)}
const server = ${JSON.stringify(serverName)}
const plugin = ${JSON.stringify(pluginName)}
const resourceTaskPrefix = ${JSON.stringify(CLAUDE_EXECUTION_SHELL_TASK_PREFIX)}
const alias = name => 'mcp__' + server + '__' + name
const unavailable = 'The original resource tool connection is unavailable. No local replacement was executed.'
const correlation = '__agentmux_original_call_id'
const originals = new Map()
const transports = new Map()
const callKey = event => JSON.stringify([event.agentId ?? null, event.tool_use_id])
const childUnknown = 'This Claude interface cannot confirm this child operation in its original permission context. The main Agent can request it with its own native permission.'

function argumentsOf(event) {
  const { tool, tool_use_id, agentId, requestMeta, ...input } = event
  return input
}

function nativeResult(remote) {
  if (typeof remote.deny === 'string') return { deny: remote.deny }
  if (remote.isError === true) return { isError: true, result: remote.result, text: remote.text }
  // Native mcp serve returns its original typed tool record as one JSON text block.
  // Returning that record lets Claude validate and render the native result itself.
  if (!Array.isArray(remote.result) || remote.result.length !== 1 || remote.result[0]?.type !== 'text' || typeof remote.result[0].text !== 'string')
    throw new Error('The original native tool result is unconfirmed')
  return { result: JSON.parse(remote.result[0].text) }
}

function sameInput(left, right) {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameInput(left[key], right[key]))
}

function localTask(event) {
  return event.tool === 'TaskStop' && !(typeof (event.task_id ?? event.shell_id) === 'string' && (event.task_id ?? event.shell_id).startsWith(resourceTaskPrefix))
}

async function routeOriginal($, event, verdict) {
  const key = callKey(event)
  if (typeof event.tool_use_id !== 'string' || originals.has(key)) return { deny: 'The original native call identity is unavailable.' }
  const input = argumentsOf(event)
  originals.set(key, { tool: event.tool, input, child: event.agentId !== undefined, verdict })
  try { return nativeResult(await $.tool.call({ ...input, tool: alias(event.tool), [correlation]: key })) }
  finally { originals.delete(key) }
}

export function register(on) {
  // This entry must precede the combined hook and must not enter it for a
  // child call. Native queries skip every active ancestor registration.
  on('tool.call', { tool: nativeTools, agentId: /.+/ }, ($, event, next) => localTask(event)
    ? next(event) : routeOriginal($, event)).catch(() => ({ deny: unavailable }))

  on('tool.*', async ($, event, next) => {
    const name = event.tool
    if (!nativeTools.includes(name)) return next(event)
    if (next.event === 'tool.check') {
      const verdict = await next(event)
      // A query from the alias hook has no child actor. Keep only the native
      // tool's confirmed read-only input and an existing allow. The main
      // wrapper's own query skips this same registration by native contract.
      if (next.origin.plugin !== plugin || event.tool_use_id !== undefined) return verdict
      if (verdict.decision === 'deny') return verdict
      return event.isReadOnly === true && verdict.decision === 'allow' ? verdict : { decision: 'deny', reason: childUnknown }
    }
    if (next.event !== 'tool.call') return next(event)
    if (localTask(event)) return next(event)
    if (event.agentId !== undefined) return { deny: childUnknown }
    // Native query is permission-only. Running the original tool's next()
    // would validate resource files against the Agent Host's local read state.
    const verdict = await $.tool.check({ tool: name, input: argumentsOf(event) })
    if (verdict?.decision === 'deny') return { deny: verdict.reason ?? 'The original native tool permission refused this call.' }
    return routeOriginal($, event, verdict)
  }).catch(($, event, next) => {
    if (next.event === 'tool.check') return { decision: 'deny', reason: 'The original native tool permission could not be evaluated.' }
    return next.event === 'tool.call' ? { deny: unavailable } : next(event)
  })

  for (const name of nativeTools) {
    const tool = alias(name)
    // Only this plugin can correlate a nested transport with the exact original
    // native actor and call. The private key never reaches MCP or native hooks.
    on('tool.call', { tool }, async ($, event, next) => {
      const { [correlation]: id, ...forward } = event
      const original = originals.get(id)
      if (next.origin.plugin !== plugin || original?.tool !== name || typeof event.tool_use_id !== 'string')
        return { deny: 'Use the original native tool for this resource operation.' }
      const key = callKey(event)
      transports.set(key, original)
      try { return await next(forward) }
      finally { transports.delete(key) }
    })
      .catch(() => ({ deny: unavailable }))
    on('tool.check', { tool }, async ($, event, next) => {
      const checked = transports.get(callKey(event))
      if (!checked || !sameInput(checked.input, event.input)) return { decision: 'deny', reason: 'The resource call no longer matches its original native permission check.' }
      const transport = await next(event)
      if (transport.decision === 'deny') return transport
      const original = checked.child ? await $.tool.check({ tool: name, input: event.input }) : checked.verdict
      if (original.decision === 'deny') return original
      return transport.decision === 'ask' ? transport : original
    }).catch(() => ({ decision: 'deny', reason: 'The original native tool permission could not be evaluated.' }))
  }
}
`
}

/** Immutable generated inputs keep an active original Run's loaded plugin intact. */
export async function prepareClaudeExecutionPolicy(input: { workspacePath: string; bindingId: string; serverName: string }): Promise<string> {
  if (!isAbsolute(input.workspacePath) || !input.bindingId || /[\0\r\n]/u.test(input.bindingId))
    throw new AgentMuxError('The original execution binding and absolute launch workspace are required.', 'INVALID_EXECUTION_BINDING')
  const identity = createHash('sha256').update(input.bindingId).digest('hex')
  const name = 'agentmux-execution-' + identity.slice(0, 16)
  const source = claudeExecutionPolicySource(input.serverName, name)
  const revision = createHash('sha256').update(source).digest('hex')
  const directory = join(input.workspacePath, '.claude', 'agentmux', 'tool-execution', identity, revision)
  const files = [
    ['.claude-plugin/plugin.json', JSON.stringify({ name, version: '1.0.0', description: 'Route original Claude tools to their bound resource Host.' }) + '\n'],
    ['hooks/hooks.json', JSON.stringify({ modules: ['./register.js'] }) + '\n'],
    ['hooks/register.js', source]
  ] as const
  for (const [relativePath, content] of files) {
    const path = join(directory, relativePath)
    const parent = dirname(path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const retained = await readFile(path, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined })
    if (retained === content) continue
    if (retained !== undefined) throw new AgentMuxError('The generated execution plugin no longer matches its original content. The original Run remains retained.', 'EXECUTION_BINDING_CONFLICT')
    await durableWriteFile(path, content, { mode: 0o600 })
  }
  return directory
}
