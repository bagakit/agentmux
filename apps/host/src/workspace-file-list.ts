/** Runs only inside the existing pinned-cwd WorkspaceFiles worker. Never reads file bodies. */
export const LOCAL_FILE_LIST_SOURCE = String.raw`
async function listFileNames(limit) {
  const maximumBytes = 2 * 1024 * 1024
  const deadline = Date.now() + 5000
  let git = false
  try { git = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 }).trim() === 'true' }
  catch (error) { if (error.code !== 'ENOENT' && error.status !== 128) throw error }
  const command = git ? 'git' : 'find'
  const args = git ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--', '.']
    : ['-P', '.', '-name', '.git', '-prune', '-o', '(', '-type', 'f', '-o', '-type', 'l', ')', '-print0']
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  let bytes = 0, stderr = '', partialReason = null
  const stop = reason => { if (!partialReason) partialReason = reason; child.kill('SIGTERM') }
  const timer = setTimeout(() => stop('budget'), Math.max(0, deadline - Date.now()))
  const result = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      const remaining = maximumBytes - bytes
      if (remaining > 0) { const accepted = chunk.subarray(0, remaining); chunks.push(accepted); bytes += accepted.length }
      if (chunk.length > remaining) stop('budget')
    })
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length) })
    child.once('error', reject)
    child.once('close', code => resolve(code))
  }).finally(() => clearTimeout(timer))
  if (result !== 0 && !partialReason) throw new Error(stderr.trim() || 'File name discovery failed')
  const raw = Buffer.concat(chunks).toString('utf8'), records = raw.split('\0')
  // The final unterminated record from a bounded stream is never a filename.
  if (records.pop() !== '') partialReason = partialReason || 'budget'
  const files = [], seen = new Set()
  let visited = 0
  for (let name of records) {
    if (++visited > 40000 || Date.now() >= deadline) { partialReason = partialReason || 'budget'; break }
    if (name.startsWith('./')) name = name.slice(2)
    if (!name || name.length > 16384 || /[\0\r\n\\]/u.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) {
      partialReason = partialReason || 'unreadable'; continue
    }
    if (seen.has(name)) continue
    try {
      const metadata = await lstat(name)
      // Directory links are searchable through the existing Explorer, never recursively followed here.
      if (!(metadata.isFile() || metadata.isSymbolicLink() && (await stat(name)).isFile())) continue
    } catch (error) {
      if (error.code !== 'ENOENT') partialReason = partialReason || 'unreadable'
      continue
    }
    if (files.length === limit) { partialReason = partialReason || 'limit'; break }
    seen.add(name); files.push(name)
  }
  return { status: 'listed', files, complete: partialReason === null, omitted: git ? 'git-ignored' : 'none', partialReason }
}
`
