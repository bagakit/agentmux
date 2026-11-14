import { build } from 'esbuild'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bundle the actual bin entry and its current owner source, without npm or Core imports
 * at invocation time. Runtime publication retains these exact built bytes. */
export async function buildHookWorker(coreRoot = resolve(import.meta.dirname, '..')) {
  const outfile = resolve(coreRoot, 'dist/agentmux-hook.mjs')
  await mkdir(dirname(outfile), { recursive: true })
  const result = await build({
    absWorkingDir: resolve(coreRoot, '../..'),
    entryPoints: [resolve(coreRoot, 'bin/agentmux-hook.js')], outfile,
    bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false,
    metafile: true, logLevel: 'silent',
    alias: {
      '@agentmux/identity': resolve(coreRoot, '../identity/src/index.ts'),
      '@agentmux/providers/antigravity/hook-response': resolve(coreRoot, '../providers/src/antigravity/hook-response.ts'),
      '@agentmux/providers/claude/usage': resolve(coreRoot, '../providers/src/claude/usage.ts'),
      '@agentmux/providers/codex/usage': resolve(coreRoot, '../providers/src/codex/usage.ts')
    },
    plugins: [{ name: 'hook-entry-owner', setup(context) {
      context.onResolve({ filter: /^\.\.\/dist\/agent-hook-command\.js$/ }, () => ({ path: resolve(coreRoot, 'src/agent-hook-command.ts') }))
    } }]
  })
  const external = Object.values(result.metafile.outputs).flatMap(output => output.imports)
    .filter(entry => entry.external && !entry.path.startsWith('node:'))
  if (external.length) throw new Error('The Hook worker has non-Node runtime dependencies: ' + JSON.stringify(external))
  const temporary = await mkdtemp(resolve(coreRoot, 'dist/.hook-build-'))
  try {
    const staged = resolve(temporary, 'worker.mjs')
    await writeFile(staged, result.outputFiles[0].contents)
    await rename(staged, outfile)
  } finally { await rm(temporary, { recursive: true, force: true }) }
  await writeFile(outfile + '.meta.json', JSON.stringify(result.metafile) + '\n')
  return { outfile, metafile: result.metafile }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildHookWorker()
