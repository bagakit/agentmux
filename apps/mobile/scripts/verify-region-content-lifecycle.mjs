import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const directory = resolve(root, '.local/state/mobile-independent-host/region-read')
const product = 'apps/mobile/src/navigation/MobileRegionContent.tsx', consumer = 'apps/mobile/test/mobile-survey.test.tsx'
const sources = [product, consumer, 'apps/mobile/src/navigation/MobileNoteFile.tsx', 'apps/mobile/src/survey/MobileSurveySurface.tsx',
  'packages/client-ui/src/components/NoteReader.tsx', 'apps/host/src/file-read-owner.ts']
const harness = ['apps/mobile/scripts/verify-region-content-lifecycle.mjs', 'apps/mobile/vitest.config.ts', 'packages/core/package.json']
const hash = value => createHash('sha256').update(value).digest('hex')
const inputs = Object.fromEntries(await Promise.all([...sources, ...harness].map(async path => [path, hash(await readFile(resolve(root, path)))])))
const core = JSON.parse(await readFile(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const aliases = Object.entries(core).flatMap(([key, entry]) => entry.types?.startsWith('./dist/') ? [{
  find: key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2),
  replacement: resolve(root, 'packages/core/src', entry.types.slice(7).replace(/\.d\.ts$/u, '.ts'))
}] : []).sort((a, b) => b.find.length - a.find.length)
const mutation = [
  ['  const valueRef = useRef(value); valueRef.current = value\n',
    '  const valueRef = useRef(value); valueRef.current = value\n  const attempted = useRef<{ client: AgentMuxHostedClient | null; revision: number } | null>(null)\n'],
  ['    if (!visible || !connected) return\n',
    '    if (!visible || !connected || attempted.current && attempted.current.client === client && attempted.current.revision === revision) return\n    attempted.current = { client, revision }\n']
]
await mkdir(directory, { recursive: true })
const runs = []
for (const label of ['baseline', 'attempted', 'restored']) {
  const mutant = label === 'attempted', loaded = resolve(directory, label + '-loaded.jsonl')
  const result = resolve(directory, label + '-result.json'), config = resolve(directory, label + '.config.mts')
  await writeFile(loaded, '')
  await writeFile(config, `import base from ${JSON.stringify(resolve(mobile, 'vitest.config.ts'))}
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const root=${JSON.stringify(root)},sources=${JSON.stringify(sources)},mutant=${mutant},changes=${JSON.stringify(mutation)}
const hash=value=>createHash('sha256').update(value).digest('hex')
export default {...base,resolve:{...base.resolve,alias:[{find:/^@agentmux\\/host\\/(.+)$/u,replacement:root+'/apps/host/src/$1.ts'},...${JSON.stringify(aliases)}]},
  plugins:[{name:'original-region-read-source',enforce:'pre',transform(source,id){
    const path=relative(root,id.split('?')[0]);if(!sources.includes(path))return
    let output=source
    if(mutant&&path===${JSON.stringify(product)})for(const [from,to]of changes){if(output.split(from).length!==2)throw new Error('The exact original Region read block must occur once');output=output.replace(from,to)}
    appendFileSync(${JSON.stringify(loaded)},JSON.stringify({path,mutant:mutant&&path===${JSON.stringify(product)}?'attempted':null,originalSHA256:hash(readFileSync(id.split('?')[0])),loadedSHA256:hash(output)})+'\\n')
    return output===source?null:output
  }},...base.plugins],test:{...base.test,maxWorkers:1,fileParallelism:false}}
`)
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', config, 'test/mobile-survey.test.tsx', '-t',
      mutant ? 'original Region read lifecycle' : 'original Region read lifecycle|original Survey mobile slice',
      '--reporter=json', '--outputFile=' + result], { cwd: mobile, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null, 'The actual consumer process must complete normally')
  const report = JSON.parse(await readFile(result, 'utf8'))
  const assertions = report.testResults.flatMap(suite => suite.assertionResults)
  const selected = assertions.filter(test => test.status !== 'pending' && test.status !== 'skipped')
  assert.equal(selected.length, mutant ? 8 : 15, 'The exact actual Region/Survey consumer cases must execute')
  const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const path of sources) assert.ok(evaluations.some(row => row.path === path), 'The original owner or consumer must actually evaluate: ' + path)
  assert.ok(evaluations.every(row => row.originalSHA256 === inputs[row.path]), 'All rounds must consume one original source candidate')
  if (mutant) {
    assert.notEqual(run.code, 0, 'Restoring attempted must fail the actual retained Region consumer')
    for (const trigger of ['visible', 'connected']) assert.ok(assertions.some(test => test.fullName.includes('resumes the same original Note after ' + trigger) &&
      test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'The same original Note must detect attempted after ' + trigger)
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The exact old attempted source block must execute')
  } else {
    assert.equal(run.code, 0, run.output); assert.equal(report.numFailedTests, 0); assert.equal(report.numPassedTests, 15)
  }
  runs.push({ label, exitCode: run.code, selected: selected.length, passed: report.numPassedTests, failed: report.numFailedTests,
    evaluations: [...new Map(evaluations.map(row => [JSON.stringify(row), row])).values()], resultSHA256: hash(await readFile(result)) })
  process.stdout.write(JSON.stringify({ label, exitCode: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
for (const [path, original] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, path))), original, 'The evaluated source/harness must remain unchanged: ' + path)
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.region-content-lifecycle.v1',
  scope: 'Actual mounted MobileRegionContent, shared NoteReader and original Survey/FileReadOwner consumers. Stable client original Note/Browser visibility and connection transitions, stale response/error isolation and selected resource costs. DOM/worker fixtures do not replace the final compiled Chrome/Host/Desktop product join.',
  environment: { node: process.versions.node, platform: process.platform, architecture: process.arch }, inputs, runs }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: true, receipt: '.local/state/mobile-independent-host/region-read/receipt.json' }) + '\n')
