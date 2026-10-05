import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop')
const fixture = path.join(desktop, 'scripts/fixtures/demand-supervisor-setting'), driver = path.join(fixture, 'main.cjs')
const evidence = path.join(root, '.tmp/demand-supervisor-setting', 'visual-'+globalThis.crypto.randomUUID())
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amux-supervisor-settings-render-'))
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
const filesIn = async dir => (await Promise.all((await fs.readdir(dir, {withFileTypes:true})).map(entry => entry.isDirectory() ? filesIn(path.join(dir,entry.name)) : [path.join(dir,entry.name)]))).flat()
const inputs = [driver, ...await filesIn(fixture), ...await filesIn(path.join(desktop,'src/renderer/src/components/settings')), ...await filesIn(path.join(desktop,'src/renderer/src/styles')), path.join(desktop,'src/shared/goals-preferences.ts')]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [path.relative(root,file),createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
await fs.mkdir(evidence, {recursive:true})
const source = await hashes(); await fs.writeFile(path.join(evidence,'source-hashes.json'), JSON.stringify(source,null,2)+'\n')
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
try {
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},build:{target:'esnext',outDir:path.join(privateRoot,'renderer'),emptyOutDir:true}})
  const result = await runProbeProcess(require('electron'), [driver,path.join(privateRoot,'renderer/index.html'),privateRoot,evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:45000})
  assert.equal(result.timedOut,false); assert.equal(result.exitCode,0)
  const receipt = JSON.parse(await fs.readFile(path.join(evidence,'render.json'),'utf8'))
  assert.equal(receipt.passed,true,receipt.failure?.message); assert.equal(receipt.frames.length,4)
  const current = await hashes()
  assert.equal(Object.keys(source).filter(file => current[file] !== source[file]).length, 0, 'Visual consumer changed during capture; see source-hashes.json')
  console.log(JSON.stringify({passed:true,evidence,frames:4,independentReview:'pending'}))
} finally { assert.deepEqual(await listProbeProcesses(-1,privateRoot),[]); await fs.rm(privateRoot,{recursive:true,force:true}) }
