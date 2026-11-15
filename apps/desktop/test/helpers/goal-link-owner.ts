import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { connectAgentMuxRpc } from '@agentmux/core'
import { candidateResolve } from '../../scripts/candidate-package-resolve.mjs'
import { headlessFixture } from '../../../../packages/core/test/helpers/headless-runtime-fixture'

export function goalLinkBuildPlugin(consumer: 'original-private-Host' | 'actual-public-CLI' = 'original-private-Host') {
  const root = resolve(import.meta.dirname, '../../../..')
  const mutation = process.env.GOAL_LINK_MUTATION ? JSON.parse(process.env.GOAL_LINK_MUTATION) : null
  return { name: 'actual-private-goal-owner', setup(build: { onLoad(filter: { filter: RegExp }, load: (input: { path: string }) => Promise<unknown>): void }) {
      build.onLoad({ filter: /[/\\](?:apps[/\\]host[/\\]src[/\\](?:goals|goal-projection)|packages[/\\]core[/\\]src[/\\](?:sharing|control-codec|desktop-focus-parser|agentmux-cli-commands|rpc-business-codec|search-metadata))\.ts$/ }, async input => {
        const path = relative(root, input.path), original = await readFile(input.path, 'utf8')
        let contents = original
        if (mutation?.path === path) for (const edit of mutation.edits) {
          if (contents.split(edit.anchor).length !== 2) throw Error('Goal source mutation requires one original owner segment')
          contents = contents.replace(edit.anchor, () => edit.replacement)
        }
        if (process.env.GOAL_LINK_LOADED) {
          const sha = (text: string) => createHash('sha256').update(text).digest('hex')
          const row = { path, originalSHA256: sha(original), loadedSHA256: sha(contents), ...(mutation?.path === path ? { mutant: mutation.id } : {}), process: consumer }
          contents = `import {appendFileSync as __goalOwnerLoaded} from 'node:fs';__goalOwnerLoaded(${JSON.stringify(process.env.GOAL_LINK_LOADED)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + contents
        }
        return { contents, loader: 'ts' }
      })
    } }
}

/** Real isolated Headless process, original Goal owner, persistent Runtime identity and Native. */
export async function goalLinkOwnerFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'goal-link-owner-')), worker = join(directory, 'owner.mjs')
  const previousOwnerEntry = process.env.AGENTMUX_TEST_OWNER_ENTRY
  let cleanupNative: (() => Promise<void>) | undefined
  try {
    const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../../../..')
    await symlink(join(root, 'apps/host/node_modules'), join(directory, 'node_modules'), 'dir')
    const source = { name: 'goal-link-current-owners', setup(build: import('esbuild').PluginBuild) {
      build.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.pluginData?.goalOwnerDependency) return
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        if (/^@agentmux\/(?:core|demand)(?:\/|$)/u.test(args.path))
          return { path: candidateResolve(root, args.path, { source: true }) }
        const dependency = await build.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir,
          kind: args.kind, namespace: args.namespace, pluginData: { goalOwnerDependency: true } })
        return dependency.errors.length ? { errors: dependency.errors } : { path: dependency.path, external: true }
      })
    } }
    await require('esbuild').build({ entryPoints: [join(root, 'apps/desktop/test/fixtures/goal-links/owner.mjs')], outfile: worker,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      banner: { js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);" },
      plugins: [source, goalLinkBuildPlugin()] })
    vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', worker)
    const native = await headlessFixture()
    cleanupNative = () => native.cleanup()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: native.socketPath } })
    let selected = 'original'
    return { native, directory, async open(name: 'original' | 'other') {
      if (name !== selected) { await writeFile(join(native.env.AGENTMUX_STATE_DIRECTORY!, 'goal-scope'), name); await native.restart(); selected = name }
      return { client, root: join(native.env.AGENTMUX_STATE_DIRECTORY!, name, 'demands') }
    }, async close() { try { await client.dispose(); await native.cleanup() } finally { vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', previousOwnerEntry); await rm(directory, { recursive: true, force: true }) } } }
  } catch (error) {
    try { await cleanupNative?.() } finally { vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', previousOwnerEntry); await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}
