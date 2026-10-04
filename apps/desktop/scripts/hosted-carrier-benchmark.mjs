import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createRequire } from 'node:module'

export function benchmarkHostedCarrier(root, directory) {
  const require = createRequire(import.meta.url)
  const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')
  const baseline = execFileSync('git', ['show','HEAD:packages/core/src/hosted-value.ts'], { cwd: root, encoding: 'utf8' })
  const candidatePath = join(root,'packages/core/src/hosted-value.ts'), candidate = readFileSync(candidatePath,'utf8')
  const baselinePath = join(directory,'carrier-baseline.cjs'), candidateBundle = join(directory,'carrier-candidate.cjs')
  buildSync({ stdin: { contents: baseline, resolveDir: join(root,'packages/core/src'), sourcefile: 'hosted-value.ts', loader:'ts' }, outfile: baselinePath, bundle:true, platform:'node', format:'cjs', logLevel:'silent' })
  buildSync({ entryPoints:[candidatePath], outfile:candidateBundle, bundle:true, platform:'node', format:'cjs', logLevel:'silent' })
  const modules = { baseline: require(baselinePath), candidate: require(candidateBundle) }, rows = []
  for (const family of ['text','bytes']) for (const size of [65536,1048576,8388608]) for (let round = 0; round < 4; round++) {
    const bytes = new Uint8Array(size + 8); for (let i=0;i<bytes.length;i++) bytes[i]=i%256
    const value = family === 'bytes' ? { ordered:bytes.subarray(3,size+3), text:'中文', optional:[undefined,42] }
      : { text:'abc界'.repeat(Math.floor(size/4)), optional:[undefined, { $agentmuxValue:'ordinary' }] }
    for (const name of ['baseline','candidate']) {
      const module = modules[name], start = performance.now(), chunks = module.hostedTransfer(value,'bounded-benchmark'), encodedMs = performance.now()-start
      const reader = new module.AgentMuxHostedTransferReader(); let decoded, totalMs=0,maxMs=0,finalMs=0
      for (let index=0;index<chunks.length;index++) {
        const at=performance.now(); decoded=reader.accept(chunks[index]); const elapsed=performance.now()-at
        totalMs+=elapsed;maxMs=Math.max(maxMs,elapsed);if(index===chunks.length-1)finalMs=elapsed
      }
      assert.deepEqual(decoded,value)
      rows.push({ family,size,round,name,frames:chunks.length,encodedMs,allAcceptCallsMs:totalMs,maxSingleAcceptMs:maxMs,finalAcceptMs:finalMs })
    }
  }
  const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)]
  const comparisons=[]
  for (const family of ['text','bytes']) for (const size of [65536,1048576,8388608]) {
    const groups=Object.fromEntries(['baseline','candidate'].map(name=>[name,rows.filter(row=>row.family===family&&row.size===size&&row.name===name&&row.round>0)]))
    assert.deepEqual(groups.baseline.map(row=>row.frames),groups.candidate.map(row=>row.frames))
    const encodeRatio=median(groups.baseline.map(row=>row.encodedMs))/median(groups.candidate.map(row=>row.encodedMs))
    const decodeRatio=median(groups.baseline.map(row=>row.allAcceptCallsMs))/median(groups.candidate.map(row=>row.allAcceptCallsMs))
    if(size>=1048576) { assert.ok(encodeRatio>2,'production native encoding must improve');assert.ok(decodeRatio>2,'production byte decoding must improve') }
    comparisons.push({family,size,encodeRatio,decodeRatio})
  }
  const sha = value => createHash('sha256').update(value).digest('hex')
  const receipt={passed:true,node:process.version,baselineHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    baselineSHA256:sha(baseline),candidateSHA256:sha(candidate),benchmarkSHA256:sha(readFileSync(import.meta.filename)),rows,comparisons,
    limitations:'Alternating synthetic lawful text/byte carriers, not user payload distribution, installed latency or original incident attribution. allAcceptCallsMs sums separate accept calls; finalAcceptMs is one synchronous final call. Existing 32MiB maximum is tested separately. No Run action.'}
  writeFileSync(join(directory,'benchmark.json'),JSON.stringify(receipt,null,2)+'\n')
  return receipt
}
