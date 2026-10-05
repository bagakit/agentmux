import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '../../../../..')
const scope = process.argv[process.argv.indexOf('--scope') + 1]
assert.ok(['sources','editor','durable'].includes(scope), 'Choose one actual nonempty task scope')
async function run(file, args) {
  const child = spawn(file, args, { cwd:root,env:process.env,stdio:['ignore','pipe','pipe'] })
  let stdout='', stderr=''
  child.stdout.on('data', bytes => { stdout+=bytes }); child.stderr.on('data',bytes => { stderr+=bytes })
  const code=await new Promise(resolve => child.on('exit',resolve))
  if (code !== 0) {
    const directory=path.join(root,'.local/state/mote-avatar-series')
    await fs.mkdir(directory,{recursive:true})
    await fs.writeFile(path.join(directory,'verification-failure.json'),JSON.stringify({scope,file,args,code,stdout,stderr},null,2)+'\n')
  }
  assert.equal(code,0,stderr+'\n'+stdout)
  return stdout.trim()
}
if (scope==='sources') {
  await run('pnpm',['exec','vitest','run','apps/desktop/test/mote-avatar-series.test.ts','--maxWorkers=1'])
  const receipts=[]
  for (const mutation of [null,'source-owner-disconnected','host-forward-disconnected','result-decoder-disconnected','exact-source-ignored']) {
    const output=await run(process.execPath,['apps/desktop/scripts/fixtures/mote-avatar-series/source-capture.mjs',...(mutation?['--mutation',mutation]:[])])
    const receipt=JSON.parse(await fs.readFile(output,'utf8'))
    assert.equal(receipt.passed,true)
    assert.ok(receipt.calls.length>0 && Object.keys(receipt.source).length>0 && receipt.processes.length===2)
    if (mutation) { assert.equal(receipt.mutationDetected,true); assert.equal(receipt.mutation.name,mutation) }
    else assert.ok(receipt.calls.length>=10, 'Actual nonempty image/face/model and rejection consumers are required')
    receipts.push({mutation,path:output})
  }
  console.log(JSON.stringify({scope,passed:true,receipts}))
} else {
  throw new Error('This scope has not yet closed its actual consumer and review evidence: '+scope)
}
