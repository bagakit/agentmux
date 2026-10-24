import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import owning from '../note-restore/vitest.owning.config.mts'

export default { ...owning,
  plugins: [{ name: 'actual-survey-install-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!/^(apps\/desktop\/(src|scripts)|packages\/core\/src)\//.test(file)) return null
    const mutant = process.env.SURVEY_INSTALL_MUTANT ? JSON.parse(process.env.SURVEY_INSTALL_MUTANT) : null
    let code = source
    if (mutant?.file === file) {
      if (source.split(mutant.before).length !== 2) throw new Error('One exact production mutation anchor is required')
      code = source.replace(mutant.before, mutant.after)
    }
    if (process.env.SURVEY_INSTALL_LOADED) appendFileSync(process.env.SURVEY_INSTALL_LOADED,
      JSON.stringify({ file, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? null : { code, map: null }
  } }, ...(owning.plugins ?? [])],
  test: { ...owning.test, include: ['apps/desktop/test/package-install-workbench-continuity.test.ts',
    'apps/desktop/test/survey-install-observation.test.ts', 'apps/desktop/test/package-ui-observation-rpc.test.ts'], hookTimeout: 30_000, testTimeout: 20_000 }
}
