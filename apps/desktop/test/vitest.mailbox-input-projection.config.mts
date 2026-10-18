import base from './vitest.input-mailbox-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const owners = new Set([
  'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'apps/desktop/src/renderer/src/lib/mailbox-input-projection.ts',
  'packages/client-ui/src/components/InputMailboxRecords.tsx',
  'packages/client-ui/src/components/InputHistoryList.tsx'
])
export default defineConfig({ ...base, cacheDir: '.cache/mailbox-input-projection', plugins: [{
  name: 'original-mailbox-input-projection', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    const path = relative(root, file)
    if (path.startsWith('..') || path.includes('node_modules/') || !/\.[cm]?[jt]sx?$/.test(path)) return
    const mutation = process.env.AGENTMUX_MAILBOX_INPUT_MUTANT
      ? JSON.parse(process.env.AGENTMUX_MAILBOX_INPUT_MUTANT) as { file: string; before: string; after: string } : undefined
    let code = source
    if (owners.has(path) && mutation?.file === path) {
      if (source.split(mutation.before).length !== 2) throw new Error('Expected one original projection mutation site')
      code = source.replace(mutation.before, mutation.after)
    }
    const proof = process.env.AGENTMUX_MAILBOX_INPUT_PROOF
    if (proof) appendFileSync(proof, JSON.stringify({ path, fileSHA256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      sha256: createHash('sha256').update(code).digest('hex'),
      originalSha256: createHash('sha256').update(source).digest('hex'), mutated: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}, ...base.plugins!], test: { ...base.test,
  include: ['apps/desktop/test/mailbox-input-projection.test.ts', 'apps/desktop/test/mailbox-input-projection-consumer.test.tsx'] } })
