import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_PROMPT_CARRIER_MUTATION
if (mutation && !['restore-universal-limit', 'skip-preclaim-record-qualification'].includes(mutation)) throw new Error('Unknown prompt carrier mutation')
export default defineConfig({ root,
  cacheDir: resolve(root, '.local/channel-current-session-regression/prompt-budget/carrier-cache', mutation ?? 'candidate'),
  plugins: [{ name: 'prompt-carrier-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const original = code
    if (mutation === 'restore-universal-limit' && path === 'packages/core/src/client.ts') {
      const anchor = 'const outbound = retainWire ? frozen.prompt : waitingSource?.promptWire ?? composed.text'
      if (code.split(anchor).length !== 2) throw new Error('Prompt carrier mutation needs one actual input anchor')
      code = code.replace(anchor, anchor + '\n    if (Buffer.byteLength(outbound) > 64 * 1024) throw new AgentMuxError("Restored universal input limit", "INVALID_AGENT_PROMPT")')
    }
    if (mutation === 'skip-preclaim-record-qualification' && path === 'packages/core/src/prompt-submission.ts') {
      const anchor = '=> normalizePromptInputIntent({'
      if (code.split(anchor).length !== 2) throw new Error('Record qualification mutation needs one actual claim anchor')
      code = code.replace(anchor, '=> ((value: unknown) => value as ReturnType<typeof normalizePromptInputIntent>)({')
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_PROMPT_CARRIER_LOADED) appendFileSync(process.env.AGENTMUX_PROMPT_CARRIER_LOADED,
      JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original === code ? {} : { mutation }) }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { environment: 'node', globalSetup: [], setupFiles: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/prompt-carrier-native.test.ts'], testTimeout: 90_000 }
})
