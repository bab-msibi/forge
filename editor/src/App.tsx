import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { monaco, languageFor } from './monaco'
import { TerminalPanel } from './Terminal'
import {
  type TreeNode,
  baseName,
  confirmDiscard,
  downloadFile,
  isDesktop,
  saveOsFile,
  type Workspace,
  listChildren,
  pickFolder,
  readFile,
  writeFile,
} from './fs'

interface Doc {
  id: string // model path, unique per open document
  name: string
  handle?: FileSystemFileHandle
  osPath?: string
  saved: string
  content: string
  language: string
}

type Theme = 'vs-dark' | 'vs'

const NEW_KEY = isDesktop ? 'Ctrl+N' : 'Ctrl+Alt+N'
const CLOSE_KEY = isDesktop ? 'Ctrl+W' : 'Ctrl+Alt+W'

const modelUri = (id: string) => monaco.Uri.parse(id)

export default function App() {
  const [root, setRoot] = useState<Workspace | null>(null)
  const [docs, setDocs] = useState<Doc[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>('vs-dark')
  const [wordWrap, setWordWrap] = useState(false)
  const [minimap, setMinimap] = useState(true)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [quickOpen, setQuickOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [terminalOpen, setTerminalOpen] = useState(false)
  const untitledCount = useRef(0)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  const active = docs.find((d) => d.id === activeId) ?? null

  const flash = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage(''), 2500)
  }

  // ---------- file actions ----------
  const openFolder = useCallback(async () => {
    const ws = await pickFolder()
    if (!ws) return
    setRoot(ws)
    if (!ws.writable) flash('Opened read-only: Save will download files')
  }, [])

  const openFile = useCallback(async (node: TreeNode) => {
    const id = `/${node.path}`
    setActiveId(id)
    if (docs.some((d) => d.id === id)) return
    const text = await readFile(node)
    setDocs((prev) =>
      prev.some((d) => d.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              name: node.name,
              handle: node.handle as FileSystemFileHandle | undefined,
              osPath: node.osPath,
              saved: text,
              content: text,
              language: languageFor(node.name),
            },
          ],
    )
  }, [docs])

  const newFile = useCallback(() => {
    const n = ++untitledCount.current
    const id = `/__untitled__/Untitled-${n}`
    setDocs((prev) => [
      ...prev,
      { id, name: `Untitled-${n}`, saved: '', content: '', language: 'plaintext' },
    ])
    setActiveId(id)
  }, [])

  const saveDoc = useCallback(async (doc: Doc | null) => {
    if (!doc) return
    if (isDesktop) {
      try {
        const osPath = await saveOsFile(doc.osPath, doc.name, doc.content)
        if (!osPath) return
        const name = baseName(osPath)
        setDocs((prev) =>
          prev.map((d) =>
            d.id === doc.id
              ? { ...d, osPath, name, saved: doc.content, language: d.osPath ? d.language : languageFor(name) }
              : d,
          ),
        )
        flash(`Saved ${osPath}`)
      } catch (err) {
        flash(`Save failed: ${err}`)
      }
      return
    }
    let handle = doc.handle
    let name = doc.name
    try {
      if (!handle) {
        try {
          if (!window.showSaveFilePicker) throw new Error('unsupported')
          handle = await window.showSaveFilePicker({ suggestedName: name })
          name = handle.name
        } catch (err) {
          if ((err as DOMException).name === 'AbortError') return
          // No native save in this browser: download instead
          downloadFile(name, doc.content)
          setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, saved: d.content } : d)))
          return flash(`Downloaded ${name}`)
        }
      }
      await writeFile(handle, doc.content)
      setDocs((prev) =>
        prev.map((d) =>
          d.id === doc.id
            ? {
                ...d,
                handle,
                name,
                saved: d.content,
                language: d.handle ? d.language : languageFor(name),
              }
            : d,
        ),
      )
      flash(`Saved ${name}`)
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') flash(`Save failed: ${(err as Error).message}`)
    }
  }, [])

  const closeDoc = useCallback(
    async (id: string) => {
      const doc = docs.find((d) => d.id === id)
      if (doc && doc.content !== doc.saved && !(await confirmDiscard(`Discard unsaved changes to ${doc.name}?`))) return
      const idx = docs.findIndex((d) => d.id === id)
      const remaining = docs.filter((d) => d.id !== id)
      setDocs(remaining)
      if (activeId === id) setActiveId(remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
      monaco.editor.getModel(modelUri(id))?.dispose()
    },
    [docs, activeId],
  )

  // ---------- keyboard shortcuts ----------
  const actions = useRef({ saveDoc, newFile, openFolder, closeDoc, active })
  useEffect(() => {
    actions.current = { saveDoc, newFile, openFolder, closeDoc, active }
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.code === 'Backquote' || e.key === '`') { e.preventDefault(); setTerminalOpen((o) => !o); return }
      // Leave every other Ctrl shortcut to the shell while typing in the terminal
      if ((e.target as Element | null)?.closest?.('.xterm')) return
      const a = actions.current
      const key = e.key.toLowerCase()
      if (key === 's') { e.preventDefault(); a.saveDoc(a.active) }
      else if (key === 'p') { e.preventDefault(); setQuickOpen(true) }
      else if (key === 'o') { e.preventDefault(); a.openFolder() }
      // The desktop app owns Ctrl+N / Ctrl+W; in a browser those belong to the browser
      else if ((e.altKey || isDesktop) && key === 'n') { e.preventDefault(); a.newFile() }
      else if ((e.altKey || isDesktop) && key === 'w') { e.preventDefault(); if (a.active) a.closeDoc(a.active.id) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Focus the editor whenever the active tab changes
  useEffect(() => {
    if (activeId) requestAnimationFrame(() => editorRef.current?.focus())
  }, [activeId])

  // Desktop: window title follows the open folder / file
  useEffect(() => {
    if (!isDesktop) return
    const parts = [active && `${active.content !== active.saved ? '● ' : ''}${active.name}`, root?.name, 'Forge']
    getCurrentWindow().setTitle(parts.filter(Boolean).join(' — ')).catch(() => {})
  }, [active, root])

  // Desktop: confirm before closing the window with unsaved work
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = docs.some((d) => d.content !== d.saved)
  }, [docs])
  useEffect(() => {
    if (!isDesktop) return
    const win = getCurrentWindow()
    const unlisten = win.onCloseRequested(async (event) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      if (await confirmDiscard('You have unsaved changes. Quit anyway?')) await win.destroy()
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [])

  // Browser: warn before leaving with unsaved work
  useEffect(() => {
    const dirty = docs.some((d) => d.content !== d.saved)
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [docs])

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.focus()
    editor.onDidChangeCursorPosition((e) =>
      setCursor({ line: e.position.lineNumber, col: e.position.column }),
    )
    // Inside Monaco, Ctrl+S must be bound as a command or Monaco swallows it
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      actions.current.saveDoc(actions.current.active),
    )
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => setQuickOpen(true))
  }

  const languages = useMemo(
    () => monaco.languages.getLanguages().map((l) => l.id).sort(),
    [],
  )

  return (
    <div className={`app ${theme === 'vs' ? 'light' : 'dark'}`}>
      <header className="toolbar">
        <span className="brand">⌘ Forge</span>
        <button onClick={openFolder} title="Ctrl+O">Open Folder</button>
        <button onClick={newFile} title={NEW_KEY}>New File</button>
        <button onClick={() => saveDoc(active)} disabled={!active} title="Ctrl+S">Save</button>
        <button onClick={() => setQuickOpen(true)} disabled={!root} title="Ctrl+P">Go to File</button>
        <button onClick={() => setTerminalOpen((o) => !o)} title="Ctrl+`">Terminal</button>
        <span className="spacer" />
        <label><input type="checkbox" checked={wordWrap} onChange={(e) => setWordWrap(e.target.checked)} /> Wrap</label>
        <label><input type="checkbox" checked={minimap} onChange={(e) => setMinimap(e.target.checked)} /> Minimap</label>
        <button onClick={() => setTheme(theme === 'vs-dark' ? 'vs' : 'vs-dark')}>
          {theme === 'vs-dark' ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <div className="main">
        <aside className="sidebar">
          <div className="sidebar-title">{root ? `${root.name.toUpperCase()}${root.writable ? '' : ' (READ-ONLY)'}` : 'EXPLORER'}</div>
          {root ? (
            <div className="tree">
              {root.nodes.map((n) => (
                <TreeItem key={n.path} node={n} depth={0} activeId={activeId} onOpen={openFile} />
              ))}
            </div>
          ) : (
            <div className="empty-side">
              <p>No folder open.</p>
              <button onClick={openFolder}>Open Folder</button>
            </div>
          )}
        </aside>

        <section className="editor-area">
          {docs.length > 0 && (
            <div className="tabs">
              {docs.map((d) => (
                <div
                  key={d.id}
                  className={`tab ${d.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(d.id)}
                  onAuxClick={(e) => e.button === 1 && closeDoc(d.id)}
                  title={d.id}
                >
                  <span>{d.name}</span>
                  <button
                    className="tab-close"
                    onClick={(e) => { e.stopPropagation(); closeDoc(d.id) }}
                  >
                    {d.content !== d.saved ? '●' : '×'}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="editor-wrap">
          {active ? (
            <Editor
              path={active.id}
              defaultValue={active.saved}
              language={active.language}
              theme={theme}
              onMount={onMount}
              onChange={(value) =>
                setDocs((prev) =>
                  prev.map((d) => (d.id === active.id ? { ...d, content: value ?? '' } : d)),
                )
              }
              options={{
                fontSize: 14,
                fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
                fontLigatures: true,
                minimap: { enabled: minimap },
                wordWrap: wordWrap ? 'on' : 'off',
                smoothScrolling: true,
                cursorSmoothCaretAnimation: 'on',
                bracketPairColorization: { enabled: true },
                guides: { bracketPairs: true },
                stickyScroll: { enabled: true },
                automaticLayout: true,
                renderWhitespace: 'selection',
                editContext: false, // classic textarea input: works with IMEs/automation everywhere
              }}
            />
          ) : (
            <Welcome onOpen={openFolder} onNew={newFile} />
          )}
          </div>
          <TerminalPanel
            // A new project gets fresh terminals: remounting kills the old project's shells
            key={root?.osPath ?? 'no-folder'}
            visible={terminalOpen}
            cwd={root?.osPath}
            dark={theme === 'vs-dark'}
            onHide={() => { setTerminalOpen(false); editorRef.current?.focus() }}
          />
        </section>
      </div>

      <footer className="statusbar">
        <span>{message || (active ? active.id.replace('/__untitled__/', '') : 'Ready')}</span>
        <span className="spacer" />
        {active && (
          <>
            <span>Ln {cursor.line}, Col {cursor.col}</span>
            <select
              value={active.language}
              onChange={(e) => {
                const language = e.target.value
                setDocs((prev) => prev.map((d) => (d.id === active.id ? { ...d, language } : d)))
              }}
            >
              {languages.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </>
        )}
        <span>UTF-8</span>
      </footer>

      {quickOpen && root && (
        <QuickOpen root={root} onClose={() => setQuickOpen(false)} onPick={(n) => { setQuickOpen(false); openFile(n) }} />
      )}
    </div>
  )
}

// ---------- file tree ----------
function TreeItem({ node, depth, activeId, onOpen }: {
  node: TreeNode
  depth: number
  activeId: string | null
  onOpen: (n: TreeNode) => void
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<TreeNode[] | null>(null)

  const toggle = async () => {
    if (node.kind === 'file') return onOpen(node)
    if (!children) setChildren(await listChildren(node))
    setOpen(!open)
  }

  return (
    <>
      <div
        className={`tree-item ${activeId === `/${node.path}` ? 'selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={toggle}
      >
        <span className="chevron">{node.kind === 'directory' ? (open ? '▾' : '▸') : ''}</span>
        <span className="icon">{node.kind === 'directory' ? '📁' : fileIcon(node.name)}</span>
        {node.name}
      </div>
      {open && children?.map((c) => (
        <TreeItem key={c.path} node={c} depth={depth + 1} activeId={activeId} onOpen={onOpen} />
      ))}
    </>
  )
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: '🟦', tsx: '⚛', js: '🟨', jsx: '⚛', json: '🧾', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', rs: '🦀', go: '🐹', java: '☕', png: '🖼', jpg: '🖼', svg: '🖼',
  }
  return map[ext ?? ''] ?? '📄'
}

// ---------- quick open (Ctrl+P) ----------
async function collectFiles(nodes: TreeNode[], out: TreeNode[], limit = 5000) {
  for (const n of nodes) {
    if (out.length >= limit) return
    if (n.kind === 'file') out.push(n)
    else await collectFiles(await listChildren(n), out, limit)
  }
}

function fuzzyScore(query: string, text: string): number {
  let qi = 0, score = 0, streak = 0
  const t = text.toLowerCase()
  for (let i = 0; i < t.length && qi < query.length; i++) {
    if (t[i] === query[qi]) { qi++; streak++; score += streak } else streak = 0
  }
  return qi === query.length ? score : -1
}

function QuickOpen({ root, onClose, onPick }: {
  root: Workspace
  onClose: () => void
  onPick: (n: TreeNode) => void
}) {
  const [files, setFiles] = useState<TreeNode[]>([])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const out: TreeNode[] = []
    collectFiles(root.nodes, out).then(() => setFiles(out))
  }, [root])

  const results = useMemo(() => {
    const q = query.toLowerCase().replace(/\s+/g, '')
    if (!q) return files.slice(0, 50)
    return files
      .map((f) => ({ f, s: fuzzyScore(q, f.path) + (fuzzyScore(q, f.name) > 0 ? 50 : 0) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((r) => r.f)
  }, [files, query])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Search files by name…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter' && results[index]) onPick(results[index])
          }}
        />
        <ul>
          {results.map((f, i) => (
            <li key={f.path} className={i === index ? 'active' : ''} onMouseEnter={() => setIndex(i)} onClick={() => onPick(f)}>
              <span className="icon">{fileIcon(f.name)}</span> {f.name}
              <span className="dim">{f.path}</span>
            </li>
          ))}
          {files.length === 0 && <li className="dim">Indexing…</li>}
        </ul>
      </div>
    </div>
  )
}

function Welcome({ onOpen, onNew }: { onOpen: () => void; onNew: () => void }) {
  return (
    <div className="welcome">
      <h1>Forge</h1>
      <p>A lightweight code editor powered by Monaco.</p>
      <div className="welcome-actions">
        <button onClick={onOpen}>Open Folder <kbd>Ctrl+O</kbd></button>
        <button onClick={onNew}>New File <kbd>{NEW_KEY}</kbd></button>
      </div>
      <ul className="shortcuts">
        <li><kbd>Ctrl+P</kbd> Go to file</li>
        <li><kbd>Ctrl+S</kbd> Save</li>
        <li><kbd>{CLOSE_KEY}</kbd> Close tab</li>
        <li><kbd>Ctrl+`</kbd> Toggle terminal</li>
        <li><kbd>F1</kbd> Command palette (in editor)</li>
      </ul>
    </div>
  )
}
