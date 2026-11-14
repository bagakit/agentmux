import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentWorkspaceAliases } from './fixtures/session-takeover/workspace-aliases.mjs'
import { runProbeProcess } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const evidence = resolve(root, process.env.AGENTMUX_GOAL_INPUT_EVIDENCE ?? '.local/goal-input-birth/visual')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const temporary = await mkdtemp(join(tmpdir(), 'amux-goal-input-')), fixture = join(root, 'apps/desktop/scripts/fixtures/goal-input-birth')
const inputs = {}, hash = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const { aliases } = await currentWorkspaceAliases(root)
  aliases.unshift({ find: /^react-dom\/server$/, replacement: join(root, 'apps/desktop/node_modules/react-dom/server.browser.js') })
  aliases.push(...['react', 'react-dom'].map(find => ({ find, replacement: join(root, 'apps/desktop/node_modules', find) })))
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases, conditions: ['browser', 'production', 'import', 'default'] },
    esbuild: { jsx: 'automatic' }, worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', __TERMINAL_WHEEL_UMD_URL__: '"unused"', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'current-goal-input-consumer', enforce: 'pre', transform(source, id) {
      const path = id.split('?')[0]
      if (path.startsWith(root + '/') && !path.includes('/node_modules/')) {
        const digest = hash(source)
        inputs[relative(root, path)] = { sourceSHA256: digest, loadedSHA256: digest }
      }
    } }], build: { target: 'esnext', outDir: join(temporary, 'renderer'), emptyOutDir: true, minify: false, reportCompressedSize: false } })
  for (const file of ['GoalFiniteStartControl.tsx', 'goal-finite-start.ts', 'GoalRelationAccessFields.tsx'])
    assert.ok(Object.keys(inputs).some(path => path.endsWith('/' + file)), 'Actual Goal source loaded: ' + file)
  await Promise.all(['user-data', 'session-data'].map(path => mkdir(join(temporary, path))))
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  const log = [], processResult = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(temporary, 'renderer/index.html'), temporary, evidence],
    { cwd: root, env, timeoutMs: 45_000, onLine: line => log.push(line) })
  await writeFile(join(evidence, 'capture.log'), log.join('\n'), { mode: 0o600 })
  const actual = JSON.parse(await readFile(join(evidence, 'visual.json'), 'utf8'))
  await writeFile(join(evidence, 'source-proof.private.json'), JSON.stringify({ inputs, processResult, temporary, actual }, null, 2), { mode: 0o600 })
  assert.equal(processResult.exitCode, 0, actual.failure?.message ?? log.join('\n')); assert.equal(actual.passed, true)
  console.log(JSON.stringify({ passed: true, evidence, screenshots: actual.screenshots }))
} finally { await rm(temporary, { recursive: true, force: true }) }
