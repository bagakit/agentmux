import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const root = path.resolve(import.meta.dirname, '../../../../..'),
  fixture = import.meta.dirname,
  proof = process.env.QUESTION_UI_PROOF ?? path.resolve(root, '..', 'visual'),
  out = path.join(proof, 'compiled'),
  scene = path.resolve(root, '..', 'visual-inputs/public-scene.json');
const require = createRequire(path.join(root, 'apps/desktop/package.json')),
  {
    build
  } = createRequire(require.resolve('vite'))('esbuild'),
  loaded = [],
  sha = data => createHash('sha256').update(data).digest('hex');
await fs.mkdir(out, {
  recursive: true
});
const compiled = await build({
  absWorkingDir: root,
  entryPoints: [path.join(fixture, 'entry.tsx')],
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  jsx: 'automatic',
  metafile: true,
  logLevel: 'error',
  define: {
    __AGENTMUX_WEB_PREVIEW__: 'true',
    'process.env.NODE_ENV': '"production"'
  },
  loader: {
    '.woff2': 'file',
    '.woff': 'file',
    '.ttf': 'file',
    '.svg': 'file',
    '.png': 'file'
  },
  plugins: [{
    name: 'actual-question-input',
    setup(build) {
      build.onLoad({
        filter: /\.[cm]?[jt]sx?$|\.css$/
      }, async args => {
        if (!args.path.startsWith(root + '/apps/desktop/src/') && !args.path.startsWith(root + '/packages/client-ui/src/') && !args.path.startsWith(root + '/packages/core/dist/') && !args.path.startsWith(fixture + '/')) return;
        const code = await fs.readFile(args.path, 'utf8');
        loaded.push({
          path: path.relative(root, args.path),
          bytes: Buffer.byteLength(code),
          sha256: sha(code)
        });
        return {
          contents: code,
          loader: path.extname(args.path) === '.css' ? 'css' : path.extname(args.path) === '.tsx' ? 'tsx' : path.extname(args.path) === '.ts' ? 'ts' : 'js',
          resolveDir: path.dirname(args.path)
        };
      });
    }
  }]
});
await fs.copyFile(path.join(fixture, 'index.html'), path.join(out, 'index.html'));
await fs.copyFile(scene, path.join(out, 'public-scene.json'));
const assets = Object.fromEntries(await Promise.all((await fs.readdir(out)).map(async name => [name, sha(await fs.readFile(path.join(out, name)))])));
await fs.writeFile(path.join(proof, 'compiled-inputs.json'), JSON.stringify({
  loaded,
  metafile: compiled.metafile,
  assets,
  sceneSHA256: sha(await fs.readFile(scene)),
  boundary: 'actual shared question/current Activity/History/presentation and product CSS; scene from public Core/private FileStore/controlled native app-server; reply transport controlled, real acceptance qualified by owning separately; no vendor writer, installed App or user Run'
}, null, 2));
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (name.includes('..')) throw Error('Invalid path');
    const data = await fs.readFile(path.join(out, name));
    res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  fs.writeFile(path.join(proof, 'server.json'), JSON.stringify({
    url,
    pid: process.pid
  }));
  console.log(JSON.stringify({
    url,
    pid: process.pid,
    loaded: loaded.length
  }));
});
