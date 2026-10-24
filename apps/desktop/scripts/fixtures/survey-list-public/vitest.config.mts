import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import owning from '../note-restore/vitest.owning.config.mts'

/** Private transforms exercise original production modules without editing shared Source. */
export default { ...owning,
  plugins: [{ name: 'survey-list-qualification', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!/^(apps\/desktop\/src|packages\/core\/src)\//.test(file)) return null
    const mutant = process.env.SURVEY_LIST_MUTANT ? JSON.parse(process.env.SURVEY_LIST_MUTANT) : null
    let code = source
    if (mutant?.file === file) {
      if (source.split(mutant.before).length !== 2) throw new Error('Survey mutation requires one original production anchor')
      code = source.replace(mutant.before, mutant.after)
    }
    if (process.env.SURVEY_LIST_LOADED) appendFileSync(process.env.SURVEY_LIST_LOADED, JSON.stringify({ consumer: 'renderer-source', file,
      sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? null : { code, map: null }
  } }, ...(owning.plugins ?? [])],
  test: { ...owning.test, include: ['apps/desktop/test/survey-list-public.test.tsx'], hookTimeout: 30_000, testTimeout: 20_000 }
}
