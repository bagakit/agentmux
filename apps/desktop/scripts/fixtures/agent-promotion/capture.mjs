import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runProbeProcess } from '../../probe-process.mjs'
import { radixOverlayAliases } from '../../../../../packages/client-ui/scripts/radix-overlay-aliases.ts'
const fixture = import.meta.dirname, root = resolve(fixture, '../../../../..')
const settingsOnly = process.argv.includes('--settings-only')
const mainRoot = dirname(resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()))
const require = createRequire(join(mainRoot, 'apps/desktop/package.json')), { build } = await import(require.resolve('vite'))
const evidenceRoot = join(root, '.tmp/agent-mote-promotion'), evidence = join(evidenceRoot, 'visual-' + randomUUID())
const temporary = await mkdtemp(join(tmpdir(), 'amux-agent-promotion-')), compiled = join(temporary, 'renderer')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = {}
const record = async id => { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/') && existsSync(file)) inputs[relative(root,file)] = hash(await readFile(file)) }
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', inputs,
 captureSubset: settingsOnly ? 'promotion-settings-only' : 'promotion-settings-and-menus',
 boundary: 'Production Agent/Topic menus, Promotion SettingsPanel, Store and styles in a private Electron Renderer; controlled configuration responses. Shared Takeover creation and recovery have separate probes. No user data, native CLI, installed App or lifecycle proof.', frames: [] }
await mkdir(evidence, { recursive: true })
try {
  execFileSync(process.execPath, ['--check', join(fixture, 'main.cjs')], { stdio: 'pipe' })
  const packages = new Map()
  const sourceResolver = { name: 'topic-promotion-current-public-sources', enforce: 'pre',
    async resolveId(specifier) {
      if (!specifier.startsWith('@agentmux/')) return
      const [, name, ...parts] = specifier.split('/')
      let pkg = packages.get(name)
      if (!pkg) {
        const directory = [join(root, 'packages', name), join(root, 'apps', name)].find(path => existsSync(join(path, 'package.json')))
        assert.ok(directory, 'Current workspace package exists: ' + name)
        const manifestPath = join(directory, 'package.json'); await record(manifestPath)
        pkg = { directory, manifest: JSON.parse(await readFile(manifestPath, 'utf8')) }; packages.set(name, pkg)
      }
      const entry = parts.length ? './' + parts.join('/') : '.'
      const declarations = Object.entries(pkg.manifest.exports ?? {}).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
      for (const [pattern, value] of declarations) {
        const [prefix, suffix = ''] = pattern.split('*')
        if (pattern.includes('*') ? !entry.startsWith(prefix) || !entry.endsWith(suffix) : entry !== pattern) continue
        const match = pattern.includes('*') ? entry.slice(prefix.length, suffix ? -suffix.length : undefined) : ''
        const target = typeof value === 'string' ? value : value.browser ?? value.import ?? value.default
        assert.equal(typeof target, 'string', 'Public browser/import export ' + specifier)
        let source = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts').replace('*', match)
        if (name === 'identity' && entry === './runtime') source = './src/runtime-entry.ts'
        if (name === 'identity' && entry === './runtime-source') source = target
        const file = [resolve(pkg.directory, source), resolve(pkg.directory, source.replace(/\.ts$/, '.tsx'))].find(existsSync)
        assert.ok(file, 'Current public source exists: ' + specifier + ' → ' + source)
        return file
      }
      throw Error('No current public export for ' + specifier)
    },
    async transform(source, id) {
      await record(id)
    },
    async generateBundle() { await Promise.all(this.getWatchFiles().map(record)) }
  }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' }, worker: { format: 'es', plugins: () => [sourceResolver] },
    resolve: { alias: radixOverlayAliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [sourceResolver], build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(compiled,'index.html'), temporary,evidence,...(settingsOnly?['--settings-only']:[])],
    { temporaryRoot: temporary, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
  await writeFile(join(evidence,'process.log'),logs.join('\n'))
  receipt.actual = JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
  assert.equal(receipt.process.timedOut,false)
  assert.equal(receipt.actual.passed,true, JSON.stringify(receipt.actual))
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence,frame.file))) })))
  assert.ok(receipt.frames.length > 0, 'The selected real Renderer scenes are nonempty')
  const requiredConsumers = ['SettingsPanel.tsx', 'TopicDirectorySettingsPane.tsx', 'store.ts',
    ...(settingsOnly ? [] : ['AgentRegionHeader.tsx', 'AgentMenuContent.tsx', 'TopicContextMenu.tsx'])]
  for(const suffix of requiredConsumers) assert.ok(Object.keys(inputs).some(path=>path.endsWith('/'+suffix)), 'Actual consumer loaded: '+suffix)
  receipt.passed = true
} catch(error) { receipt.error = String(error); throw error }
finally {
  await writeFile(join(evidence,'receipt.json'), JSON.stringify(receipt,null,2))
  await writeFile(join(evidence,'review.md'), '# Agent Promotion Renderer capture\n\n'+receipt.boundary+'\n\n'+receipt.frames.map(frame=>'- ['+frame.label+']('+frame.file+')').join('\n')+'\n')
  await writeFile(join(evidenceRoot,'latest-visual.json'), JSON.stringify({ evidence: relative(root,evidence) }))
  console.log('Agent Promotion visual evidence: '+relative(root,evidence))
  await rm(temporary,{recursive:true,force:true})
}
