import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, transform } from 'esbuild'

/** Compile a private Node source consumer. Instrumentation owns runtime
 * evaluation witnesses; the metafile below records compilation provenance only. */
export async function bundlePrivateNodeSource({ root, entry, file, sourceExport, instrument }) {
  root = resolve(root); entry = resolve(root, entry); file = resolve(root, file)
  await mkdir(dirname(file), { recursive: true })
  const provenance = file + '.provenance.json', sources = new Map()
  const hash = value => createHash('sha256').update(value).digest('hex')
  const bundled = await build({ absWorkingDir: root, entryPoints: [entry], outfile: file, bundle: true,
    platform: 'node', format: 'esm', target: 'node24', metafile: true, logLevel: 'silent',
    banner: { js: "import { createRequire as __privateSourceRequire } from 'node:module'; const require = __privateSourceRequire(import.meta.url);" },
    plugins: [{ name: 'private-node-original-source', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.pluginData?.originalExternal) return
        const source = sourceExport(args.path)
        if (source) return { path: source }
        if (isBuiltin(args.path)) return
        // Preserve npm import conditions and native dependencies at their
        // original installed locations, outside the private output directory.
        const result = await builder.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, pluginData: { originalExternal: true } })
        return result.errors.length ? { errors: result.errors } : { path: result.path, external: true }
      })
      builder.onLoad({ filter: /\.(?:[cm]?js|tsx?|json)$/ }, async args => {
        const path = relative(root, args.path), original = await readFile(args.path, 'utf8')
        const contents = instrument(original, path)
        const loader = args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : args.path.endsWith('.json') ? 'json' : 'js'
        // An imported CLI must retain its original "am I main?" identity;
        // resources likewise remain relative to their actual source module.
        const compiled = loader !== 'json' && contents.includes('import.meta') ? (await transform(contents, {
          loader, format: 'esm', target: 'node24', sourcefile: args.path, define: {
            'import.meta.url': JSON.stringify(pathToFileURL(args.path).href),
            'import.meta.dirname': JSON.stringify(dirname(args.path)),
            'import.meta.filename': JSON.stringify(args.path)
          } })).code : contents
        sources.set(path, { path, originalSHA256: hash(original), instrumentedSourceSHA256: hash(contents), compiledSourceSHA256: hash(compiled) })
        return { contents: compiled, loader: compiled === contents ? loader : 'js' }
      })
    } }] })
  const included = new Set(Object.values(bundled.metafile.outputs).flatMap(output => Object.entries(output.inputs)
    .filter(([, value]) => value.bytesInOutput > 0).map(([path]) => path)))
  const record = { schema: 'agentmux.private-node-source-bundle.v1', entry: relative(root, entry), file: relative(root, file),
    bundleSHA256: hash(await readFile(file)), sources: [...included].flatMap(path => sources.has(path) ? [sources.get(path)] : []),
    externals: Object.values(bundled.metafile.outputs).flatMap(output => output.imports.filter(value => value.external).map(value => value.path)) }
  await writeFile(provenance, JSON.stringify(record, null, 2) + '\n')
  return { file, provenance, record }
}
