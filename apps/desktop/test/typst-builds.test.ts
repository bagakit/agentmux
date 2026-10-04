import { expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { FileBuilds } from '../src/main/file-builds'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'

it('stages only the source ancestor chain and preserves relative, parent and root resources', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-typst-build-')))
  const root = join(directory, 'original'), parent = join(root, 'docs'), source = join(parent, 'draft.typ')
  await mkdir(parent, { recursive: true })
  await mkdir(join(root, 'assets'))
  await writeFile(source, 'DISK ORIGINAL')
  await writeFile(join(parent, 'sibling.typ'), 'SIBLING RESOURCE')
  await writeFile(join(root, 'parent.typ'), 'PARENT RESOURCE')
  await writeFile(join(root, 'assets/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const compiler = join(directory, 'typst-fixture')
  await writeFile(compiler, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),root=args[args.indexOf('--root')+1],input=args.at(-2),output=args.at(-1);const current=fs.readFileSync(input,'utf8');
console.log(JSON.stringify({args,current,sibling:fs.readFileSync(path.join(path.dirname(input),'sibling.typ'),'utf8'),parent:fs.readFileSync(path.join(path.dirname(input),'../parent.typ'),'utf8'),image:fs.readFileSync(path.join(root,'assets/image.svg'),'utf8'),ancestorLink:fs.lstatSync(path.dirname(input)).isSymbolicLink(),assetsLink:fs.lstatSync(path.join(root,'assets')).isSymbolicLink(),cwd:process.cwd()}));fs.writeFileSync(output,'%PDF-1.7\\n'+current);`)
  await chmod(compiler, 0o755)
  const workspace = { id: 'typst-original', hostId: 'local', path: root, name: 'Typst' } as WorkspaceRecord
  const host = new LocalExecutionHost(), files = new WorkspaceFiles(() => host)
  const builds = new FileBuilds(() => host, () => workspace, files, { commands: { typst: compiler } })
  try {
    const content = '#include "sibling.typ"\n#include "../parent.typ"\n#image("/assets/image.svg")\nCURRENT TYPST DRAFT'
    expect(builds.start(workspace, { id: 'draft', kind: 'typst', path: 'docs/draft.typ', content, resource: { hostId: 'local', path: root } }).status).toBe('running')
    for (let i = 0; i < 300 && builds.inspect('draft')!.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const result = builds.inspect('draft')!
    expect(result.status).toBe('succeeded')
    expect(Buffer.from(result.pdf!).toString()).toContain('CURRENT TYPST DRAFT')
    const receipt = JSON.parse(result.log.trim())
    expect(receipt.current).toBe(content)
    expect(receipt.sibling).toBe('SIBLING RESOURCE')
    expect(receipt.parent).toBe('PARENT RESOURCE')
    expect(receipt.image).toContain('<svg')
    expect(receipt.ancestorLink).toBe(false)
    expect(receipt.assetsLink).toBe(true)
    expect(receipt.cwd).toBe(parent)
    expect(await readFile(source, 'utf8')).toBe('DISK ORIGINAL')
    await expect(readFile(receipt.args.at(-2))).rejects.toThrow()
    await expect(readFile(receipt.args.at(-1))).rejects.toThrow()
    await builds.releaseAll()
    expect(builds.inspect('draft')).toBeUndefined()
  } finally { await builds.dispose(); await files.dispose(); await rm(directory, { recursive: true, force: true }) }
})
