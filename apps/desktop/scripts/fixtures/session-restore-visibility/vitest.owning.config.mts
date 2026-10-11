import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../conversation-latest-auto/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...base,
 cacheDir: resolve(root, '.cache/session-restore-visibility'),
 plugins: [...(base.plugins ?? []), { name: 'restore-visibility-source-boundaries', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]!
  if (!file.startsWith(root + '/apps/desktop/src/') && !file.startsWith(root + '/packages/')) return
  let code = source
  const mutation = process.env.AGENTMUX_RESTORE_VISIBILITY_MUTATION
  const changes: Record<string, [string, string, string]> = {
   'ignore-core-starting': ['lib/continuity-presentation.ts', "if (decision?.kind === 'starting')", 'if (false)'],
   'ignore-run-binding': ['lib/continuity-presentation.ts', '(operation.newRun ?? operation.previousRun).runId === session.control.run.runId', 'true'],
   'hide-history-title': ['components/SessionPane.tsx', '<strong>{restorePresentation.title}</strong>', '{null}']
  }
  const change = mutation ? changes[mutation] : undefined
  if (mutation && !change) throw Error('Unknown restore visibility mutation: ' + mutation)
  if (change && file.endsWith('/' + change[0])) {
   if (source.split(change[1]).length !== 2) throw Error('Mutation must match one actual source boundary: ' + mutation)
   code = source.replace(change[1], change[2])
  }
  const log = process.env.AGENTMUX_RESTORE_VISIBILITY_LOADED
  if (log) appendFileSync(log, JSON.stringify({ path: relative(root,file), originalSHA256:createHash('sha256').update(source).digest('hex'), sha256:createHash('sha256').update(code).digest('hex'), ...(code !== source ? {mutation} : {}) })+'\n')
  return code === source ? undefined : {code,map:null}
 }}],
 test: {...base.test,include:['apps/desktop/test/session-pane-restore-visibility.test.tsx'],passWithNoTests:false}
})
