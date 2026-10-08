// File access with three backends:
//  - Tauri desktop app: native dialogs + real disk paths, read + write in place
//  - File System Access API (Chrome/Edge in a top-level tab): read + write in place
//  - <input webkitdirectory> fallback (every browser): read-only, saves download
import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { join, sep } from '@tauri-apps/api/path'
import { open as openDialog, save as saveDialog, ask } from '@tauri-apps/plugin-dialog'
import { readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

export const isDesktop = isTauri()

export interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'directory'
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle
  osPath?: string // desktop mode: absolute path on disk
  file?: File // fallback mode
  children?: TreeNode[] // fallback mode: prebuilt tree
}

export interface Workspace {
  name: string
  root: TreeNode
  nodes: TreeNode[]
  writable: boolean
  osPath?: string // desktop mode: folder on disk (terminal cwd)
}

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
    showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>
  }
}

// Keep in sync with IGNORED in src-tauri/src/workspace.rs
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'target'])

const sortNodes = (nodes: TreeNode[]) =>
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
  )

async function readDirectory(dir: FileSystemDirectoryHandle, basePath: string): Promise<TreeNode[]> {
  const nodes: TreeNode[] = []
  for await (const handle of dir.values()) {
    if (handle.kind === 'directory' && IGNORED.has(handle.name)) continue
    nodes.push({ name: handle.name, path: `${basePath}/${handle.name}`, kind: handle.kind, handle })
  }
  return sortNodes(nodes)
}

async function readOsDirectory(osPath: string, basePath: string): Promise<TreeNode[]> {
  const nodes: TreeNode[] = []
  for (const entry of await readDir(osPath)) {
    if (entry.isDirectory && IGNORED.has(entry.name)) continue
    if (!entry.isDirectory && !entry.isFile) continue
    nodes.push({
      name: entry.name,
      path: `${basePath}/${entry.name}`,
      kind: entry.isDirectory ? 'directory' : 'file',
      osPath: await join(osPath, entry.name),
    })
  }
  return sortNodes(nodes)
}

/** Children of a directory node, whichever backend it came from. */
export async function listChildren(node: TreeNode): Promise<TreeNode[]> {
  if (node.children) return node.children
  if (node.osPath) return readOsDirectory(node.osPath, node.path)
  return readDirectory(node.handle as FileSystemDirectoryHandle, node.path)
}

export async function readFile(node: TreeNode): Promise<string> {
  if (node.osPath) return readTextFile(node.osPath)
  if (node.file) return node.file.text()
  return (await (node.handle as FileSystemFileHandle).getFile()).text()
}

/** Desktop: write to a known path, or ask where to save. Returns the path written, or null if cancelled. */
export async function saveOsFile(osPath: string | undefined, suggestedName: string, content: string) {
  const target = osPath ?? (await saveDialog({ defaultPath: suggestedName }))
  if (!target) return null
  await writeTextFile(target, content)
  return target
}

export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export async function confirmDialog(message: string): Promise<boolean> {
  if (isDesktop) return ask(message, { title: 'Forge', kind: 'warning' })
  return window.confirm(message)
}

export async function writeFile(handle: FileSystemFileHandle, content: string): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

/** Desktop: open a folder by path (dialog, or a restored session). */
export async function openOsFolder(dir: string): Promise<Workspace> {
  const name = baseName(dir)
  const root: TreeNode = { name, path: name, kind: 'directory', osPath: dir }
  return { name, root, nodes: await readOsDirectory(dir, name), writable: true, osPath: dir }
}

/** Ask for a folder: native picker when it works, otherwise the upload-style picker. */
export async function pickFolder(): Promise<Workspace | null> {
  if (isDesktop) {
    const dir = await openDialog({ directory: true, title: 'Open Folder' })
    return dir ? openOsFolder(dir) : null
  }
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
      const root: TreeNode = { name: dir.name, path: dir.name, kind: 'directory', handle: dir }
      return { name: dir.name, root, nodes: await readDirectory(dir, dir.name), writable: true }
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null
      // SecurityError etc. (iframes, Brave, embedded browsers) -> fall through
    }
  }
  const files = await pickFilesWithInput()
  return files.length ? buildTree(files) : null
}

function pickFilesWithInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true })
    input.webkitdirectory = true
    input.addEventListener('change', () => resolve([...(input.files ?? [])]))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

function buildTree(files: File[]): Workspace {
  const rootName = files[0].webkitRelativePath.split('/')[0] || 'folder'
  const root: TreeNode = { name: rootName, path: rootName, kind: 'directory', children: [] }
  const dirs = new Map<string, TreeNode>([[rootName, root]])

  for (const file of files) {
    const parts = file.webkitRelativePath.split('/')
    if (parts.slice(0, -1).some((p) => IGNORED.has(p))) continue
    let parent = root
    for (let i = 1; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let dir = dirs.get(path)
      if (!dir) {
        dir = { name: parts[i], path, kind: 'directory', children: [] }
        dirs.set(path, dir)
        parent.children!.push(dir)
      }
      parent = dir
    }
    parent.children!.push({ name: file.name, path: parts.join('/'), kind: 'file', file })
  }
  dirs.forEach((d) => sortNodes(d.children!))
  return { name: rootName, root, nodes: root.children!, writable: false }
}

