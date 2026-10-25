import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { copyFile, glob, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { build } from 'esbuild'
import { objectCliEnvironment, type CliResult } from './object-cli-rpc.js'

/** Compile only the original CLI; its requests still reach the actual public owner. */
export async function conversationReaderCli(socketRoot: string) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-reader-cli-'))
  const root = resolve(import.meta.dirname, '../../../..'), source = join(root, 'packages/core/src')
  // Match the production ESM layout. Flattening its top-level-await cycles into
  // an esbuild bundle can produce an invalid synchronous module initializer.
  const entries: string[] = []
  for await (const file of glob('**/*.ts', { cwd: source })) if (!file.endsWith('.d.ts')) entries.push(join(source, file))
  await build({ entryPoints: entries, outbase: source, outdir: join(directory, 'dist'), platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [{
    name: 'original-cli-module-sources', setup(builder) { builder.onLoad({ filter: /\.ts$/ }, async args => {
      const contents = await readFile(args.path, 'utf8')
      if (process.env.AGENTMUX_RESILIENCE_CLI_LOADED) appendFileSync(process.env.AGENTMUX_RESILIENCE_CLI_LOADED,
        JSON.stringify({ path: relative(root, args.path), sha256: createHash('sha256').update(contents).digest('hex'), kind: 'cli-compiled-source' }) + '\n')
      return { contents, loader: 'ts' }
    }) }
  }] })
  for await (const file of glob('**/*.json', { cwd: source })) { const to = join(directory, 'dist', file); await mkdir(dirname(to), { recursive: true }); await copyFile(join(source, file), to) }
  await writeFile(join(directory, 'package.json'), await readFile(join(root, 'packages/core/package.json')))
  await symlink(join(root, 'packages/core/node_modules'), join(directory, 'node_modules'), 'dir')
  const entry = join(directory, 'dist/agentmux.js')
  return {
    close: () => rm(directory, { recursive: true, force: true }),
    run: (args: readonly string[], stdin = '') => new Promise<CliResult>((resolve, reject) => {
      const child = spawn(process.execPath, [entry, ...args], { env: objectCliEnvironment(socketRoot), stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Private original CLI observation exceeded the test deadline')) }, 15000)
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
      child.stdin.end(stdin)
    })
  }
}
