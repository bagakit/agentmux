import { afterAll, beforeAll, expect, it } from 'vitest'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, chmod, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const exec = promisify(execFile)
let directory: string, entry: string, artifact: string, callerDirectory: string
const sourcePath = resolve('apps/host/src/certificate-preparation.ts')
beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-fixed-certificate-helper-')))
  callerDirectory = join(directory, 'caller-directory'); await mkdir(callerDirectory)
  // A readable same-named file elsewhere must never become this Host's locator.
  await writeFile(join(callerDirectory, 'prepare-private-access.js'), '// unrelated private fixture artifact')
  entry = join(directory, 'locator.mjs'); artifact = join(directory, 'prepare-private-access.js')
  const mutation = process.env.AGENTMUX_CERTIFICATE_PREPARATION_MUTATION
  const substitutions: Record<string, [string, string]> = {
    'artifact-gate-removed': ['    if (!artifact.isFile() || artifact.isSymbolicLink() || artifact.size < 1 || !lstatSync(executable).isFile()) return undefined', ''],
    'caller-cwd-selects-helper': ["join(import.meta.dirname, 'prepare-private-access.js')", "join(process.cwd(), 'prepare-private-access.js')"],
    'node-env-claims-electron': ["typeof process.versions.electron === 'string'", "process.env.ELECTRON_RUN_AS_NODE === '1'"]
  }
  await build({ entryPoints: [sourcePath], outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    plugins: mutation ? [{ name: 'fixed-helper-actual-source-block', setup(builder) {
      builder.onLoad({ filter: /certificate-preparation\.ts$/ }, async ({ path }) => {
        expect(path).toBe(sourcePath); const code = await readFile(path, 'utf8'), replacement = substitutions[mutation]
        expect(replacement).toBeDefined(); expect(code.split(replacement![0])).toHaveLength(2)
        console.info(`AMX_CERTIFICATE_HELPER_MUTANT:${mutation}`)
        return { loader: 'ts', contents: code.replace(replacement![0], replacement![1]) }
      })
    } }] : [] })
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })
async function read() {
  const script = `import {readCertificatePreparation} from ${JSON.stringify(pathToFileURL(entry).href)};console.log(JSON.stringify(readCertificatePreparation()??null));`
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    cwd: callerDirectory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  return JSON.parse(stdout)
}

it('reports the actual executable and same-directory regular helper, and never treats a plain Node environment flag as Electron', async () => {
  await writeFile(artifact, '// private actual delivery locator fixture')
  try { await expect(read()).resolves.toEqual({ executable: process.execPath, entry: artifact, electronRunAsNode: false }) }
  finally { await unlink(artifact) }
})

it('omits only the optional preparation entry for missing, empty, directory, symlink and unreadable helper artifacts', async () => {
  await expect(read()).resolves.toBeNull()
  await writeFile(artifact, ''); await expect(read()).resolves.toBeNull(); await unlink(artifact)
  await mkdir(artifact); await expect(read()).resolves.toBeNull(); await rm(artifact, { recursive: true })
  const target = join(directory, 'unrelated-entry.js'); await writeFile(target, '// readable unrelated file')
  await symlink(target, artifact); await expect(read()).resolves.toBeNull(); await unlink(artifact)
  await writeFile(artifact, '// private unreadable fixture'); await chmod(artifact, 0)
  await expect(read()).resolves.toBeNull(); await unlink(artifact)
})
