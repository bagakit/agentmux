import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const buildRoot = join(packageRoot, '.ctxmux-build')
const artifactRoot = join(
  packageRoot,
  'vendor',
  'ctxmux',
  `${process.platform}-${process.arch}`
)

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function verify(path, descriptor, mode) {
  const metadata = await stat(path)
  if (
    !metadata.isFile() ||
    metadata.size !== descriptor.bytes ||
    (metadata.mode & 0o777) !== mode ||
    await sha256(path) !== descriptor.sha256
  ) {
    throw new Error(`CtxMux build input does not match its manifest: ${path}`)
  }
}

await rm(buildRoot, { recursive: true, force: true })
await mkdir(buildRoot, { recursive: true })
try {
  const manifest = JSON.parse(await readFile(join(artifactRoot, 'manifest.json'), 'utf8'))
  if (
    manifest.schema !== 'ctxmux.local-artifacts.v1' ||
    manifest.source.commit !== '3b94288c3a7896bb355e028135409c8e8bbaf764' ||
    manifest.source.worktree_clean !== true ||
    manifest.product.version !== '0.1.0' ||
    manifest.product.protocol !== 9 ||
    manifest.support.platform !== process.platform ||
    manifest.support.architecture !== process.arch ||
    manifest.support.transport !== 'unix'
  ) {
    throw new Error('CtxMux build input manifest does not match the pinned consumer contract.')
  }
  const archivePath = join(artifactRoot, manifest.sdk.archive.path)
  await verify(archivePath, manifest.sdk.archive, 0o644)
  for (const binary of manifest.binaries) {
    await verify(join(artifactRoot, binary.path), binary, 0o755)
  }

  await execFileAsync('tar', ['-xzf', archivePath, '-C', buildRoot], {
    cwd: packageRoot,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  })
  await execFileAsync('node', [join(packageRoot, 'scripts/clean-build.mjs')], {
    cwd: packageRoot,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  })
  await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
    cwd: packageRoot,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const bundledAdapter = join(buildRoot, 'ctxmux-run-adapter.js')
  await execFileAsync('pnpm', [
    'exec',
    'esbuild',
    join(packageRoot, 'dist/ctxmux-run-adapter.js'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    `--alias:@ctxmux/sdk=${join(buildRoot, 'package/dist/index.js')}`,
    '--external:./errors.js',
    `--outfile=${bundledAdapter}`
  ], {
    cwd: workspaceRoot,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  })
  await rename(bundledAdapter, join(packageRoot, 'dist/ctxmux-run-adapter.js'))
  await chmod(join(packageRoot, 'dist/ctxmux-run-adapter.js'), 0o644)
  await cp(
    join(artifactRoot, 'manifest.json'),
    join(packageRoot, 'dist/ctxmux-artifact-manifest.json')
  )
} finally {
  await rm(buildRoot, { recursive: true, force: true })
}
