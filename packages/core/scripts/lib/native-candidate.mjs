import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

export const candidateHash = value => createHash('sha256').update(value).digest('hex')

export async function fingerprintSources(root, directory, nested = false) {
  const inputs = {}
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) Object.assign(inputs, await fingerprintSources(root, path, true))
    else if (/\.(?:ts|tsx|json|css|svg)$/u.test(entry.name)) inputs[path] = candidateHash(await readFile(join(root, path)))
  }
  if (!nested) assert.ok(Object.keys(inputs).length, 'A candidate source collection must be nonempty: ' + directory)
  return inputs
}

export function runCandidateProgram(root, program, args, env = {}, timeoutMs = 120000) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, stdout, stderr }) })
  })
}

/** Exact compiler inputs, separate from the tests that consume its one private output. */
export async function nativeCandidateSources(root) {
  const sources = { ...await fingerprintSources(root, 'packages/core/src'), ...await fingerprintSources(root, 'packages/providers/src') }
  const inputs = { ...sources }
  for (const path of ['tsconfig.base.json', 'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json',
    'packages/providers/tsconfig.json', 'packages/core/package.json', 'packages/providers/package.json',
    'packages/core/bin/amux', 'packages/core/native/native-socket-peer.c', 'packages/core/scripts/lib/native-candidate.mjs']) {
    inputs[path] = candidateHash(await readFile(join(root, path)))
  }
  return { sources, inputs }
}

/** Core, Providers and its package-owned native helper; no shared dist or dependency copy. */
export async function compileNativeCandidate(root, candidate, evidence, inputs) {
  const digest = candidateHash(JSON.stringify(inputs))
  const providersDigest = candidateHash(JSON.stringify(Object.fromEntries(Object.entries(inputs).filter(([path]) =>
    path.startsWith('packages/providers/') || path === 'tsconfig.base.json'))))
  await mkdir(evidence, { recursive: true })
  let receipt
  try { receipt = JSON.parse(await readFile(join(candidate, 'compiled.json'), 'utf8')) } catch { /* No reusable private candidate. */ }
  const reused = receipt?.digest === digest
  if (!reused) {
    for (const name of ['core', 'providers']) {
      await mkdir(join(candidate, name, 'dist'), { recursive: true })
      await copyFile(join(root, 'packages', name, 'package.json'), join(candidate, name, 'package.json'))
      try { await symlink(join(root, 'packages', name, 'node_modules'), join(candidate, name, 'node_modules'), 'dir') }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    await mkdir(join(candidate, 'core/bin'), { recursive: true })
    await copyFile(join(root, 'packages/core/bin/amux'), join(candidate, 'core/bin/amux'))
    try { await symlink(join(root, 'packages/core/vendor'), join(candidate, 'core/vendor'), 'dir') }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    let priorProviders
    try { priorProviders = JSON.parse(await readFile(join(candidate, 'providers-compiled.json'), 'utf8')) } catch { /* No previous Provider compile. */ }
    if (priorProviders?.digest !== providersDigest) {
      await rm(join(candidate, 'providers/dist'), { recursive: true, force: true })
      const result = await runCandidateProgram(root, process.execPath, ['node_modules/typescript/bin/tsc', '-p',
        'packages/providers/tsconfig.json', '--incremental', 'false', '--composite', 'false', '--outDir', join(candidate, 'providers/dist')])
      await writeFile(join(evidence, 'providers-compile.log'), result.stdout + result.stderr)
      assert.equal(result.code, 0, 'The exact candidate Providers must compile; see providers-compile.log.')
      await writeFile(join(candidate, 'providers-compiled.json'), JSON.stringify({ digest: providersDigest }) + '\n')
    }
    const manifest = JSON.parse(await readFile(join(root, 'packages/providers/package.json'), 'utf8'))
    const paths = Object.fromEntries(Object.entries(manifest.exports).flatMap(([key, entry]) => entry.types ? [[
      '@agentmux/providers' + (key === '.' ? '' : key.slice(1)), [resolve(candidate, 'providers', entry.types)]
    ]] : []))
    const project = join(candidate, 'core.build.json')
    await writeFile(project, JSON.stringify({ extends: join(root, 'packages/core/tsconfig.build.json'),
      compilerOptions: { paths, incremental: false, composite: false, outDir: join(candidate, 'core/dist') } }))
    await rm(join(candidate, 'core/dist'), { recursive: true, force: true })
    const result = await runCandidateProgram(root, process.execPath, ['node_modules/typescript/bin/tsc', '-p', project])
    await writeFile(join(evidence, 'core-compile.log'), result.stdout + result.stderr)
    assert.equal(result.code, 0, 'The exact candidate Core must compile; see core-compile.log.')
    let helper
    if (process.platform === 'darwin') {
      const executable = join(candidate, 'core/dist/native-socket-peer-darwin')
      const result = await runCandidateProgram(root, 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
        join(root, 'packages/core/native/native-socket-peer.c'), '-o', executable], {}, 10000)
      await writeFile(join(evidence, 'native-helper-compile.log'), result.stdout + result.stderr)
      assert.equal(result.code, 0, 'The private native helper must compile with the production flags.')
      helper = { sourceSHA256: inputs['packages/core/native/native-socket-peer.c'], executableSHA256: candidateHash(await readFile(executable)) }
    }
    receipt = { digest, ...(helper ? { helper } : {}) }
    await writeFile(join(candidate, 'compiled.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  const compiled = {}
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.js')) compiled[relative(candidate, path)] = candidateHash(await readFile(path))
    }
  }
  for (const name of ['core', 'providers']) await walk(join(candidate, name, 'dist'))
  assert.ok(compiled['core/dist/agentmux.js'] && compiled['core/dist/public-rpc-server.js'] &&
    compiled['core/dist/control-endpoint-listener-worker.js'], 'The public CLI, Server and listener worker must belong to this candidate.')
  return { receipt, compiled, reused }
}
