import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('the actual packaging dependency materializer copies a standalone usable neutral Git package', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const { inspectRuntimeApplicationPayload, copyRuntimeFiles } = await import(pathToFileURL(join(root, 'apps/desktop/scripts/runtime-application-payload.mjs')).href)
  const payload = await inspectRuntimeApplicationPayload(root)
  const copies = payload.copies.filter((item: { target: string }) => item.target.startsWith('node_modules/@agentmux/git/'))
  expect(copies.length, 'The real payload must supply the standalone Git package').toBeGreaterThan(0)
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-git-runtime-'))
  try {
    await copyRuntimeFiles(copies, temporary)
    const manifest = JSON.parse(await readFile(join(temporary, 'node_modules/@agentmux/git/package.json'), 'utf8'))
    expect(manifest.name).toBe('@agentmux/git')
    expect(manifest.dependencies ?? {}).toEqual({})
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const m=await import('@agentmux/git'); console.log(JSON.stringify({repository:typeof m.GitRepository,reader:typeof m.readLocalWorktreeFile,history:typeof m.parseGitHistory,credential:m.scrubGitCredentials('https://secret@host/repo')}))"],
    { cwd: temporary, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } })
    expect(JSON.parse(output)).toEqual({ repository: 'function', reader: 'function', history: 'function', credential: 'https://***@host/repo' })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
