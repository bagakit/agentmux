import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
import { candidateAlias, candidateModule } from '../../../apps/desktop/scripts/candidate-package-resolve.mjs'

const root = realpathSync(resolve(import.meta.dirname, '../../..'))
const mutation = process.env.AGENTMUX_FOLLOW_POLICY_MUTATION
const owner = 'packages/client-ui/src/lib/use-conversation-record-layout.ts'
const edits: Record<string, [string, string]> = {
  'ignore-following-render': ['Object.is(prior.intent, intent) && !geometry?.following()', 'Object.is(prior.intent, intent)'],
  'ignore-following-admission': ['options?.preserveAnchor !== false && !geometry?.following()', 'options?.preserveAnchor !== false']
}
if (mutation && !edits[mutation]) throw new Error('Unknown follow-policy mutation')
export default defineConfig({ ...base, root, cacheDir: resolve(root, '.cache/conversation-follow-policy-' + (mutation ?? 'base')),
  resolve: { ...base.resolve, alias: [candidateAlias(root, { browser: true, source: true }), ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] },
  plugins: [{ name: 'actual-follow-policy-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual), fileSHA256 = createHash('sha256').update(readFileSync(actual)).digest('hex')
    let code = source
    if (mutation && path === owner) {
      const [from, to] = edits[mutation]!
      if (source.split(from).length !== 2) throw new Error('One exact follow-policy mutation is required')
      code = source.replace(from, to)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_FOLLOW_POLICY_LOADED) appendFileSync(process.env.AGENTMUX_FOLLOW_POLICY_LOADED,
      JSON.stringify({ path, fileSHA256, originalSHA256: hash(source), loadedSHA256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['packages/client-ui/test/conversation-follow-policy.test.tsx'], passWithNoTests: false,
    fileParallelism: false, maxWorkers: 1 } })
