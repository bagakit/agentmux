import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import original from './connection-owner-consumer.config.mts'

const variants = {
  'turn-correlation-lost': ['packages/connectors/src/publication-query-feedback.ts', "AND json_extract(operation_json,'$.queryTurn.turnId')=?", 'AND ? IS NOT NULL'],
  'default-dispatch-disconnected': ['packages/connectors/src/connection-services.ts', 'permissions: ingress.permissions, queryFeedback: true', 'permissions: ingress.permissions']
} as const
const mutant = process.env.QUERY_FEEDBACK_MUTANT as keyof typeof variants | undefined
if (mutant && !variants[mutant]) throw Error('Unknown query feedback mutation')
export default defineConfig({ ...original, plugins: [...original.plugins!, { name: 'query-feedback-source-receipt', enforce: 'pre',
  transform(source, id) {
    const path = relative(original.root!, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:core|connectors))\/(src|test)\/.+\.[cm]?[jt]s$/u.test(path)) return
    let code = source
    const selected = mutant && variants[mutant]
    if (selected && path === selected[0]) {
      if (source.split(selected[1]).length !== 2) throw Error('The exact query feedback owner must match once')
      code = source.replace(selected[1], selected[2])
    }
    if (process.env.QUERY_FEEDBACK_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const fact = { path, originalSHA256: sha(source), loadedSHA256: sha(code), ...(code === source ? {} : { mutant }) }
      code = "import {appendFileSync as __feedbackLoaded} from 'node:fs';__feedbackLoaded(" + JSON.stringify(process.env.QUERY_FEEDBACK_LOADED) + ', ' + JSON.stringify(JSON.stringify(fact) + '\n') + ');\n' + code
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...original.test, include: ['apps/host/test/query-feedback-consumer.test.ts'], ...(mutant ? { testNamePattern: 'default Host attaches cumulative feedback' } : {}), testTimeout: 45_000 } })
