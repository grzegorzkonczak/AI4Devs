import fs from 'fs/promises'
import path from 'path'
import { glob } from 'glob'

// ─── Security ────────────────────────────────────────────────────────────────

// Resolves and validates that `target` is inside one of the allowed directories.
// Throws if access would escape the sandbox.
export function validatePath(target, allowedDirs) {
  const resolved = path.resolve(target)
  const allowed = allowedDirs.some(dir => {
    const resolvedDir = path.resolve(dir)
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep)
  })
  if (!allowed) {
    throw new Error(`Access denied: "${resolved}" is outside allowed directories`)
  }
  return resolved
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BINARY_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'svg',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'pdf'
])

const MIME_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'video/mp4', pdf: 'application/pdf'
}

function isBinary(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function getMime(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── fs_search ────────────────────────────────────────────────────────────────

async function buildTree(dirPath, excludePatterns = []) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name)
    if (excludePatterns.some(p => entry.name.includes(p))) continue
    if (entry.isDirectory()) {
      result.push({ name: entry.name, type: 'directory', children: await buildTree(full, excludePatterns) })
    } else {
      result.push({ name: entry.name, type: 'file' })
    }
  }
  return result
}

export async function fsSearch({ action, path: targetPath, pattern, excludePatterns = [], withSizes = false, sortBy = 'name' }, allowedDirs) {
  switch (action) {

    case 'allowed':
      return `Allowed directories:\n${allowedDirs.map(d => `  ${path.resolve(d)}`).join('\n')}`

    case 'files': {
      const dir = validatePath(targetPath, allowedDirs)
      const matches = await glob(pattern || '**/*', {
        cwd: dir,
        ignore: excludePatterns,
        absolute: true,
        nodir: false
      })
      return matches.length ? matches.join('\n') : 'No files matched the pattern'
    }

    case 'tree': {
      const dir = validatePath(targetPath, allowedDirs)
      const tree = await buildTree(dir, excludePatterns)
      return JSON.stringify(tree, null, 2)
    }

    case 'list': {
      const dir = validatePath(targetPath, allowedDirs)
      const entries = await fs.readdir(dir, { withFileTypes: true })

      if (!withSizes) {
        return entries.map(e => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`).join('\n')
      }

      const details = await Promise.all(entries.map(async e => {
        const full = path.join(dir, e.name)
        const stat = await fs.stat(full)
        return { name: e.name, isDir: e.isDirectory(), size: stat.size }
      }))

      if (sortBy === 'size') details.sort((a, b) => b.size - a.size)
      else details.sort((a, b) => a.name.localeCompare(b.name))

      const totalFiles = details.filter(e => !e.isDir).length
      const totalDirs = details.filter(e => e.isDir).length
      const totalSize = details.filter(e => !e.isDir).reduce((sum, e) => sum + e.size, 0)
      const rows = details.map(e => `${e.isDir ? '[DIR] ' : '[FILE]'} ${e.name.padEnd(40)} ${e.isDir ? '' : formatBytes(e.size)}`)

      return [...rows, '', `Total: ${totalFiles} files, ${totalDirs} dirs, ${formatBytes(totalSize)}`].join('\n')
    }

    case 'info': {
      const file = validatePath(targetPath, allowedDirs)
      const stat = await fs.stat(file)
      return JSON.stringify({
        path: file,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: formatBytes(stat.size),
        sizeBytes: stat.size,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        accessed: stat.atime.toISOString(),
        permissions: stat.mode.toString(8).slice(-3)
      }, null, 2)
    }

    default:
      throw new Error(`Unknown action: "${action}". Use: files, tree, list, info, allowed`)
  }
}

// ─── fs_read ──────────────────────────────────────────────────────────────────

async function readSingleFile(filePath, allowedDirs, head, tail) {
  const resolved = validatePath(filePath, allowedDirs)

  if (isBinary(resolved)) {
    const data = await fs.readFile(resolved)
    return { path: resolved, type: 'binary', mimeType: getMime(resolved), base64: data.toString('base64') }
  }

  const content = await fs.readFile(resolved, 'utf8')

  if (head !== undefined || tail !== undefined) {
    const lines = content.split('\n')
    if (head !== undefined && tail !== undefined) throw new Error('Cannot specify both head and tail')
    const sliced = head !== undefined ? lines.slice(0, head) : lines.slice(-tail)
    return { path: resolved, type: 'text', content: sliced.join('\n') }
  }

  return { path: resolved, type: 'text', content }
}

export async function fsRead({ path: filePath, head, tail }, allowedDirs) {
  if (Array.isArray(filePath)) {
    const results = await Promise.allSettled(
      filePath.map(p => readSingleFile(p, allowedDirs, head, tail))
    )
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { path: filePath[i], error: r.reason.message }
    )
  }
  return readSingleFile(filePath, allowedDirs, head, tail)
}

// ─── fs_write ─────────────────────────────────────────────────────────────────

function applyEdits(original, edits) {
  let result = original
  const applied = []
  for (const { oldText, newText } of edits) {
    const idx = result.indexOf(oldText)
    if (idx === -1) {
      applied.push({ oldText, newText, status: 'NOT_FOUND' })
      continue
    }
    result = result.slice(0, idx) + newText + result.slice(idx + oldText.length)
    applied.push({ oldText, newText, status: 'APPLIED' })
  }
  return { result, applied }
}

function simpleDiff(original, updated) {
  const oldLines = original.split('\n')
  const newLines = updated.split('\n')
  const lines = []
  const max = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (oldLines[i] !== undefined) lines.push(`- ${oldLines[i]}`)
      if (newLines[i] !== undefined) lines.push(`+ ${newLines[i]}`)
    }
  }
  return lines.join('\n') || '(no changes)'
}

export async function fsWrite({ path: filePath, mode, content, edits, dryRun = false }, allowedDirs) {
  const resolved = validatePath(filePath, allowedDirs)

  if (mode === 'overwrite') {
    await fs.writeFile(resolved, content, 'utf8')
    return `File written: ${resolved}`
  }

  if (mode === 'edit') {
    let original
    try {
      original = await fs.readFile(resolved, 'utf8')
    } catch {
      throw new Error(`Cannot edit: file not found at "${resolved}"`)
    }

    const { result, applied } = applyEdits(original, edits)

    if (dryRun) {
      return JSON.stringify({ dryRun: true, appliedEdits: applied, diff: simpleDiff(original, result) }, null, 2)
    }

    const failed = applied.filter(e => e.status === 'NOT_FOUND')
    if (failed.length) throw new Error(`Edit failed — text not found: "${failed[0].oldText}"`)

    await fs.writeFile(resolved, result, 'utf8')
    return JSON.stringify({ applied, message: `File edited: ${resolved}` }, null, 2)
  }

  throw new Error(`Unknown mode: "${mode}". Use: overwrite, edit`)
}

// ─── fs_manage ────────────────────────────────────────────────────────────────

export async function fsManage({ action, path: targetPath, destination }, allowedDirs) {
  switch (action) {

    case 'mkdir': {
      const dir = validatePath(targetPath, allowedDirs)
      await fs.mkdir(dir, { recursive: true })
      return `Directory created (or already exists): ${dir}`
    }

    case 'move': {
      if (!destination) throw new Error('"destination" is required for move action')
      const src = validatePath(targetPath, allowedDirs)
      const dst = validatePath(destination, allowedDirs)
      await fs.rename(src, dst)
      return `Moved: ${src} → ${dst}`
    }

    default:
      throw new Error(`Unknown action: "${action}". Use: mkdir, move`)
  }
}
