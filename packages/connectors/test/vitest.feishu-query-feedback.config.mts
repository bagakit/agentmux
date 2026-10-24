import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.feishu-reply.config.mts'

const root = resolve(import.meta.dirname, '../../..'), marker = process.env.QUERY_FEEDBACK_LEAF_LOADED, mutant = process.env.QUERY_FEEDBACK_LEAF_MUTANT
if (mutant && mutant !== 'foreign-app') throw Error('Unknown query feedback leaf mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/feishu-query-feedback'),
  plugins: [...original.plugins ?? [], { name: 'original-query-reaction-consumer', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(core|connectors)\/src\/.+\.[cm]?[jt]s$/u.test(path)) return
    let output = input
    if (mutant && path === 'packages/connectors/src/adapters/feishu/reaction.ts') {
      const before = 'operator.operator_id !== application.appId'
      if (input.split(before).length !== 2) throw Error('Original reaction application comparison changed')
      output = input.replace(before, 'false')
    }
    if (!marker) return output === input ? undefined : { code: output, map: null }
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, originalSHA256: sha256(input), loadedSHA256: sha256(output), mutation: input === output ? null : mutant })
    return { code: "import { appendFileSync as __queryFeedbackLoaded } from 'node:fs'; __queryFeedbackLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + output, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/feishu-query-feedback.test.ts'] } })
