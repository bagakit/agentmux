import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

// The restart fixture durably records its private detached Run before readiness.
function identity(text) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(text.trim())
  assert.ok(match, 'A private Run must have an exact PID/group/birth record')
  const pid=Number(match[1]),group=Number(match[2]); assert.ok(pid>1&&group>1)
  return {pid,group,born:match[3]}
}
async function liveIdentity(pid) {
  try { return identity((await exec('/bin/ps',['-p',String(pid),'-o','pid=,pgid=,lstart='],{env:{...process.env,LC_ALL:'C'},timeout:5000})).stdout) }
  catch(error) { if(error.code===1)return null; throw error }
}
export async function reapDetachedRuns(directory) {
  const records=[]
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(!entry.isDirectory()||!entry.name.startsWith('workbench-crash-'))continue
    const root=join(directory,entry.name)
    let text;try{text=await readFile(join(root,'owned-run-process.txt'),'utf8')}catch(error){if(error.code==='ENOENT')continue;throw error}
    const owned=identity(text),current=await liveIdentity(owned.pid)
    if(current?.born===owned.born) {
      assert.equal(current.group,owned.group)
      try{process.kill(-owned.group,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
    }
    let remaining=await liveIdentity(owned.pid)
    for(let i=0;remaining?.born===owned.born&&i<40;i++){await new Promise(done=>setTimeout(done,50));remaining=await liveIdentity(owned.pid)}
    assert.ok(!remaining||remaining.born!==owned.born,'The exact detached private Run must be reaped')
    let innerFinallyReached=false;try{await readFile(join(root,'inner-finally-reached'));innerFinallyReached=true}catch(error){if(error.code!=='ENOENT')throw error}
    records.push({...owned,wasAlive:current?.born===owned.born,reaped:true,innerFinallyReached})
  }
  return records
}
