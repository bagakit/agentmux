import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const expectedManifestSha256 = 'e71a4bf25a3506d74c35b5c331e8a79d60e52eee5b3f87a8fffea30a7655ce0f'
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
  const manifestPath = join(artifactRoot, 'manifest.json')
  if (await sha256(manifestPath) !== expectedManifestSha256) {
    throw new Error('CtxMux build input manifest digest does not match the pinned consumer contract.')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (
    manifest.schema !== 'ctxmux.local-artifacts.v1' ||
    manifest.source.commit !== 'aaadb6843ae2c8fa71565e2d72ddd4b4c6fede02' ||
    manifest.source.tree !== '1d97495e717cce1c3ac588a3c0712d9555b5c871' ||
    manifest.source.worktree_clean !== true ||
    manifest.product.version !== '0.1.0' ||
    manifest.product.protocol !== 16 ||
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

  // 这四步都是**本机、对固定输入的确定性变换**，所以没有挂钟预算。挂钟预算适合"对端可能永不
  // 回答"的调用；本机 CPU 密集步骤在机器被压满时只是变慢，而按挂钟砍掉它，等于把"慢"变成"坏"。
  //
  // 实测（2026-09-01，负载 ~120，14 核）：解一个 **84KB** 的 tarball 花了 **3 分 42 秒挂钟、
  // 0.01 秒 CPU**——纯调度饥饿，于是被 30 秒的 timeout 用 SIGTERM 砍掉。更糟的是 execFile 的
  // 超时错误**从不说自己是超时**：它报 `Command failed: tar -xzf …`，stderr 空，code=null、
  // signal=SIGTERM。这条误导性错误让同一个 flake 被登记成"handshake 超时"，追了错的位点。
  //
  // 挂钟上限的正当理由是"卡死要看得见"，但这里由外层持有：跑构建的 pnpm / vitest / CI 各有自己的
  // 期限，而一个真卡住的构建本来就表现为迟迟不结束——比一条指错位置的错误好得多。
  await execFileAsync('tar', ['-xzf', archivePath, '-C', buildRoot], {
    cwd: packageRoot,
    maxBuffer: 4 * 1024 * 1024
  })
  await execFileAsync('node', [join(packageRoot, 'scripts/clean-build.mjs')], {
    cwd: packageRoot,
    maxBuffer: 4 * 1024 * 1024
  })
  await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
    cwd: packageRoot,
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
