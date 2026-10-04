// Derive every brand bitmap from a single source. The repository tracks only
// `apps/desktop/brand/icon-source.png`; the three consumer files under
// `apps/desktop/resources/` are regenerated on every run so the AppKit shell
// icon, the Electron dock icon and the renderer's `BrandIcon` can never drift
// into three different pictures. The hook is wired to `predev`/`prebuild`;
// `scripts/package-macos.mjs` and `src/main/index.ts` keep reading the same
// consumer paths they always did.
//
// macOS only: `sips` and `iconutil` ship with the OS and the packaging path is
// already macOS-only. The script does not emit a manifest, receipt, or any
// time-stamped artefact — the derived files themselves are the output.
import { mkdir, rm, cp, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const sourceIcon = join(desktopRoot, 'brand', 'icon-source.png')
const resourcesDir = join(desktopRoot, 'resources')
const outDockIcon = join(resourcesDir, 'icon.png')
const outRendererIcon = join(resourcesDir, 'icon-128.png')
const outShellIcon = join(resourcesDir, 'icon.icns')
const iconsetDir = join(repositoryRoot, '.tmp', 'brand-iconset', 'agentmux.iconset')

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

async function ensureSourcePresent() {
  try { await access(sourceIcon, fsConstants.R_OK) }
  catch {
    const rel = relative(repositoryRoot, sourceIcon)
    throw new Error(`Brand source icon missing at ${rel}. Place the authoritative 1024x1024 transparent PNG there before building.`)
  }
}

async function resizeTo(size, outPath) {
  await run('sips', ['-s', 'format', 'png', '-z', String(size), String(size), sourceIcon, '--out', outPath])
}

async function buildIcns() {
  await rm(iconsetDir, { recursive: true, force: true })
  await mkdir(iconsetDir, { recursive: true })
  // The pairs are what `iconutil` requires: a filename and the pixel size to
  // produce at. Everything else is drift.
  const pairs = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ]
  for (const [filename, size] of pairs) {
    await resizeTo(size, join(iconsetDir, filename))
  }
  await run('iconutil', ['-c', 'icns', '-o', outShellIcon, iconsetDir])
  await rm(iconsetDir, { recursive: true, force: true })
}

async function main() {
  await ensureSourcePresent()
  await mkdir(resourcesDir, { recursive: true })
  // Dock icon is the source itself — same bitmap, no resample, no quality loss.
  await cp(sourceIcon, outDockIcon)
  await resizeTo(128, outRendererIcon)
  await buildIcns()
  const relSource = relative(desktopRoot, sourceIcon)
  const relResources = relative(desktopRoot, resourcesDir)
  process.stdout.write(`brand assets derived from ${relSource} -> ${relResources}/{icon.png, icon-128.png, icon.icns}\n`)
}

main().catch((error) => {
  process.stderr.write(`build-brand-assets failed: ${error.message}\n`)
  process.exit(1)
})
