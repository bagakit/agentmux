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

async function main(): Promise<void> {
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

  if (eventName === 'PreToolUse') {
    process.stdout.write('{"decision":"ask"}\n')
  } else if (eventName === 'Stop') {
    process.stdout.write('{"decision":""}\n')
  } else {
    process.stdout.write('{}\n')
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
