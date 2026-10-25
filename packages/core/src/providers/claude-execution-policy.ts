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

export function register(on) {
  for (const name of nativeTools) {
    const tool = alias(name)
    on('tool.call', { tool: name }, async ($, event, next) => {
      if (name === 'TaskStop' && !(typeof (event.task_id ?? event.shell_id) === 'string' && (event.task_id ?? event.shell_id).startsWith(resourceTaskPrefix))) return next(event)
      const key = callKey(event)
      if (typeof event.tool_use_id !== 'string' || originals.has(key)) return { deny: 'The original native call identity is unavailable.' }
      let capture
      const replacement = new Promise(resolve => { capture = resolve })
      const original = { tool: name, agentId: event.agentId, capture }
      originals.set(key, original)
      try {
        // Reach this exact actor's native PreToolUse and permission check. Keep
        // its local effect suspended until this wrapper returns: native next's
        // documented pending-call cancellation prevents any local replacement.
        return await Promise.race([replacement, next(event)])
      } finally { originals.delete(key) }
    }).catch(() => ({ deny: unavailable }))

    on('tool.check', { tool: name }, async ($, event, next) => {
      const original = originals.get(callKey(event))
      if (!original || original.tool !== name || original.agentId !== event.agentId) return next(event)
      const verdict = await next(event)
      if (verdict.decision === 'deny') return verdict
      original.checked = { verdict, input: event.input }
      try {
        // A native $ call pauses this hook's budget while the resource runs or
        // the person answers. A bare parked promise would time out after 10s.
        const remote = await $.tool.call({ ...event.input, tool, [correlation]: callKey(event) })
        original.capture(nativeResult(remote))
      } catch { original.capture({ deny: unavailable }) }
      // Let the outer result cancel this pending local continuation. Returning
      // any verdict here creates either a false denial or a second local effect.
      return new Promise((resolve, reject) => {
        const cancel = () => reject(next.signal.reason)
        if (next.signal.aborted) cancel()
        else next.signal.addEventListener('abort', cancel, { once: true })
      })
    }).catch(($, event, next) => {
      if (next.signal.aborted) throw next.signal.reason
      return { decision: 'deny', reason: 'The original native tool permission could not be evaluated.' }
    })

    // Only this plugin can correlate a nested transport with the exact original
    // native actor and call. The private key never reaches MCP or native hooks.
    on('tool.call', { tool }, async ($, event, next) => {
      const { [correlation]: id, ...forward } = event
      const original = originals.get(id)
      if (next.origin.plugin !== plugin || original?.tool !== name || !original.checked || typeof event.tool_use_id !== 'string')
        return { deny: 'Use the original native tool for this resource operation.' }
      const key = callKey(event)
      transports.set(key, original.checked)
      try { return await next(forward) }
      finally { transports.delete(key) }
    })
      .catch(() => ({ deny: unavailable }))
    on('tool.check', { tool }, async ($, event, next) => {
      const checked = transports.get(callKey(event))
      if (!checked || !sameInput(checked.input, event.input)) return { decision: 'deny', reason: 'The resource call no longer matches its original native permission check.' }
      const transport = await next(event)
      if (transport.decision === 'deny') return transport
      const original = checked.verdict
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
