import { defineConfig } from 'vitest/config'
import base from './vitest.composer-tools-first-presentation.config.mts'
import { relative, resolve } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..')
const inverse = process.env.QUESTION_OWNER_INVERSE ? JSON.parse(readFileSync(process.env.QUESTION_OWNER_INVERSE, 'utf8')) : undefined

export default defineConfig({
  ...base,
  resolve: { ...base.resolve, alias: [
    { find: /^@agentmux\/browser\/(.*)$/, replacement: resolve(import.meta.dirname, '../../../packages/browser/src/$1.ts') },
    ...Array.isArray(base.resolve?.alias) ? base.resolve.alias : []
  ] },
  plugins: [{ name: 'question-owner-original-persistence-consumer', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if ((!file.startsWith('apps/') && !file.startsWith('packages/')) || file.includes('/node_modules/')) return
    // Same native-persistence branches as the maintained workbench-user-storage fixture;
    // only the native API ports are controlled, without an Electron/user App.
    let source = ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts'].includes(file)
      ? original.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false') : original
    for (const edit of inverse?.edits ?? []) if (edit.file === file) {
      if (source.split(edit.before).length !== 2) throw Error('Question owner inverse must bind one actual site: ' + inverse.name)
      source = source.replace(edit.before, edit.after)
    }
    if (process.env.QUESTION_OWNER_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.QUESTION_OWNER_LOADED, JSON.stringify({ file, sourceSHA256: hash(original), loadedSHA256: hash(source),
        nativePersistenceBranch: source !== original && source === original.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false'),
        ...(inverse?.edits?.some((edit: { file: string }) => edit.file === file) ? { mutation: inverse.name } : {}) }) + '\n')
    }
    return source === original ? undefined : { code: source, map: null }
  } }],
  test: { ...base.test,
    include: ['apps/desktop/test/workbench-user-state-consumer.test.ts', 'apps/desktop/test/composer-tools-first-presentation.test.tsx'],
    exclude: [], passWithNoTests: false, testTimeout: 30000
  }
})
