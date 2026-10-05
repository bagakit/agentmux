import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'restore-reason-refusal': ['packages/core/src/public-rpc-service.ts',
    "if (queued.delivery.state === 'delivered') return queued",
    "if (queued.delivery.state === 'delivered') return queued; if (queued.delivery.reason) throw new AgentMuxError('Blocked by diagnostic text.', 'AGENT_PROMPT_UNCONFIRMED')"],
  'forget-frozen-byte': ['packages/core/src/prompt-submission.ts',
    'expectedByte: admitted?.startByte ?? expectedByte,', 'expectedByte,'],
  'replay-whole-refusal': ['packages/core/src/prompt-submission.ts',
    'previous.submissionId === submissionId && agentPromptNotApplied(current)?.submissionId === submissionId',
    'false && previous.submissionId === submissionId && agentPromptNotApplied(current)?.submissionId === submissionId']
}

export default defineConfig({ root, plugins: [{ name: 'loaded-public-send-retry-proof', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!path.startsWith('packages/core/src/')) return
  const mutation = process.env.AMX_PUBLIC_SEND_MUTATION
  const change = mutation && mutations[mutation]
  if (mutation && !change) throw new Error('Unknown public-send mutation')
  let code = source
  if (change && path === change[0]) {
    if (source.split(change[1]).length - 1 !== 1) throw new Error('Public-send mutation anchor is not unique')
    code = source.replace(change[1], change[2])
  }
  if (process.env.AMX_PUBLIC_SEND_LOADED) appendFileSync(process.env.AMX_PUBLIC_SEND_LOADED, JSON.stringify({ path,
    sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'),
    ...(code !== source ? { mutation } : {}) }) + '\n')
  if (code !== source) return { code, map: null }
} }], test: { include: ['packages/core/test/agentmux-cli-prompt-error-receipt.test.ts',
  'packages/core/test/prompt-submission-diagnostics.test.ts'], passWithNoTests: false,
  maxWorkers: 1, fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 } })
