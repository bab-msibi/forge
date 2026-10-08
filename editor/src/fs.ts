// File access with three backends:
//  - Tauri desktop app: native dialogs + real disk paths, read + write in place
//  - File System Access API (Chrome/Edge in a top-level tab): read + write in place
//  - <input webkitdirectory> fallback (every browser): read-only, saves download
import { isTauri } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
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

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache'])

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

export async function confirmDiscard(message: string): Promise<boolean> {
  if (isDesktop) return ask(message, { title: 'Forge', kind: 'warning' })
  return window.confirm(message)
}

export async function writeFile(handle: FileSystemFileHandle, content: string): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

/** Ask for a folder: native picker when it works, otherwise the upload-style picker. */
export async function pickFolder(): Promise<Workspace | null> {
  if (isDesktop) {
    const dir = await openDialog({ directory: true, title: 'Open Folder' })
    if (!dir) return null
    const name = baseName(dir)
    return { name, nodes: await readOsDirectory(dir, name), writable: true, osPath: dir }
  }
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
      return { name: dir.name, nodes: await readDirectory(dir, dir.name), writable: true }
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
  return { name: rootName, nodes: root.children!, writable: false }
}

/** Fallback save for browsers without the API: trigger a download. */
export function downloadFile(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}
