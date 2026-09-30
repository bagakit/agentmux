import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const repository = resolve(import.meta.dirname, '../../../../..')
// This bounded UI gate consumes current Source directly. It does not build or
// claim freshness of Core's published dist, nor exercise a live Runtime/Run.
const aliases = ['core', 'demand', 'layout'].flatMap(name => {
  const directory = resolve(repository, 'packages', name)
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as {
    exports: Record<string, { import: string }>
  }
  const entries = Object.entries(manifest.exports)
  if (!entries.length) throw new Error(`No public ${name} exports were found`)
  return entries.map(([subpath, target]) => {
    if (name !== 'layout' && (!target.import.startsWith('./dist/') || !target.import.endsWith('.js')))
      throw new Error(`Unmapped ${name} Source export: ${subpath}`)
    const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
    const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
    const replacement = resolve(directory, source)
    if (!existsSync(replacement)) throw new Error(`Missing current Source for ${specifier}: ${replacement}`)
    return { find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement }
  })
})

export default defineConfig({
  root: resolve(repository, 'apps/desktop'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: aliases },
  test: {
    setupFiles: [resolve(repository, 'vitest.setup.ts')],
    include: ['test/mote-avatar-identity.test.tsx', 'test/mote-avatar-assets.test.ts', 'test/mote-primary-identity.test.tsx', 'test/mote-primary-directory.test.ts', 'test/space-object-appearance.test.tsx', 'test/space-object-appearance-persistence.test.ts', 'test/mote-floating-resize.test.tsx', 'test/pmo-teams-topic-floating.test.tsx', 'test/mote-navigation-rail.test.tsx', 'test/mote-footer-density.test.tsx',
      'test/surface-nav-density.test.ts', 'test/mote-hover-settings-ownership.test.tsx', 'test/footer-navigation-density.test.ts',
      'test/mote-archive-service.test.ts', 'test/mote-archive-interaction.test.tsx',
      'test/mote-default-dialogue.test.tsx', 'test/mote-hover-surface.test.tsx', 'test/mote-shortcut-context.test.tsx'],
    passWithNoTests: false,
    maxWorkers: 1
  }
})
