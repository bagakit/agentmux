import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import candidate from './vitest.mote-context.config.mts'

type Edge = { path: string; kind: string; external?: boolean }
type Resolver = { onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; external?: true } | undefined): void }
type Esbuild = { build(options: object): Promise<{ metafile: { inputs: Record<string, { imports: Edge[] }> } }> }

const root = resolve(import.meta.dirname, '../../..')
const esbuild: Esbuild = createRequire(createRequire(resolve(root, 'apps/desktop/package.json')).resolve('vite/package.json'))('esbuild')
const entry = 'apps/desktop/src/renderer/src/main.tsx'
// Only on-demand surfaces use these. A static path from the entry makes every launch parse and evaluate them.
const onDemand = /^(three|react-dom\/server)([./]|$)/
const loads = (edge: Edge) => edge.kind === 'import-statement' || edge.kind === 'require-call'
const aliases = candidate.resolve!.alias as { find: string | RegExp; replacement: string }[]

it('keeps on-demand libraries out of the static Renderer startup graph', async () => {
  const { metafile: { inputs } } = await esbuild.build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true,
    outdir: 'apps/desktop/out/startup-graph', platform: 'browser', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'first-party-graph', setup(build: Resolver) {
      build.onResolve({ filter: /.*/ }, ({ path }) => /[?]|\.(css|md|png|svg|avif|webp|jpe?g|gif|woff2?|ttf|wasm)$/.test(path)
        || /^[^./]/.test(path) && !path.startsWith('@agentmux/') ? { path, external: true } : undefined)
      build.onResolve({ filter: /^@agentmux\// }, ({ path }) => {
        for (const alias of aliases) if (typeof alias.find === 'string' ? alias.find === path : alias.find.test(path)) {
          return { path: path.replace(alias.find, alias.replacement) }
        }
      })
    } }] })
  const startup = new Set([entry])
  for (const path of startup) for (const edge of inputs[path]!.imports) if (!edge.external && loads(edge)) startup.add(edge.path)
  const imports = (paths: Iterable<string>, kept: (edge: Edge) => boolean) => [...paths].flatMap(path =>
    inputs[path]!.imports.filter(edge => edge.external && onDemand.test(edge.path) && kept(edge)).map(edge => `${path} -> ${edge.path}`))
  expect([...startup].filter(path => /renderer\/src\/(App|store)\.tsx?$/.test(path)).sort()).toEqual(['apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/store.ts'])
  expect(new Set(imports(Object.keys(inputs), () => true).map(line => line.split(' -> ')[1]!.split(/[./]/)[0]))).toEqual(new Set(['three', 'react-dom']))
  expect(imports(startup, loads)).toEqual([])
  const map = ['apps/desktop/src/renderer/src/components/AgentCollaborationMap.tsx',
    'apps/desktop/src/renderer/src/components/AgentCollaborationGraph.tsx']
  expect(map.every(path => path in inputs)).toBe(true)
  expect(map.filter(path => startup.has(path))).toEqual([])
  const gallery = ['apps/desktop/src/renderer/src/components/WorkflowComponentGallery.tsx',
    'apps/desktop/src/renderer/src/components/ObservationSurfaceGallery.tsx']
  expect(gallery.every(path => path in inputs)).toBe(true)
  expect(gallery.filter(path => startup.has(path))).toEqual([])
  expect(Object.keys(inputs).filter(path => path.startsWith('test/'))).toEqual([])
}, 120_000)
