import { tmpdir as upstreamFixtureTmpdir } from 'node:os'
import { join as upstreamFixtureJoin, parse as upstreamFixtureParse, sep as upstreamFixtureSep } from 'node:path'
import { pathToFileURL as upstreamFixturePathToFileURL } from 'node:url'
const upstreamFixtureRoot = upstreamFixtureJoin(upstreamFixtureTmpdir(), 'agentmux-fixtures');
const upstreamFixtureDayMilliseconds = 24 * 60 * 60 * 1_000;
/** Preserve lexical path cases while deriving the absolute root from this Host. */
function upstreamFixturePath(relative) {
    const temporary = relative.replace(/^(?:private\/)?tmp\//u, '');
    const base = temporary === relative ? upstreamFixtureRoot : upstreamFixtureTmpdir();
    return base + upstreamFixtureSep + temporary.replaceAll('/', upstreamFixtureSep);
}
/** Deterministic time from Unix zero and explicit relative units. */
function upstreamFixtureEpoch(days, seconds = 0, milliseconds = 0) {
    return days * upstreamFixtureDayMilliseconds + seconds * 1_000 + milliseconds;
}
function upstreamFixtureDay(days, separator = '-') {
    return new Date(upstreamFixtureEpoch(days)).toISOString().slice(0, 10).replaceAll('-', separator);
}
function upstreamFixtureClock(hour, minute, second, milliseconds) {
    const units = second === undefined ? [hour, minute] : [hour, minute, second];
    const clock = units.map(value => String(value).padStart(2, '0')).upstreamFixtureJoin(':');
    return milliseconds === undefined ? clock : clock + '.' + milliseconds;
}
function upstreamFixtureFileUrl(relative) {
    return upstreamFixturePathToFileURL(upstreamFixturePath(relative)).href;
}
/** A short Host-rooted display path keeps captured terminal rows within their viewport. */
function upstreamFixtureDisplayPath(relative) {
    return upstreamFixtureJoin(upstreamFixtureParse(upstreamFixtureTmpdir()).root, relative);
}
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import contract from '../src/ctxmux-artifact-contract.json' with { type: 'json' }

const execFileAsync = promisify(execFile)
const writeRemote = async (arguments_, bytes) => await new Promise((done, reject) => {
  const child = execFile('ssh', arguments_, { maxBuffer: 2 * 1024 * 1024 }, error => error ? reject(error) : done())
  child.stdin.end(bytes)
})
const argument = process.argv.indexOf('--input')
assert(argument > -1 && process.argv[argument + 1], 'Use --input with an explicit private Farm input file.')
const input = JSON.parse(await readFile(resolve(process.argv[argument + 1]), 'utf8'))
assert.equal(input.schema, 'agentmux.linux-package-qualification.v1')
assert(typeof input.host === 'string' && input.host.length > 0 && !input.host.startsWith('-'))
for (const key of ['scopeRoot', 'nodePath', 'consumerDirectory', 'providerSeed', 'receiptDirectory', 'coreArchivePath', 'demandArchivePath']) {
  assert(typeof input[key] === 'string' && isAbsolute(input[key]), `${key} must be explicit and absolute.`)
}
assert(input.scopeRoot.startsWith(upstreamFixturePath("tmp/amx-linux-q-")), 'Qualification requires its own known private scope.')
assert(input.consumerDirectory.startsWith(`${input.scopeRoot}/`))
assert(input.providerSeed.startsWith(`${input.scopeRoot}/`))
assert(input.coreArchiveSha256 && input.demandArchiveSha256, 'Bind installed input archives, not just their names.')
assert(input.coreArchivePath.startsWith(`${input.scopeRoot}/`) && input.demandArchivePath.startsWith(`${input.scopeRoot}/`))
assert(typeof input.packageSourceSha256 === 'string' && input.compiledCoreHashes && Object.keys(input.compiledCoreHashes).length > 0)
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
await mkdir(input.receiptDirectory, { recursive: true })

// Input paths identify an already prepared isolated installation. Connection never deploys.
// The remote consumer is copied as a test artifact and imports only the installed public package.
const fixture = new URL('./fixtures/linux-package-consumer.mjs', import.meta.url)
const bytes = await readFile(fixture)
const fixtureSha256 = createHash('sha256').update(bytes).digest('hex')
const fixturePath = join(input.consumerDirectory, 'linux-package-consumer.mjs')
await writeRemote(['-o', 'BatchMode=yes', '--', input.host, `cat > ${quote(fixturePath)}`], bytes)
const remoteInput = {
  host: input.host,
  retainForFederation: Boolean(input.retainForFederation),
  scopeRoot: input.scopeRoot,
  consumerDirectory: input.consumerDirectory,
  providerSeed: input.providerSeed,
  providerCommand: input.providerCommand,
  source: contract.source,
  protocol: contract.protocol,
  manifestSha256: contract.manifests['linux-x64'],
  fixtureSha256,
  coreArchiveSha256: input.coreArchiveSha256,
  coreArchivePath: input.coreArchivePath,
  demandArchivePath: input.demandArchivePath,
  packageSourceSha256: input.packageSourceSha256,
  compiledCoreHashes: input.compiledCoreHashes,
  demandArchiveSha256: input.demandArchiveSha256
}
const remoteInputPath = join(input.consumerDirectory, 'linux-package-input.json')
await writeRemote(['-o', 'BatchMode=yes', '--', input.host, `cat > ${quote(remoteInputPath)}`], JSON.stringify(remoteInput))
let result
try {
  result = await execFileAsync('ssh', ['-o', 'BatchMode=yes', '--', input.host,
    `cd ${quote(input.consumerDirectory)} && ${quote(input.nodePath)} ${quote(fixturePath)} ${quote(remoteInputPath)}`],
  { maxBuffer: 4 * 1024 * 1024 })
} catch (error) {
  // The fixture emits a bounded credential-free receipt before returning a failure.
  await writeFile(join(input.receiptDirectory, 'linux-package-failed.json'), JSON.stringify({
    status: 'failed', host: input.host, fixtureSha256,
    stdout: error.stdout ?? '', stderr: error.stderr ?? '', message: error.message
  }, null, 2) + '\n')
  throw error
}
const receipt = JSON.parse(result.stdout.trim())
assert.equal(receipt.status, 'qualified')
assert.equal(receipt.platform, 'linux-x64')
assert.equal(receipt.ctxmuxSource.commit, contract.source.commit)
assert.equal(receipt.protocol, contract.protocol)
assert.equal(receipt.coreArchiveSha256, input.coreArchiveSha256)
assert.equal(receipt.packageSourceSha256, input.packageSourceSha256)
assert.equal(receipt.demandArchiveSha256, input.demandArchiveSha256)
assert(receipt.rawBytes && receipt.providerHook && receipt.providerPermission && receipt.sameSessionResume)
assert(receipt.ordinaryClientRestart && receipt.originalRunSurvived)
assert(receipt.cleanedOwnedRuns || receipt.retainedForFederation && receipt.prerequisiteRunsStopped && receipt.handoffPath)
await writeFile(join(input.receiptDirectory, 'linux-package-qualified.json'), JSON.stringify({
  ...receipt, host: input.host, fixtureSha256
}, null, 2) + '\n')
console.log(JSON.stringify({ status: receipt.status, receipt: join(input.receiptDirectory, 'linux-package-qualified.json') }))
