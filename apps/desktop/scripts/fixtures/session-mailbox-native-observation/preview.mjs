import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
const root = path.resolve(import.meta.dirname, '../../../../..'), fixture = import.meta.dirname
const proof = path.join(root, '.bagakit/feature-tracker/conversation-input-cards-artifacts/T012'), out = path.join(proof, 'compiled')
const require = createRequire(path.join(root, 'apps/desktop/package.json')), { build } = createRequire(require.resolve('vite'))('esbuild')
const loaded = [], hash = data => createHash('sha256').update(data).digest('hex')
await fs.mkdir(out, { recursive: true })
const result = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.tsx')], outdir: out, bundle: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', metafile: true,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' }, logLevel: 'error',
  plugins: [{ name: 'actual-mailbox-inputs', setup(build) { build.onLoad({ filter: /\.[cm]?[jt]sx?$|\.css$/ }, async args => {
    if (!args.path.startsWith(root + '/apps/desktop/src/') && !args.path.startsWith(fixture + '/')) return
    const code = await fs.readFile(args.path, 'utf8'); loaded.push({ path: path.relative(root, args.path), sha256: hash(code), bytes: Buffer.byteLength(code) })
    return { contents: code, loader: path.extname(args.path) === '.css' ? 'css' : path.extname(args.path) === '.tsx' ? 'tsx' : path.extname(args.path) === '.ts' ? 'ts' : 'js', resolveDir: path.dirname(args.path) }
  }) } }] })
await fs.copyFile(path.join(fixture, 'index.html'), path.join(out, 'index.html')); await fs.copyFile(path.join(proof, 'public-reader-pages.json'), path.join(out, 'public-reader-pages.json'))
const assets = Object.fromEntries(await Promise.all((await fs.readdir(out)).map(async file => [file, hash(await fs.readFile(path.join(out, file)))])))
await fs.writeFile(path.join(proof, 'compiled-inputs.json'), JSON.stringify({ loaded, assets, metafile: result.metafile, boundary: 'Actual compiled SessionMailbox and sole shared Hook plus product CSS; actual public Claude/FileStore bounded pages, declared source invalidation/read/observation failure adapter; actual browser native popover; no user App/Run/Runtime.' }, null, 2) + '\n')
const server = createServer(async (request, response) => { try { const url = new URL(request.url, 'http://localhost'), file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); if (file.includes('..')) throw Error('Invalid path'); const bytes = await fs.readFile(path.join(out, file)); response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream'); response.end(bytes) } catch { response.writeHead(404); response.end('Not found') } })
server.listen(0, '127.0.0.1', () => { const url = 'http://127.0.0.1:' + server.address().port + '/'; fs.writeFile(path.join(proof, 'preview-server.json'), JSON.stringify({ pid: process.pid, url, out })); console.log(JSON.stringify({ pid: process.pid, url, loaded: loaded.length })) })
