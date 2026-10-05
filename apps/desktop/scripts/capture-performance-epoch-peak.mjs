import assert from 'node:assert/strict'
import { resolve, join, isAbsolute } from 'node:path'
import { readFile } from 'node:fs/promises'
import { capturePerformancePanel } from './fixtures/performance-panel/capture.mjs'
const root=resolve(import.meta.dirname,'../../..'), args=process.argv.slice(2)
assert.ok(args.length===0||args.length===2&&args[0]==='--evidence'&&isAbsolute(args[1]))
const evidence=args[1]??join(root,'.local/state/t003-epoch/ui-captures','run-'+globalThis.crypto.randomUUID())
const receipt=await capturePerformancePanel({root,evidence,captureScope:'epoch-peak'})
assert.equal(receipt.completed,true);assert.equal(receipt.sourceCurrentReadbackExact,true);assert.equal(receipt.privateRootRemoved,true)
assert.equal(receipt.officialOwnerQualification,false);assert.deepEqual(receipt.remainingPrivateProcesses,[])
assert.deepEqual(receipt.processes.map(row=>row.phase),['epoch-peak'])
assert.deepEqual(receipt.frames.map(row=>row.file),['1480-dark-epoch-peak.png','380-light-epoch-peak.png'])
const raw=JSON.parse(await readFile(join(evidence,'epoch-peak-render.json'),'utf8'))
assert.equal(raw.qualificationScope,'epoch-peak-only');assert.equal(raw.qualified,true);assert.equal(raw.afterDisposalLeases,0)
assert.ok(raw.nativeEvents.some(row=>row.isTrusted&&row.key==='Tab'));assert.ok(raw.nativeEvents.some(row=>row.isTrusted&&row.key==='Enter'))
console.log(JSON.stringify({passed:true,evidence,frames:receipt.frames.length,sourceIdentity:receipt.sourceIdentity}))
