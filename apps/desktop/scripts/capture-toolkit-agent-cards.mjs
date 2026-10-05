import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { capturePerformancePanel } from './fixtures/performance-panel/capture.mjs'
const root=path.resolve(import.meta.dirname,'../../..'),args=process.argv.slice(2)
assert.ok(args.length===2&&args[0]==='--evidence'&&path.isAbsolute(args[1]),'Use --evidence absolute-path')
const receipt=await capturePerformancePanel({root,evidence:args[1],captureScope:'agent-cards'})
assert.equal(receipt.completed,true);assert.equal(receipt.sourceCurrentReadbackExact,true)
assert.equal(receipt.actualApp,true);assert.equal(receipt.officialOwnerQualification,false)
assert.deepEqual(receipt.remainingPrivateProcesses,[]);assert.equal(receipt.privateRootRemoved,true)
assert.equal(receipt.processes.length,1);assert.equal(receipt.processes[0].timedOut,false);assert.equal(receipt.processes[0].exitCode,0)
const raw=JSON.parse(await readFile(path.join(args[1],'agent-cards-render.json'),'utf8'))
assert.equal(raw.qualified,true);assert.equal(raw.afterDisposalLeases,0);assert.equal(raw.refresh.sameRow,true)
assert.ok(receipt.frames.length>=8)
console.log(JSON.stringify({completed:true,evidence:args[1],frames:receipt.frames.length,sourceIdentity:receipt.sourceIdentity,boundary:receipt.boundary}))
