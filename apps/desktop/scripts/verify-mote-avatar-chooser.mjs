import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

let activeRestore = null
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => {
    if (activeRestore) {
      const { path, content } = activeRestore
      activeRestore = null
      writeFileSync(path, content)
    }
  })
}

function run(argv) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { out += chunk })
    child.on('error', rejectPromise)
    child.on('close', code => resolvePromise({ code: code ?? 1, out }))
  })
}

// 1. Verify CSS scale, token and class-definition contracts on modified style sheets
const cssPath = resolve(root, 'apps/desktop/src/renderer/src/styles/space-object-appearance.css')
const seriesCssPath = resolve(root, 'apps/desktop/src/renderer/src/styles/mote-avatar-series.css')
const cssText = (await readFile(cssPath, 'utf8')) + '\n' + (await readFile(seriesCssPath, 'utf8'))
const cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
assert.ok((await readFile(cssPath, 'utf8')).split('\n').length < 400, 'space-object-appearance.css must remain under 400 lines')
assert.ok((await readFile(seriesCssPath, 'utf8')).split('\n').length < 400, 'mote-avatar-series.css must remain under 400 lines')

for (const match of cleanCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = match[1].trim()
  if (selector.startsWith('@')) continue
  const body = match[2]
  for (const decl of body.matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/g)) {
    assert.doesNotMatch(decl[1], /\d+px\b/, `Font size must use token in ${selector}: ${decl[1]}`)
  }
  const scrubbed = body.replace(/color-mix\((?:[^()]|\([^()]*\))*\)/g, m => m.replace(/#(?:fff|ffffff|000|000000)\b/gi, 'mix-base'))
  assert.doesNotMatch(scrubbed, /#[0-9a-fA-F]{3,8}\b|\brgba?\(/i, `Color literal forbidden in ${selector}`)
}

const definedClasses = new Set([...cleanCss.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(m => m[1]))
for (const baseClass of ['dialog-scrim', 'dialog-surface', 'small-button', 'primary-button', 'icon-button', 'project-rail-row__icon', 'mote-companion']) definedClasses.add(baseClass)
for (const rel of [
  'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx',
  'apps/desktop/src/renderer/src/components/MoteFaceEditor.tsx',
  'apps/desktop/src/renderer/src/components/MoteAvatarImageGallery.tsx',
  'apps/desktop/src/renderer/src/components/MoteAvatarCrop.tsx',
  'apps/desktop/src/renderer/src/components/MoteSilhouetteArt.tsx'
]) {
  const src = (await readFile(resolve(root, rel), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  for (const m of src.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
    for (const token of raw.split(/\s+/).filter(Boolean)) {
      if (token.includes('__') || token.includes('--') || token.endsWith('-button')) {
        assert.ok(definedClasses.has(token), `Missing CSS rule for rendered class ${token} in ${rel}`)
      }
    }
  }
}

// 2. Run real consumer unit tests
const vitestCmd = ['node_modules/vitest/vitest.mjs', 'run', 'apps/desktop/test/mote-silhouette-images.test.ts', 'apps/desktop/test/space-object-avatar-picker-durable.test.tsx', 'apps/desktop/test/mote-paperdoll-avatar.test.tsx']
const baseline = await run(vitestCmd)
assert.equal(baseline.code, 0, baseline.out.slice(-2500))

// 3. Run non-empty production source mutations (RED on mutant, GREEN on restore)
const mutations = [
  {
    id: 'wrong-initial-tab-order',
    file: 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx',
    from: "setMode(unresolved || target?.avatarTarget && series ? 'series' : target?.avatarTarget && isMoteFace(saved) ? 'face' : 'alternative')",
    to: "setMode('face')",
    test: 'apps/desktop/test/space-object-avatar-picker-durable.test.tsx',
    pattern: 'reopens saved automatic'
  },
  {
    id: 'restore-automatic-forces-tab-jump',
    file: 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx',
    from: "onClick={() => { select(null); if (editingSeries) setMode('alternative') }}",
    to: "onClick={() => { select(null); setMode('alternative') }}",
    test: 'apps/desktop/test/mote-paperdoll-avatar.test.tsx',
    pattern: 'renders focused part glyphs'
  },
  {
    id: 'part-glyph-disconnected',
    file: 'apps/desktop/src/renderer/src/components/MoteFaceEditor.tsx',
    from: "face[part] ?? 'none') === value ? ' small-button--active' : ''",
    to: "false ? ' small-button--active' : ''",
    test: 'apps/desktop/test/mote-paperdoll-avatar.test.tsx',
    pattern: 'the actual face editor paints'
  },
  {
    id: 'silhouette-drops-to-static-png',
    file: 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx',
    from: 'isBuiltinMoteSilhouetteLocator(manualIcon.source)',
    to: 'false',
    test: 'apps/desktop/test/mote-paperdoll-avatar.test.tsx',
    pattern: 'saving a Mote silhouette preserves live articulated expressions'
  }
]

for (const mutant of mutations) {
  const fullPath = resolve(root, mutant.file)
  const original = readFileSync(fullPath, 'utf8')
  const originalSha = sha(original)
  assert.ok(original.includes(mutant.from), `Mutation anchor missing for ${mutant.id}`)
  const mutated = original.replace(mutant.from, mutant.to)
  assert.notEqual(mutated, original)
  activeRestore = { path: fullPath, content: original }
  try {
    writeFileSync(fullPath, mutated)
    const red = await run(['node_modules/vitest/vitest.mjs', 'run', mutant.test, '-t', mutant.pattern])
    assert.notEqual(red.code, 0, `Mutant ${mutant.id} must fail`)
  } finally {
    writeFileSync(fullPath, original)
    activeRestore = null
  }
  assert.equal(sha(readFileSync(fullPath, 'utf8')), originalSha, `Source restored for ${mutant.id}`)
}

const restored = await run(vitestCmd)
assert.equal(restored.code, 0, restored.out.slice(-2500))
console.log(JSON.stringify({ ok: true, tests: 3, mutationsKilled: mutations.map(m => m.id) }))
