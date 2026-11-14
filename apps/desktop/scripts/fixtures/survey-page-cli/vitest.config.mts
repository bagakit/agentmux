import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../survey-tab-composition/vitest.config.mts'
import { candidateAlias } from '../../candidate-package-resolve.mjs'
import { bundleIdentityRuntime } from '../../../../../packages/identity/scripts/runtime-bundle.mjs'

const root = resolve(import.meta.dirname, '../../../../..')
const identitySource = resolve(root, '.artifacts/browser-clean-capture/survey-identity-runtime.ts')
await writeFile(identitySource, `export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`)
export default defineConfig({ ...owning,
  resolve: { ...owning.resolve, alias: [{ find: '@agentmux/identity/runtime-source', replacement: identitySource }, candidateAlias(root, { source: true, browser: true }),
    { find: 'react', replacement: resolve(root, 'apps/desktop/node_modules/react') },
    { find: 'react-dom', replacement: resolve(root, 'apps/desktop/node_modules/react-dom') }] },
  cacheDir: resolve(root, '.cache/survey-page-cli'),
  plugins: [...(owning.plugins ?? []), { name: 'actual-survey-cli-source', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!file.startsWith('packages/') && !file.startsWith('apps/desktop/')) return
    const selected = process.env.SURVEY_PAGE_CLI_MUTATION ? JSON.parse(process.env.SURVEY_PAGE_CLI_MUTATION) as { file: string; before: string; after: string } : null
    let code = source
    if (selected?.file === file) {
      assert.equal(source.split(selected.before).length, 2, 'One exact Survey owner mutation anchor')
      code = source.replace(selected.before, selected.after)
    }
    if (process.env.SURVEY_PAGE_CLI_LOADED) appendFileSync(process.env.SURVEY_PAGE_CLI_LOADED,
      JSON.stringify({ file, original: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(code).digest('hex'), mutated: source !== code }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }],
  test: { ...owning.test, include: ['apps/desktop/test/browser-profile-survey-control.test.ts', 'apps/desktop/test/survey-tab-composition.test.tsx'],
    testNamePattern: '\\[survey-cli\\]', passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
