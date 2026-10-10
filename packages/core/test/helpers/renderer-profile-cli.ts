import { appendFileSync } from 'node:fs'
import { readFile, writeFile, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

/** Core's existing esbuild dev dependency compiles only the actual CLI for this unit fixture. */
export async function compileRendererProfileCli(root: string, directory: string, frozen: Record<string, string>, loaded?: string): Promise<string> {
  const entry = join(directory, 'amux.mjs'), compilationReads: Record<string, string> = {}
  const compiled = await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: entry,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', metafile: true,
    plugins: [{ name: 'frozen-profile-cli-input', setup(builder) { builder.onLoad({ filter: /\.[cm]?tsx?$/ }, async args => {
      const path = relative(root, args.path), contents = frozen[path] ?? await readFile(args.path, 'utf8')
      compilationReads[path] = createHash('sha256').update(contents).digest('hex')
      if (loaded) appendFileSync(loaded, JSON.stringify({ path, sha256: compilationReads[path], kind: 'cli-compiled-source' }) + '\n')
      return { contents, loader: args.path.endsWith('tsx') ? 'tsx' : 'ts' }
    }) } }] })
  await symlink(join(root, 'packages/core/node_modules'), join(directory, 'node_modules'), 'dir')
  await writeFile(join(directory, 'compilation.json'), JSON.stringify({ sourceReads: compilationReads, metafile: compiled.metafile,
    compiledSha256: createHash('sha256').update(await readFile(entry)).digest('hex'), nativeOrApp: false }))
  return entry
}
