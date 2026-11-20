import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runProbe = promisify(execFile)

// Keep the native resolver and its package cache in a fresh, bounded Node process.
// Paths from configuration are data. This trusted program only parses module source and
// resolves its static imports. It never links, evaluates, or loads the configured program.
const PROBE = String.raw`
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SourceTextModule } from 'node:vm';

let availableBytes = 4 * 1024 * 1024;
let remainingImports = 512;
async function readRequests(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > availableBytes) return [];
    const bytes = Buffer.allocUnsafe(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    availableBytes -= bytesRead;
    if (bytesRead !== info.size) return [];
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    return new SourceTextModule(source).moduleRequests;
  } finally { await file.close(); }
}

async function hasMissingDependency(runner) {
  const entry = await realpath(runner);
  const imports = await readRequests(entry);
  if (!imports.some(({specifier}) => specifier === '../dist/agent-hook-command.js')) return false;

  const todo = [entry];
  const seen = new Set(todo);
  for (const path of todo) {
    const parent = pathToFileURL(path);
    const requests = path === entry ? imports : await readRequests(path).catch(() => []);
    for (const { specifier } of requests) {
      if (--remainingImports < 0) return false;
      // Historical commands load local Node modules. Custom scheme/loader resolution is unknown.
      if (URL.canParse(specifier) || specifier.startsWith('/')) continue;
      try {
        const href = import.meta.resolve(specifier, parent);
        if (!href.startsWith('file:')) continue;
        const dependency = await realpath(fileURLToPath(href));
        if (/\.m?js$/u.test(dependency) && !seen.has(dependency) && (await stat(dependency)).isFile()) {
          seen.add(dependency);
          todo.push(dependency);
        }
      } catch (error) {
        if (['ERR_MODULE_NOT_FOUND', 'ENOENT', 'ENOTDIR'].includes(error.code)) return true;
      }
    }
  }
  return false;
}

if (await hasMissingDependency(process.argv[1]).catch(() => false)) process.stdout.write('missing');
`

/** A clean or unavailable static probe leaves runtime health and use unconfirmed. */
export async function hasMissingLegacyHookDependency(runner: string): Promise<boolean> {
  try {
    const { stdout } = await runProbe(process.execPath, [
      '--no-warnings', '--experimental-vm-modules', '--experimental-import-meta-resolve', '--input-type=module', '-e', PROBE, '--', runner
    ], {
      // No Hook credentials, user Node options, preloads, or loader hooks cross this boundary.
      env: { ELECTRON_RUN_AS_NODE: '1' },
      // Bound one observation of a possibly inaccessible filesystem. Its result stays unknown.
      timeout: 3_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024
    })
    return stdout === 'missing'
  } catch {
    return false
  }
}
