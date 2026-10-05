import { writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'

/** Both packaged entry locations resolve the same embedded runtime and dispatcher. */
export async function writeEmbeddedCoreCli(launcherPath, executablePath, dispatcherPath) {
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const from = dirname(launcherPath)
  await writeFile(launcherPath, [
    '#!/bin/sh',
    'set -eu',
    'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    'export ELECTRON_RUN_AS_NODE=1',
    `exec "$launcher_dir"/${quote(relative(from, executablePath))} "$launcher_dir"/${quote(relative(from, dispatcherPath))} "$@"`
  ].join('\n') + '\n', { mode: 0o755 })
}
