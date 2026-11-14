import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export async function createCssSourceOverlay({ root, privateRoot, overlays, inputs, sourcePin, vitePackage }) {
  const postcss = createRequire(vitePackage)('postcss')
  root = await realpath(root)
  await mkdir(privateRoot, { recursive: true }); privateRoot = await realpath(privateRoot)
  const normalized = new Map()
  for (const [file, bytes] of overlays) if (file.endsWith('.css')) normalized.set(await realpath(file), bytes)
  overlays = normalized
  const roots = [...overlays.keys()], importEdges = []
  const mirrors = new Map(), originals = new Map(), rewritten = new Map(), loaded = {}
  const projectFile = file => file.startsWith(root + sep) && !file.includes(sep + 'node_modules' + sep)
  for (const [file, bytes] of overlays) {
    if (!file.endsWith('.css')) continue
    if (sourcePin?.owns(file)) assert.equal(digest(bytes), digest(await sourcePin.read(file)), 'CSS mirror bytes must match the exact Git reader: ' + relative(root, file))
    const tree = postcss.parse(bytes, { from: file })
    const imports = []; tree.walkAtRules('import', rule => imports.push(rule))
    for (const rule of imports) {
      const first = postcss.list.space(rule.params)[0], quote = first?.[0]
      assert.ok((quote === '"' || quote === "'") && first.at(-1) === quote, 'Mirrored CSS imports must use a quoted relative CSS path: ' + relative(root, file))
      const specifier = first.slice(1, -1)
      assert.ok((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.css') && !/[\\?#]/.test(specifier), 'Unsupported mirrored CSS import form: ' + relative(root, file))
      const target = resolve(dirname(file), specifier)
      assert.ok(projectFile(target) && sourcePin?.owns(target), 'Nested CSS imports require the exact project Git namespace: ' + relative(root, target))
      const physical = await realpath(target).catch(error => { if (error.code === 'ENOENT') return target; throw error })
      assert.equal(physical, target, 'A symbolic CSS import requires its original resolver, not a guessed private mirror')
      const nested = await sourcePin.read(target)
      if (overlays.has(target)) assert.equal(digest(overlays.get(target)), digest(nested), 'Nested CSS bytes changed within the selected Git namespace')
      else overlays.set(target, nested)
      importEdges.push({ source: relative(root, file), sourceSHA256: digest(bytes), specifier, target: relative(root, target), targetSHA256: digest(nested), importTextPreserved: true })
    }
    tree.walkDecls(declaration => { assert.ok(!declaration.value.toLowerCase().includes('url('), 'A changed stylesheet with asset URLs needs an actual asset-rebasing loader: ' + relative(root, file)) })
  }
  for (const [file, bytes] of overlays) {
    if (!file.endsWith('.css')) continue
    const mirror = join(privateRoot, 'css-source-overlay', relative(root, file))
    await mkdir(dirname(mirror), { recursive: true }); await writeFile(mirror, bytes)
    mirrors.set(file, mirror); originals.set(mirror, file); originals.set(await realpath(mirror), file)
  }
  const plugin = { name: 'private-css-source-overlay', enforce: 'pre', async transform(source, id) {
    if (!mirrors.size || !id.split('?')[0].endsWith('.css')) return
    const file = await realpath(id.split('?')[0])
    if (!projectFile(file)) return
    const tree = postcss.parse(source, { from: file }), imports = []
    tree.walkAtRules('import', rule => imports.push(rule))
    const replacements = []
    for (const rule of imports) {
      const first = postcss.list.space(rule.params)[0], quote = first?.[0]
      if ((quote !== '"' && quote !== "'") || first.at(-1) !== quote) continue
      const specifier = first.slice(1, -1)
      assert.ok(!specifier.includes('\\'), 'Escaped CSS import names need the original import loader, not a guessed rewrite')
      const resolved = await this.resolve(specifier, id, { skipSelf: true })
      if (!resolved || resolved.external || !resolved.id.split('?')[0].endsWith('.css')) continue
      const target = await realpath(resolved.id.split('?')[0]), mirror = mirrors.get(target)
      if (!mirror) continue
      rule.params = JSON.stringify(mirror) + rule.params.slice(first.length)
      replacements.push({ specifier, source: relative(root, target), mirror: relative(privateRoot, mirror) })
      this.addWatchFile(mirror)
    }
    if (!replacements.length) return
    const effective = tree.toString(), observation = { sourceSHA256: digest(source), effectiveSHA256: digest(effective), replacements }
    rewritten.set(file, observation)
    return { code: effective, map: tree.toResult({ from: file, to: file, map: { inline: false, annotation: false } }).map.toJSON() }
  } }
  const observer = { postcssPlugin: 'bind-actual-vite-css-inputs', async OnceExit(tree) {
    const found = new Set()
    if (tree.source?.input) found.add(tree.source.input)
    tree.walk(node => { if (node.source?.input) found.add(node.source.input) })
    if (sourcePin) await Promise.all([...found].filter(input => input.file).map(async input => {
      const reader = await realpath(resolve(input.file)), file = originals.get(reader) ?? reader
      if (sourcePin.owns(file)) await sourcePin.read(file)
    }))
    for (const input of found) {
      if (!input.file) continue
      const reader = await realpath(resolve(input.file)), file = originals.get(reader) ?? reader
      if (!projectFile(file)) continue
      const bytes = overlays.get(file) ?? await (sourcePin?.owns(file) ? sourcePin.read(file) : readFile(file)), sourceSHA256 = digest(bytes)
      const actualSHA256 = digest(input.hasBOM ? '\uFEFF' + input.css : input.css), rewrite = rewritten.get(file)
      assert.ok(actualSHA256 === sourceSHA256 || actualSHA256 === rewrite?.effectiveSHA256, 'Actual PostCSS input is not the declared source bytes: ' + relative(root, file))
      if (mirrors.has(file)) assert.ok(originals.has(reader), 'Baseline stylesheet bypassed its private original-byte mirror: ' + relative(root, file))
      const key = relative(root, file), record = loaded[key] ??= { sourceSHA256, origin: overlays.has(file) || sourcePin?.owns(file) ? 'git-blob' : 'current-file', reads: [] }
      assert.equal(record.sourceSHA256, sourceSHA256, 'CSS source changed during compilation')
      if (!record.reads.some(read => read.actualSHA256 === actualSHA256 && read.mirror === originals.has(reader))) record.reads.push({ actualSHA256, mirror: originals.has(reader), rewrittenImports: actualSHA256 !== sourceSHA256,
        namespace: originals.has(reader) ? 'private-original-byte-mirror' : 'declared-project-source', reader: relative(originals.has(reader) ? privateRoot : root, reader) })
      inputs[key] = sourceSHA256
    }
  } }
  function verify() {
    assert.ok(Object.keys(loaded).length, 'Actual PostCSS source observation must be nonempty')
    for (const [file] of mirrors) {
      const record = loaded[relative(root, file)]
      assert.ok(record?.reads.length, 'Changed original CSS must actually load through PostCSS: ' + relative(root, file))
      assert.ok(record.reads.every(read => read.mirror && read.actualSHA256 === record.sourceSHA256), 'Every changed stylesheet read uses its exact original bytes')
    }
    return { loaded, rewrites: Object.fromEntries([...rewritten].map(([file, value]) => [relative(root, file), value])), mirroredImports: { roots: roots.map(file => relative(root, file)), edges: importEdges } }
  }
  function emitted(bytes) {
    const tree = postcss.parse(bytes), packetRules = [], disclosureRules = [], headerRules = [], keyframes = []
    tree.walkAtRules('keyframes', rule => keyframes.push(rule.params))
    tree.walkRules(rule => {
      const target = rule.selector.includes('.collaboration-edge__packet') ? packetRules : rule.selector.includes('.conversation-disclosure') ? disclosureRules : null
      if (target) target.push({ selector: rule.selector, declarations: rule.nodes.filter(node => node.type === 'decl').map(node => ({ property: node.prop, value: node.value, important: Boolean(node.important) })) })
      if (rule.selector.includes('.collaboration-area__overview-label') || rule.selector.includes('.collaboration-area__summary') || rule.selector.includes('.collaboration-area__meta')) headerRules.push({ selector: rule.selector, declarations: rule.nodes.filter(node => node.type === 'decl').map(node => ({ property: node.prop, value: node.value, important: Boolean(node.important) })) })
    })
    const packetAnimationNames = [...new Set(packetRules.flatMap(rule => rule.declarations.filter(declaration => declaration.property === 'animation' || declaration.property === 'animation-name').map(declaration => postcss.list.space(declaration.value)[0])))]
    return { sha256: digest(bytes), keyframes, packetRules, packetAnimationNames, disclosureRules, headerRules }
  }
  return { plugin, observer, verify, emitted }
}
