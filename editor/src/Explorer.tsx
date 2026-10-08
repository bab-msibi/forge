import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  type TreeNode,
  type Workspace,
  confirmDialog,
  createEntry,
  joinPath,
  listChildren,
  nodeAt,
  parentOf,
  renameEntry,
  trashEntry,
  trashName,
} from './fs'
import { fileIcon } from './icons'

export interface ExplorerHandle {
  /** Re-read directories: those containing the given disk paths, or every open one. */
  refresh(osPaths?: string[] | null): void
}

type Edit =
  | { kind: 'new-file' | 'new-folder'; parent: TreeNode }
  | { kind: 'rename'; node: TreeNode }

type MenuItem = [label: string, run: () => void] | null
interface Menu { x: number; y: number; items: MenuItem[] }

const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/'))

export function Explorer({ ref, ws, activeId, onOpen, onRenamed, onDeleted, flash }: {
  ref: Ref<ExplorerHandle>
  ws: Workspace
  activeId: string | null
  onOpen: (node: TreeNode) => void
  onRenamed: (from: string, to: string) => void
  onDeleted: (osPath: string) => void
  flash: (text: string) => void
}) {
  const root = ws.root
  const [children, setChildren] = useState(() => new Map([[root.path, ws.nodes]]))
  const [expanded, setExpanded] = useState(() => new Set([root.path]))
  const [selected, setSelected] = useState<TreeNode | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  // Every directory node seen so far, by tree path, so refreshes can re-list them
  const dirs = useRef(new Map([[root.path, root]]))
  const state = useRef({ children, expanded })
  useEffect(() => { state.current = { children, expanded } })
  const canEdit = !!ws.osPath

  const load = async (dir: TreeNode) => {
    try {
      const kids = await listChildren(dir)
      for (const k of kids) if (k.kind === 'directory') dirs.current.set(k.path, k)
      setChildren((m) => new Map(m).set(dir.path, kids))
    } catch {
      // Directory vanished: its parent's refresh removes it from view
    }
  }

  const expand = async (dir: TreeNode) => {
    if (!state.current.children.has(dir.path)) await load(dir)
    setExpanded((s) => new Set(s).add(dir.path))
  }

  useImperativeHandle(ref, () => ({
    refresh(osPaths) {
      const { children, expanded } = state.current
      let paths: Set<string>
      if (!osPaths) paths = new Set(expanded)
      else {
        paths = new Set()
        for (const p of osPaths) {
          const dir = nodeAt(ws, parentOf(p), 'directory')
          if (dir && children.has(dir.path)) paths.add(dir.path)
        }
      }
      for (const p of paths) {
        const dir = dirs.current.get(p)
        if (dir) load(dir)
      }
    },
  }))

  // Close the context menu on any outside click / Escape
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  /** The folder a "New File" lands in: the selected folder, or the selected file's folder. */
  const targetDir = (node: TreeNode | null) => {
    if (!node) return root
    if (node.kind === 'directory') return node
    return dirs.current.get(parentPath(node.path)) ?? root
  }

  const startNew = async (kind: 'new-file' | 'new-folder', parent: TreeNode) => {
    if (!canEdit) return
    await expand(parent)
    setEdit({ kind, parent })
  }

  const commitEdit = async (name: string) => {
    const current = edit
    setEdit(null)
    name = name.trim()
    if (!current || !name) return
    if (/[\\/]/.test(name)) return flash('Names cannot contain / or \\')
    try {
      if (current.kind === 'rename') {
        const node = current.node
        if (name === node.name || !node.osPath) return
        const target = await joinPath(parentOf(node.osPath), name)
        await renameEntry(node.osPath, target)
        onRenamed(node.osPath, target)
        setSelected(null)
        const parent = dirs.current.get(parentPath(node.path))
        if (parent) await load(parent)
      } else {
        const parent = current.parent
        const target = await joinPath(parent.osPath!, name)
        const directory = current.kind === 'new-folder'
        await createEntry(target, directory)
        await load(parent)
        const node = nodeAt(ws, target, directory ? 'directory' : 'file')
        if (node) {
          setSelected(node)
          if (!directory) onOpen(node)
        }
      }
    } catch (err) {
      flash(String(err))
    }
  }

  const remove = async (node: TreeNode) => {
    if (!canEdit || !node.osPath || node === root) return
    const what = node.kind === 'directory' ? `the folder "${node.name}" and its contents` : `"${node.name}"`
    if (!(await confirmDialog(`Move ${what} to the ${trashName}?`))) return
    try {
      await trashEntry(node.osPath)
      onDeleted(node.osPath)
      setSelected(null)
      const parent = dirs.current.get(parentPath(node.path))
      if (parent) await load(parent)
      flash(`Moved ${node.name} to the ${trashName}`)
    } catch (err) {
      flash(`Delete failed: ${err}`)
    }
  }

  const click = (node: TreeNode) => {
    setSelected(node)
    if (node.kind === 'file') return onOpen(node)
    if (state.current.expanded.has(node.path)) {
      setExpanded((s) => { const n = new Set(s); n.delete(node.path); return n })
    } else expand(node)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (edit || !selected || (e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === 'F2' && canEdit) { e.preventDefault(); setEdit({ kind: 'rename', node: selected }) }
    else if (e.key === 'Delete' && canEdit) { e.preventDefault(); remove(selected) }
    else if (e.key === 'Enter') { e.preventDefault(); click(selected) }
  }

  const openMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    setSelected(node === root ? null : node)
    setMenu({ x: e.clientX, y: e.clientY, items: menuItems(node) })
  }

  const menuItems = (node: TreeNode): MenuItem[] => {
    const isRoot = node === root
    const items: MenuItem[] = []
    if (canEdit) items.push(['New File…', () => startNew('new-file', targetDir(node))], ['New Folder…', () => startNew('new-folder', targetDir(node))])
    if (canEdit && !isRoot) {
      items.push(null, ['Rename… (F2)', () => setEdit({ kind: 'rename', node })], [`Move to ${trashName} (Del)`, () => remove(node)])
    }
    items.push(null)
    if (node.osPath) items.push(['Copy Path', () => navigator.clipboard.writeText(node.osPath!)])
    if (!isRoot) items.push(['Copy Relative Path', () => navigator.clipboard.writeText(node.path.slice(root.path.length + 1))])
    if (isRoot) items.push(['Refresh', () => load(root)])
    return items.filter((it, i, all) => it || (i > 0 && all[i - 1] && i < all.length - 1))
  }

  const nameInput = (key: string, depth: number, isDir: boolean, initial: string) => (
    <NameInput key={key} depth={depth} isDir={isDir} initial={initial} onCommit={commitEdit} onCancel={() => setEdit(null)} />
  )

  const renderDir = (dir: TreeNode, depth: number): ReactNode[] => {
    const rows: ReactNode[] = []
    if (edit && edit.kind !== 'rename' && edit.parent.path === dir.path) {
      rows.push(nameInput('__new__', depth, edit.kind === 'new-folder', ''))
    }
    for (const n of children.get(dir.path) ?? []) {
      const isDir = n.kind === 'directory'
      const open = isDir && expanded.has(n.path)
      if (edit?.kind === 'rename' && edit.node.path === n.path) rows.push(nameInput(n.path, depth, isDir, n.name))
      else rows.push(
        <div
          key={n.path}
          className={`tree-item${activeId === `/${n.path}` ? ' active' : ''}${selected?.path === n.path ? ' selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => click(n)}
          onContextMenu={(e) => openMenu(e, n)}
          title={n.path}
        >
          <span className="chevron">{isDir ? (open ? '▾' : '▸') : ''}</span>
          <span className="icon">{isDir ? '📁' : fileIcon(n.name)}</span>
          {n.name}
        </div>,
      )
      if (open) rows.push(...renderDir(n, depth + 1))
    }
    return rows
  }

  return (
    <div className="explorer">
      <div className="sidebar-title">
        <span>{ws.name.toUpperCase()}{ws.writable ? '' : ' (READ-ONLY)'}</span>
        <span className="spacer" />
        {canEdit && <>
          <button className="icon-btn" title="New File" onClick={() => startNew('new-file', targetDir(selected))}>＋</button>
          <button className="icon-btn" title="New Folder" onClick={() => startNew('new-folder', targetDir(selected))}>📁</button>
        </>}
        <button className="icon-btn" title="Refresh" onClick={() => [...expanded].forEach((p) => { const d = dirs.current.get(p); if (d) load(d) })}>⟳</button>
        <button className="icon-btn" title="Collapse All" onClick={() => setExpanded(new Set([root.path]))}>⊟</button>
      </div>
      <div className="tree" tabIndex={0} onKeyDown={onKeyDown} onContextMenu={(e) => openMenu(e, root)}>
        {renderDir(root, 0)}
      </div>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) =>
            it ? (
              <button key={i} onClick={() => { setMenu(null); it[1]() }}>{it[0]}</button>
            ) : <hr key={i} />,
          )}
        </div>
      )}
    </div>
  )
}

function NameInput({ depth, isDir, initial, onCommit, onCancel }: {
  depth: number
  isDir: boolean
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const done = useRef(false)
  const finish = (fn: () => void) => { if (!done.current) { done.current = true; fn() } }
  return (
    <div className="tree-item editing" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className="chevron" />
      <span className="icon">{isDir ? '📁' : fileIcon(initial)}</span>
      <input
        autoFocus
        defaultValue={initial}
        spellCheck={false}
        onFocus={(e) => {
          // Select the name without its extension, like VS Code
          const dot = isDir ? -1 : initial.lastIndexOf('.')
          e.target.setSelectionRange(0, dot > 0 ? dot : initial.length)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') finish(() => onCommit(e.currentTarget.value))
          else if (e.key === 'Escape') finish(onCancel)
        }}
        onBlur={(e) => finish(() => onCommit(e.currentTarget.value))}
      />
    </div>
  )
}

