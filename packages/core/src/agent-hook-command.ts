import process from 'node:process'
import { randomUUID } from 'node:crypto'

const MAX_HOOK_INPUT_BYTES = 128 * 1024

function parseEventFromArgv(): string | null {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--event' && i + 1 < args.length) {
      return args[i + 1] ?? null
    }
  }
  return null
}

/**
 * Resolve which Agent Provider invoked this hook. The provider is baked into the managed hook
 * command string (AGENTMUX_HOOK_PROVIDER) so it survives PTY restarts and SSH, and disambiguates
 * `antigravity` (agy) from `gemini`, which share ~/.gemini. AGENTMUX_PROVIDER_ID (injected into the
 * agent launch env) is the fallback, and the presence of the Antigravity-only event var infers it.
 */
export function resolveHookProvider(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env.AGENTMUX_HOOK_PROVIDER ??
    env.AGENTMUX_PROVIDER_ID ??
    (env.AGENTMUX_ANTIGRAVITY_EVENT ? 'antigravity' : null)
  )
}

/**
 * The stdout a provider's hook protocol expects from a passive status observer.
 *
 * Only Antigravity gates tool calls on this hook and reads empty/absent stdout as a HARD DENY
 * (#2426), so it must receive an explicit decision — `ask` defers to the user's own permission
 * flow (never `allow`, which would auto-approve every observed tool call). Every other provider is
 * observed, not gated, so it must receive `{}`: a valid no-decision payload that satisfies Claude's
 * fail-closed-on-empty-stdout guard and Codex's strict "Stop requires JSON on stdout" rule, without
 * tripping Codex's "unsupported decision value" hook failure that an Antigravity-shaped
 * `{"decision":"ask"}` would cause. Emitting the Antigravity schema to any other provider is the
 * P0 bug this replaces.
 *
 * Claude's PermissionRequest hook CAN return a structured decision on stdout
 * (`{behavior:"allow",updatedPermissions}` / `{behavior:"deny"}`) — a real broader-scope grant with no
 * PTY keystroke. It is DEFERRED, not built: honoring it would require turning this fire-and-forget hook
 * into a blocking RPC that holds stdout open until the user clicks seconds later, a channel that does not
 * exist today. Claude therefore abstains with `{}`, its own numbered TUI prompt renders, and AgentMux
 * answers it by injecting the declared keystroke (see CLAUDE_PERMISSION_OPTIONS in agent-provider.ts) —
 * reusing the existing PTY transport with zero new protocol.
 */
export function hookResponseFor(provider: string | null, eventName: string | null): string {
  if (provider === 'antigravity') {
    if (eventName === 'PreToolUse') return '{"decision":"ask"}\n'
    if (eventName === 'Stop') return '{"decision":""}\n'
  }
  return '{}\n'
}

export async function runAgentHookCommand(): Promise<void> {
  const flagEvent = parseEventFromArgv()
  const envEvent =
    process.env.AGENTMUX_ANTIGRAVITY_EVENT ??
    process.env.AGENTMUX_HOOK_EVENT ??
    process.env.HOOK_EVENT_NAME ??
    null

  const chunks: Buffer[] = []
  let bytes = 0
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.byteLength
    if (bytes > MAX_HOOK_INPUT_BYTES) throw new Error('Agent hook input exceeds the AgentMux limit.')
    chunks.push(chunk)
  }

  const rawInput = Buffer.concat(chunks).toString('utf8').trim()
  let payload: Record<string, unknown> = {}
  if (rawInput.length > 0) {
    try {
      const parsed = JSON.parse(rawInput) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>
      } else {
        payload = { raw: parsed }
      }
    } catch {
      payload = { raw: rawInput }
    }
  }

  const stdinEvent =
    typeof payload.hook_event_name === 'string'
      ? payload.hook_event_name
      : typeof payload.eventName === 'string'
        ? payload.eventName
        : null

  const eventName = flagEvent ?? envEvent ?? stdinEvent

  // Answer the invoking CLI with the provider-correct decision BEFORE the status relay, so a gate
  // (Antigravity PreToolUse) never waits behind the network post's timeout.
  process.stdout.write(hookResponseFor(resolveHookProvider(), eventName))

  const url = process.env.AGENTMUX_HOOK_URL
  const token = process.env.AGENTMUX_HOOK_TOKEN

  if (url && token && eventName) {
    const receiptId = randomUUID()
    let response: Response | null = null
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ receiptId, eventName, payload }),
          signal: AbortSignal.timeout(2_000)
        })
        if (response.ok) break
        throw new Error(`AgentMux hook ingress rejected ${eventName}: ${response.status}`)
      } catch (error) {
        lastError = error
        response = null
      }
    }
    if (!response?.ok && lastError) {
      process.stderr.write(`[AgentMux Hook] ${lastError instanceof Error ? lastError.message : String(lastError)}\n`)
    }
  }
}
