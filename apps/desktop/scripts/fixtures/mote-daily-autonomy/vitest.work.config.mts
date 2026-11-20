import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
import { bundleIdentityRuntime } from '../../../../../packages/identity/scripts/runtime-bundle.mjs'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const repository = resolve(import.meta.dirname, '../../../../..')
const identityRuntime = await bundleIdentityRuntime()
const generatedIdentity = '\0mote-work-identity-runtime'
const loaded = { name: 'mote-work-loaded-source', transform(source: string, id: string) {
  const file = id.split('?')[0]!, path = relative(repository, file)
  let candidate = source
  if (process.env.AGENTMUX_MOTE_WORK_MUTANT === 'unscoped-warning' && path === 'apps/desktop/src/renderer/src/lib/mote-goals.ts') {
    const anchor = 'const affected = Object.values(records)'
    if (source.split(anchor).length !== 2) throw Error('Missing original warning scope')
    candidate = source.replace(anchor, 'const affected = unresolved.size > 0 || Object.values(records)')
  }
  if (process.env.AGENTMUX_WORK_SOURCE_RECEIPT && !path.startsWith('../') && /^(apps\/desktop\/(src|test)|packages\/)/.test(path) && !path.includes('/node_modules/'))
    appendFileSync(process.env.AGENTMUX_WORK_SOURCE_RECEIPT, JSON.stringify({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      ...(candidate === source ? {} : { loadedSha256: createHash('sha256').update(candidate).digest('hex') }) }) + '\n')
  if (candidate !== source) return candidate
} }
export default defineConfig({ ...owning,
  resolve: { alias: owning.resolve.alias.filter(alias => !alias.find.test('@agentmux/identity/runtime-source')) },
  plugins: [{ name: 'mote-work-build-qualified-identity',
    resolveId: id => id === '@agentmux/identity/runtime-source' ? generatedIdentity : undefined,
    load: id => id === generatedIdentity ? 'export const identityRuntimeSource = ' + JSON.stringify(identityRuntime.source) : undefined
  }, loaded],
  test: { ...owning.test, include: ['test/mote-daily-work.test.tsx', 'test/mote-qualified-goals.test.tsx'], passWithNoTests: false } })
