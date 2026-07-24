import process from 'node:process'
import { randomUUID } from 'node:crypto'

const MAX_HOOK_INPUT_BYTES = 128 * 1024

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.byteLength
    if (bytes > MAX_HOOK_INPUT_BYTES) throw new Error('Codex hook input exceeds the AgentMux limit.')
    chunks.push(chunk)
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  const eventName = payload.hook_event_name
  const url = process.env.AGENTMUX_HOOK_URL
  const token = process.env.AGENTMUX_HOOK_TOKEN
  if (typeof eventName !== 'string' || !url || !token) {
    throw new Error('AgentMux hook binding environment is incomplete.')
  }
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
  if (!response?.ok) throw lastError
  process.stdout.write('{}\n')
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