/** Fallback save for browsers without the API: trigger a download. */
export function downloadFile(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

// ---------- paths ----------
const caseInsensitive = /Windows|Mac/.test(navigator.userAgent)
const normPath = (p: string) => {
  const n = p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return caseInsensitive ? n.toLowerCase() : n
}
export const samePath = (a: string, b: string) => normPath(a) === normPath(b)
/** True if `path` is `dir` or anything below it. */
export const isWithin = (path: string, dir: string) =>
  samePath(path, dir) || normPath(path).startsWith(normPath(dir) + '/')
export const parentOf = (p: string) => p.replace(/[\\/][^\\/]*[\\/]?$/, '')
export const trashName = navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash'

/** Desktop: the tree node for a disk path inside the open folder. */
export function nodeAt(ws: Workspace, osPath: string, kind: TreeNode['kind']): TreeNode | null {
  if (!ws.osPath || !isWithin(osPath, ws.osPath)) return null
  if (samePath(osPath, ws.osPath)) return ws.root
  const rel = osPath.slice(ws.osPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  return { name: baseName(osPath), path: `${ws.name}/${rel}`, kind, osPath }
}

// ---------- desktop workspace (src-tauri/src/workspace.rs) ----------
export interface FsChange { paths: string[]; overflow: boolean }

/** Watch the open folder. `paths` are disk paths; `overflow` means "too many, refresh everything". */
export function watchFolder(root: string, onChange: (change: FsChange) => void) {
  const channel = new Channel<FsChange>()
  channel.onmessage = onChange
  return invoke('workspace_open', { root, onChange: channel })
}
export const createEntry = (path: string, directory: boolean) => invoke('workspace_create', { path, directory })
export const renameEntry = (from: string, to: string) => invoke('workspace_rename', { from, to })
export const trashEntry = (path: string) => invoke('workspace_trash', { path })
export const joinPath = (...parts: string[]) => join(...parts)
export const readOsFile = (osPath: string) => readTextFile(osPath)

// ---------- go to file ----------
async function collectFiles(nodes: TreeNode[], out: TreeNode[], limit = 5000) {
  for (const n of nodes) {
    if (out.length >= limit) return
    if (n.kind === 'file') out.push(n)
    else await collectFiles(await listChildren(n), out, limit)
  }
}

/** Every file in the workspace. Desktop honours .gitignore. */
export async function listAllFiles(ws: Workspace): Promise<TreeNode[]> {
  if (ws.osPath) {
    const rels = await invoke<string[]>('workspace_files')
    const s = sep()
    const base = ws.osPath.replace(/[\\/]+$/, '')
    return rels.map((rel) => ({
      name: rel.slice(rel.lastIndexOf('/') + 1),
      path: `${ws.name}/${rel}`,
      kind: 'file',
      osPath: base + s + rel.split('/').join(s),
    }))
  }
  const out: TreeNode[] = []
  await collectFiles(ws.nodes, out)
  return out
}

// ---------- find in files ----------
export interface SearchOptions { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean }
/** Columns and lengths are UTF-16 units (Monaco / JS string indices). */
export interface LineMatch {
  line: number
  column: number
  length: number
  preview: string
  previewStart: number
  previewLength: number
}
export interface FileMatches { node: TreeNode; matches: LineMatch[] }
export interface SearchResults { files: FileMatches[]; truncated: boolean }

const MAX_MATCHES = 5000

/** Throws with a readable message for an invalid regex. */
export async function searchWorkspace(ws: Workspace, opts: SearchOptions): Promise<SearchResults> {
  if (ws.osPath) {
    const r = await invoke<{ files: { path: string; matches: LineMatch[] }[]; truncated: boolean }>(
      'workspace_search', { options: opts },
    )
    return {
      truncated: r.truncated,
      files: r.files.flatMap((f) => {
        const node = nodeAt(ws, f.path, 'file')
        return node ? [{ node, matches: f.matches }] : []
      }),
    }
  }
  // Browser: scan in JS
  let src = opts.regex ? opts.query : opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts.wholeWord) src = `\\b(?:${src})\\b`
  const re = new RegExp(src, opts.caseSensitive ? 'g' : 'gi')
  const nodes: TreeNode[] = []
  await collectFiles(ws.nodes, nodes)
  const files: FileMatches[] = []
  let total = 0
  for (const node of nodes) {
    let text: string
    try { text = await readFile(node) } catch { continue }
    if (text.length > 2_000_000 || text.includes('\0')) continue
    const matches: LineMatch[] = []
    text.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        if (!m[0] || total >= MAX_MATCHES) continue
        total++
        matches.push({ line: i + 1, column: m.index + 1, length: m[0].length, ...preview(line, m.index, m[0].length) })
      }
    })
    if (matches.length) files.push({ node, matches })
    if (total >= MAX_MATCHES) return { files, truncated: true }
  }
  return { files, truncated: false }
}

function preview(line: string, start: number, length: number) {
  let from = Math.max(0, start - 60)
  from = start - line.slice(from, start).trimStart().length
  const prefix = line.slice(0, from).trim() ? '…' : ''
  return {
    preview: prefix + line.slice(from, start + length + 200),
    previewStart: prefix.length + start - from,
    previewLength: length,
  }
}
