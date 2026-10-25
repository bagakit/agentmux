import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import owning from '../note-restore/vitest.owning.config.mts'

export default {
  ...owning,
  plugins: [...owning.plugins!, {
    name: 'survey-window-original-source', enforce: 'pre' as const,
    transform(source: string, id: string) {
      const file = relative(owning.root!, id.split('?')[0]!)
      const mutation = process.env.SURVEY_NAV_MUTANT ? JSON.parse(process.env.SURVEY_NAV_MUTANT) : null
      let code = source
      if (mutation?.file === file) {
        if (source.split(mutation.before).length !== 2) throw new Error('Mutation anchor must be unique: ' + file)
        code = source.replace(mutation.before, mutation.after)
      }
      if (process.env.SURVEY_NAV_LOADED && /^apps\/desktop\/src\//.test(file)) appendFileSync(process.env.SURVEY_NAV_LOADED,
        JSON.stringify({ file, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
      return code === source ? null : { code, map: null }
    }
  }],
  test: { ...owning.test, environment: 'happy-dom',
    testTimeout: 30_000, hookTimeout: 30_000,
    include: ['apps/desktop/test/survey-surface.test.tsx', 'apps/desktop/test/workbench-windows.test.ts'],
    testNamePattern: /\[survey-native-child\]|shows new and existing background shells|restores durable shells/ }
}
