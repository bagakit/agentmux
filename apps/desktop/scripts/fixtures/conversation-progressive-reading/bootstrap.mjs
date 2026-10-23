import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app } from 'electron'

// Only platform setup is loaded before the original production Main and its
// static dependencies. Seed and restore deliberately share these same paths.
try {
  const sceneRoot = process.argv[3], phase = process.argv[4]
  const mainBundle = process.argv[12], repositoryRoot = process.argv[13]
  assert.ok(path.isAbsolute(sceneRoot) && path.isAbsolute(mainBundle) && path.isAbsolute(repositoryRoot))
  assert.ok(['seed', 'restore'].includes(phase))
  const expected = { home: path.join(sceneRoot, 'user-data/home'), appData: path.join(sceneRoot, 'app-data'),
    userData: path.join(sceneRoot, 'user-data'), sessionData: path.join(sceneRoot, 'session-data') }
  assert.equal(process.env.HOME, expected.home)
  assert.equal(process.env.CODEX_HOME, path.join(expected.home, '.codex'))
  assert.equal(process.env.AGENTMUX_AGENT_SESSION_STORE, path.join(sceneRoot, 'agent-sessions.json'))
  assert.equal(process.env.AGENTMUX_MESSAGE_QUEUE_PATH, path.join(sceneRoot, 'messages.ndjson'))
  assert.equal(process.env.AGENTMUX_SPATIAL_STATE_STORE, path.join(sceneRoot, 'spatial-state.json'))
  assert.equal(process.env.AGENTMUX_RUNTIME_DIRECTORY, path.join(sceneRoot, 'runtime'))
  assert.equal(process.env.AGENTMUX_STATE_DIRECTORY, path.join(sceneRoot, 'runtime/state'))
  const environment = Object.fromEntries(['HOME', 'CODEX_HOME', 'ZDOTDIR', 'TMPDIR', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map(key => [key, process.env[key]]))
  for (const directory of [...Object.values(expected), ...Object.values(environment)]) {
    assert.ok(typeof directory === 'string' && path.isAbsolute(directory) &&
      !path.relative(sceneRoot, directory).startsWith('..'), 'Each actual user directory belongs to this private scene')
    mkdirSync(directory, { recursive: true })
  }
  for (const [name, directory] of Object.entries(expected)) app.setPath(name, directory)
  const paths = Object.fromEntries(Object.keys(expected).map(name => [name, app.getPath(name)]))
  assert.deepEqual(paths, expected, 'Actual Electron paths are private before any production module loads')
  const isolation = { sceneRoot, phase, pid: process.pid, paths, environment,
    bootstrap: { path: fileURLToPath(import.meta.url), sha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex') } }
  await fs.writeFile(path.join(sceneRoot, 'process-' + phase, 'bootstrap-isolation.json'), JSON.stringify(isolation, null, 2) + '\n')
  const { candidateResolve } = await import(pathToFileURL(path.join(repositoryRoot, 'apps/desktop/scripts/candidate-package-resolve.mjs')).href)
  registerHooks({ resolve(specifier, context, next) {
    return specifier.startsWith('@agentmux/')
      ? { url: pathToFileURL(candidateResolve(repositoryRoot, specifier)).href, shortCircuit: true }
      : next(specifier, context)
  } })
  await import(pathToFileURL(mainBundle).href)
} catch (error) {
  process.stderr.write(String(error.stack) + '\n')
  app.exit(1)
}
