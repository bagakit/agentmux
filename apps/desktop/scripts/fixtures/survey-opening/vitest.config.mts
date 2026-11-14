import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateAlias } from '../../candidate-package-resolve.mjs'
import { radixOverlayAliases } from '../../../../../packages/client-ui/scripts/radix-overlay-aliases'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const identityRuntime = process.env.SURVEY_OPENING_IDENTITY_RUNTIME
if (!identityRuntime) throw new Error('The fresh private identity module is required')
const packages = candidateAlias(root, { source: true, browser: true }), candidates = new Map<string, string>()
const sourcePackages = { ...packages, customResolver(specifier: string) {
  if (specifier === '@agentmux/identity/runtime-source') {
    return identityRuntime
  }
  if (!candidates.has(specifier)) candidates.set(specifier, packages.customResolver(specifier))
  return candidates.get(specifier)!
} }
export default defineConfig({
  root,
  server: { fs: { allow: [root, dirname(identityRuntime)] } },
  resolve: { conditions: ['browser'], alias: [sourcePackages,
    ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement }))] },
  ssr: { resolve: { conditions: ['browser'] }, noExternal: ['@agentmux/client-ui'] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'survey-opening-current-source', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!), mutation = process.env.SURVEY_OPENING_MUTATION ? JSON.parse(process.env.SURVEY_OPENING_MUTATION) : null
    let code = source
    if (file === 'apps/desktop/test/helpers/workface-control-fixture.ts') {
      if (!process.env.SURVEY_OPENING_CLI) throw new Error('The current-source private CLI is required')
      const before = "join(process.cwd(), 'packages/core/bin/amux')"
      if (code.split(before).length !== 2) throw new Error('Expected exactly one original public CLI invocation')
      code = code.replace(before, JSON.stringify(process.env.SURVEY_OPENING_CLI))
    }
    if (mutation?.file === file) {
      if (code.split(mutation.before).length !== 2) throw new Error('Expected one loaded production mutation anchor: ' + file)
      code = code.replace(mutation.before, mutation.after)
    }
    if (process.env.SURVEY_OPENING_LOADED && (/^(apps\/desktop\/(src|test)|packages)\//u.test(file) || id.split('?')[0] === process.env.SURVEY_OPENING_IDENTITY_RUNTIME))
      appendFileSync(process.env.SURVEY_OPENING_LOADED, JSON.stringify({ file,
        sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? null : { code, map: null }
  } }],
  test: {
    environment: 'happy-dom', maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000, hookTimeout: 30_000,
    setupFiles: [resolve(root, 'vitest.setup.ts'),
      resolve(root, 'apps/desktop/scripts/fixtures/mote-navigation-footer/atomic-move.setup.ts'),
      resolve(root, 'apps/desktop/scripts/fixtures/survey-tab-composition/native-listener.setup.ts')],
    include: ['apps/desktop/test/system-open-response.test.ts', 'apps/desktop/test/survey-profile-creation.test.ts',
      'apps/desktop/test/web-url-ingress.test.ts', 'apps/desktop/test/survey-system-url.test.ts',
      'apps/desktop/test/system-web-file.test.ts', 'apps/desktop/scripts/fixtures/survey-opening/boundary.test.ts']
  }
})
