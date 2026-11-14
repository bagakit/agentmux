import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'

const repository = resolve(import.meta.dirname, '../../../../..')
// This bounded UI gate consumes current Source directly. It does not build or
// claim freshness of Core's published dist, nor exercise a live Runtime/Run.
const aliases = ['core', 'demand', 'layout', 'client-ui'].flatMap(name => {
  const directory = resolve(repository, 'packages', name)
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { import: string; browser?: string }>
  }
  // Exact exports precede wildcard exports, and narrower wildcard prefixes
  // precede the package-wide wildcard, matching package resolution semantics.
  const entries = Object.entries(manifest.exports).sort(([a], [b]) =>
    Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
  if (!entries.length) throw new Error(`No public ${name} exports were found`)
  return entries.map(([subpath, target]) => {
    if (name === 'client-ui') {
      const source = typeof target === 'string' ? target : target.browser
      if (!source || source.startsWith('./dist/')) throw new Error(`Unmapped ${name} Source export: ${subpath}`)
      const parts = subpath === '.' ? ['@agentmux/client-ui'] : ('@agentmux/client-ui' + subpath.slice(1)).split('*')
      const expression = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
      const replacement = resolve(directory, source.replace('*', '$1'))
      if (!subpath.includes('*') && !existsSync(replacement)) throw new Error(`Missing current Source for ${subpath}: ${replacement}`)
      return { find: new RegExp('^' + expression + '$'), replacement }
    }
    if (typeof target === 'string') throw new Error(`Unmapped ${name} Source export: ${subpath}`)
    if (name !== 'layout' && (!target.import.startsWith('./dist/') || !target.import.endsWith('.js')))
      throw new Error(`Unmapped ${name} Source export: ${subpath}`)
    const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
    const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
    const replacement = resolve(directory, source)
    if (!existsSync(replacement)) throw new Error(`Missing current Source for ${specifier}: ${replacement}`)
    return { find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement }
  })
})

const packages = resolve(realpathSync(resolve(repository, 'node_modules')), '.pnpm')
const virtualPackage = readdirSync(packages).find(name => name.startsWith('@tanstack+react-virtual@'))
if (!virtualPackage) throw new Error('The existing declared react-virtual dependency is unavailable')
const virtualRoot = resolve(packages, virtualPackage, 'node_modules/@tanstack/react-virtual')
const virtualEntry = resolve(virtualRoot, JSON.parse(readFileSync(resolve(virtualRoot, 'package.json'), 'utf8')).module)
const inputs: Record<string, string> = {}
const mutationName = process.env.AGENTMUX_TEST_MOTE_DIRECTORY_MUTATION
const mutations = {
  'lowest-priority': { file: 'apps/desktop/src/renderer/src/components/ProjectActivity.tsx', original: 'const primary = metrics[0]', changed: 'const primary = metrics.at(-1)' },
  'shared-layout-marker': { file: 'apps/desktop/src/renderer/src/components/SpaceTopicsTree.tsx', original: "avatarMarker={directoryView === 'collaborators'}", changed: 'avatarMarker={true}' }
} as const
const mutation = mutationName ? mutations[mutationName as keyof typeof mutations] : undefined
if (mutationName && !mutation) throw Error('Unknown Mote directory mutation: ' + mutationName)

export default defineConfig({
  plugins: [{
    name: 'actual-directory-source',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(repository + '/') || file.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/.test(file)) return
      const key = relative(repository, file)
      if (mutation?.file === key) {
        if (code.split(mutation.original).length !== 2) throw Error('Mutation must select exactly one loaded production expression: ' + key)
        const mutated = code.replace(mutation.original, mutation.changed)
        inputs[key] = createHash('sha256').update(mutated).digest('hex')
        return { code: mutated, map: null }
      }
      inputs[key] = createHash('sha256').update(readFileSync(file)).digest('hex')
    },
    closeBundle() {
      const out = resolve(repository, '.tmp/mote-collaborator-directory')
      mkdirSync(out, { recursive: true })
      writeFileSync(resolve(out, mutationName ? 'loaded-' + mutationName + '.json' : 'loaded-source.json'), JSON.stringify(inputs, null, 2))
    }
  }],
  root: resolve(repository, 'apps/desktop'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: [{ find: '@tanstack/react-virtual', replacement: virtualEntry }, ...aliases] },
  test: {
    setupFiles: [resolve(repository, 'vitest.setup.ts')],
    include: ['test/mote-collaborator-directory.test.tsx', 'test/mote-directory-settings-control.test.ts', 'test/mote-archive-interaction.test.tsx', 'test/space-tree-navigation.test.tsx', 'test/settings-preferences-control.test.ts'],
    passWithNoTests: false,
    maxWorkers: 1
  }
})
