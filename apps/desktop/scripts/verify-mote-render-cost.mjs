import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess } from './probe-process.mjs'
import { build } from 'vite'
const desktop = resolve(import.meta.dirname, '..'),
  repository = resolve(desktop, '../..'),
  require = createRequire(join(desktop, 'package.json')),
  ts = require('typescript')
assert.equal(process.argv.length, 2, 'Use node apps/desktop/scripts/verify-mote-render-cost.mjs')
const fixture = join(desktop, 'scripts/fixtures/mote-render-cost'),
  evidence =
    process.env.AGENTMUX_MOTE_COST_EVIDENCE ??
    join(repository, '.local/state/mote-render-cost', globalThis.crypto.randomUUID())
await mkdir(evidence, { recursive: true })
const hash = (b) => createHash('sha256').update(b).digest('hex'),
  owner = 'packages/client-ui/src/components/MoteFace.tsx',
  aliases = []
for (const name of ['core', 'demand', 'layout', 'identity']) {
  const manifest = JSON.parse(await readFile(join(repository, 'packages', name, 'package.json')))
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
    aliases.push({
      find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
      replacement: join(
        repository,
        'packages',
        name,
        target.import
          .replace('./dist/', ['core', 'identity'].includes(name) ? './src/' : './')
          .replace(/\.js$/, '.ts')
      )
    })
  }
}
const original = await readFile(join(repository, owner), 'utf8')
function directSvgMutation(source) {
  const ast = ts.createSourceFile(owner, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    replacements = []
  const bodies = {
    Articulation: '{ return <g>{children}</g> }',
    Bone: '{ return <g className={className} style={{ transformBox: "view-box", transformOrigin: `${origin[0]}px ${origin[1]}px` }}>{children}</g> }',
    Drawing: '{ return <g {...paint}>{children}</g> }'
  }
  for (const statement of ast.statements)
    if (ts.isFunctionDeclaration(statement) && statement.name && bodies[statement.name.text]) {
      assert.ok(statement.body)
      replacements.push({
        name: statement.name.text,
        start: statement.body.getStart(ast),
        end: statement.body.end,
        text: bodies[statement.name.text]
      })
    }
  assert.deepEqual(
    replacements.map((r) => r.name).sort(),
    Object.keys(bodies).sort(),
    'Real production articulation/drawing/bone mutation is nonempty'
  )
  let mutated = source
  for (const r of replacements.sort((a, b) => b.start - a.start))
    mutated = mutated.slice(0, r.start) + r.text + mutated.slice(r.end)
  assert.notEqual(mutated, source)
  return { source: mutated, helpers: replacements.map((r) => r.name) }
}
const mutant = directSvgMutation(original),
  receipts = [],
  privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-cost-'))
async function runMode(mode, referenceFile) {
  const root = join(evidence, mode),
    renderer = join(root, 'renderer'),
    inputs = new Map(),
    styles = new Map()
  await mkdir(root, { recursive: true })
  await build({
    configFile: false,
    root: fixture,
    base: './',
    logLevel: 'error',
    resolve: { alias: aliases },
    worker: { format: 'es' },
    css: {
      postcss: {
        plugins: [
          {
            postcssPlugin: 'bind-mote-render-styles',
            async Once(root) {
              const consumed = new Map(),
                remember = (n) => {
                  const i = n.source?.input
                  if (i?.file?.startsWith(repository + '/') && !i.file.includes('/node_modules/'))
                    consumed.set(i.file, i.css)
                }
              remember(root)
              root.walk(remember)
              for (const [file, css] of consumed) {
                assert.equal(hash(await readFile(file)), hash(css))
                styles.set(relative(repository, file), hash(css))
                inputs.set(relative(repository, file), hash(css))
              }
            }
          }
        ]
      }
    },
    esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'bind-native-mote-cost-inputs',
        enforce: 'pre',
        async load(id) {
          const file = id.split('?')[0]
          if (file.startsWith(repository + '/') && !file.includes('/node_modules/') && !id.includes('?'))
            inputs.set(relative(repository, file), hash(await readFile(file)))
          if (mode === 'direct-svg' && file === join(repository, owner)) return mutant.source
          return null
        }
      }
    ],
    build: { target: 'esnext', outDir: renderer, emptyOutDir: true, minify: false }
  })
  for (const file of [
    'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx',
    'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx',
    owner,
    'packages/client-ui/src/lib/mote-face-motion.ts',
    'packages/client-ui/src/styles/mote-identity.css'
  ])
    assert.ok(inputs.has(file), 'Real production consumer compiled: ' + file)
  assert.ok(styles.has('packages/client-ui/src/styles/mote-identity.css'))
  assert.ok([...inputs.keys()].some((f) => f.includes('mote-render-cost/entry.tsx')))
  for (const file of [
    'apps/desktop/scripts/verify-mote-render-cost.mjs',
    'apps/desktop/scripts/fixtures/mote-render-cost/main.cjs',
    'apps/desktop/scripts/probe-process.mjs'
  ])
    inputs.set(file, hash(await readFile(join(repository, file))))
  await writeFile(
    join(root, 'inputs.json'),
    JSON.stringify(
      {
        inputs: Object.fromEntries(inputs),
        styles: Object.fromEntries(styles),
        electron: require('electron/package.json').version,
        mutation:
          mode === 'direct-svg'
            ? { owner, original: hash(original), mutated: hash(mutant.source), helpers: mutant.helpers }
            : null
      },
      null,
      2
    )
  )
  const binary = process.env.AGENTMUX_ELECTRON_BINARY ?? require('electron'),
    env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let output = ''
  try {
    const processReceipt = await runProbeProcess(
      binary,
      [
        join(fixture, 'main.cjs'),
        join(renderer, 'index.html'),
        join(privateRoot, mode),
        root,
        mode,
        ...(referenceFile ? [referenceFile] : [])
      ],
      {
        cwd: repository,
        env,
        temporaryRoot: privateRoot,
        timeoutMs: 100000,
        onLine: (line) => {
          output += line + '\n'
        }
      }
    )
    await writeFile(join(root, 'native.log'), output)
    await writeFile(join(root, 'cleanup.json'), JSON.stringify(processReceipt))
    const receipt = JSON.parse(await readFile(join(root, 'receipt.json')))
    assert.equal(receipt.versions.electron, require('electron/package.json').version)
    for (const [file, digest] of inputs)
      assert.equal(
        hash(await readFile(join(repository, file))),
        digest,
        'Candidate source unchanged during proof: ' + file
      )
    receipts.push({ mode, exit: processReceipt.exitCode, root, receipt })
    return { exit: processReceipt.exitCode, receipt, root }
  } finally {
    await rm(renderer, { recursive: true, force: true })
  }
}
let passed = false
try {
  const candidate = await runMode('candidate')
  assert.equal(candidate.exit, 0, 'Candidate native proof passes: ' + candidate.receipt.error?.message)
  const direct = await runMode('direct-svg', join(candidate.root, 'receipt.json'))
  assert.notEqual(direct.exit, 0, 'Actual direct-SVG rendering mutation must fail the same cost oracle')
  assert.equal(direct.receipt.error?.code, 'ERR_ASSERTION')
  assert.equal(
    direct.receipt.error?.message,
    'Direct natural render cost exceeds same fixed-relevant-consumer budget'
  )
  assert.equal(
    direct.receipt.cases.length,
    2,
    'Mutant reaches both live full natural-cycle consumers before AssertionRED'
  )
  assert.equal(candidate.receipt.neutral.length, direct.receipt.neutral.length)
  let origins = 0
  for (let i = 0; i < candidate.receipt.neutral.length; i++) {
    const actual = candidate.receipt.neutral[i],
      reference = direct.receipt.neutral[i]
    assert.equal(actual.label, reference.label)
    for (let j = 0; j < actual.bones.length; j++) {
      const a = actual.bones[j],
        b = reference.bones[j]
      assert.equal(a.name, b.name)
      assert.ok(b.bbox, 'Actual SVG reference geometry is nonempty')
      const expected =
          a.name === 'neck' ? [32, 52] : [b.bbox.x + b.bbox.width / 2, b.bbox.y + b.bbox.height / 2],
        point = a.origin.split(/\s+/).map((n) => Number.parseFloat(n))
      assert.equal(point.length, 2)
      assert.ok(
        point.every((n, k) => Number.isFinite(n) && Math.abs(n - expected[k]) < 1e-4),
        'Actual native model origin agrees with SVG reference: ' + actual.label + '/' + a.name
      )
      origins++
    }
  }
  assert.ok(origins > 0)
  await writeFile(
    join(evidence, 'neutral-origin-comparison.json'),
    JSON.stringify({
      passed: true,
      origins,
      tolerance: 1e-4,
      source: hash(original),
      reference:
        'Actual direct-SVG production-source rendering, transformations temporarily disabled outside cost capture'
    })
  )
  passed = true
  console.log(
    JSON.stringify({
      passed: true,
      evidence,
      mutationKilled: 'direct-svg',
      candidateBudget: candidate.receipt.budget,
      candidate: candidate.receipt.cases.map((r) => ({
        scale: r.scale,
        taskMs: r.costs.taskUnionMs,
        layerizeMs: r.costs.statistics.Layerize?.totalMs
      })),
      mutant: direct.receipt.costOracle
    })
  )
} finally {
  await rm(privateRoot, { recursive: true, force: true })
  await writeFile(
    join(evidence, 'verification.json'),
    JSON.stringify(
      {
        passed,
        source: hash(original),
        mutation: hash(mutant.source),
        modes: receipts.map((r) => ({ mode: r.mode, exit: r.exit, root: r.root })),
        ownedPrivateRootRemoved: true
      },
      null,
      2
    )
  )
}
