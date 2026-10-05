import { fixturePath } from './helpers/fixture-values.js'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { STAGE_CORE } from '../src/remote-core-upgrade-programs.js'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function stage(input: unknown): Promise<{ releaseDirectory: string; remoteCommand: string; digest: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', STAGE_CORE], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Stage exited ${code}: ${stderr}`))
      else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

it('stages the same artifact twice without changing manifest files and executes the pinned-node amux', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-stage-')); roots.push(root)
  // Both the original Node path and deployed JS path exercise shell quotation.
  const quotedRoot = join(root, "private 'quoted space")
  const artifact = join(quotedRoot, 'artifact'), stateDirectory = join(quotedRoot, 'state')
  const node = join(quotedRoot, "node 'pinned")
  await mkdir(join(artifact, 'bin'), { recursive: true })
  await mkdir(join(artifact, 'dist'))
  await symlink(process.execPath, node)
  const module = 'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),node:process.execPath})+"\\n")\n'
  const content = {
    'package.json': '{"type":"module"}\n',
    'bin/amux': '#!/usr/bin/env node\nimport "../dist/agentmux.js"\n',
    'dist/headless-runtime.js': 'export {}\n',
    'dist/agentmux.js': module
  }
  const files = []
  for (const [path, text] of Object.entries(content)) {
    const target = join(artifact, path), mode = path === 'bin/amux' ? 0o755 : 0o644
    await writeFile(target, text); await chmod(target, mode)
    files.push({ path, sha256: sha(Buffer.from(text)), mode })
  }
  const archivePath = join(root, 'artifact.tar.gz')
  await exec('tar', ['-czf', archivePath, '-C', artifact, '.'])
  const archive = await readFile(archivePath), digest = 'a'.repeat(64)
  const input = { stateDirectory, node, digest, operationId: 'first', archive: archive.toString('base64'),
    archiveDigest: sha(archive), files }
  const first = await stage(input)
  const expectedRoot = join(stateDirectory, 'core-releases', digest)
  expect(first).toEqual({ releaseDirectory: expectedRoot, remoteCommand: join(expectedRoot, 'launcher', 'amux'), digest })
  const deploymentBefore = await readFile(join(expectedRoot, 'deployment.json'))
  const manifestBefore = await Promise.all(files.map(async file => ({ ...file, bytes: await readFile(join(expectedRoot, file.path)) })))
  const second = await stage({ ...input, operationId: 'second' })
  expect(second).toEqual(first)
  expect(await readFile(join(expectedRoot, 'deployment.json'))).toEqual(deploymentBefore)
  for (const file of manifestBefore) {
    const bytes = await readFile(join(expectedRoot, file.path))
    expect(bytes).toEqual(file.bytes)
    expect(sha(bytes)).toBe(file.sha256)
    expect((await stat(join(expectedRoot, file.path))).mode & 0o777).toBe(file.mode)
  }
  expect((await stat(first.remoteCommand)).mode & 0o777).toBe(0o755)
  const args = ['system', 'endpoint', '--stdio', "literal 'quote", 'two words', '--help', 'line\nbreak']
  // No node on PATH: the generated wrapper must invoke the qualified original Node.
  const result = await exec(first.remoteCommand, args, { env: { ...process.env, PATH: fixturePath("missing-node") } })
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toEqual({ argv: args, node: process.execPath })
})
