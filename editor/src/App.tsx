import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { monaco, languageFor } from './monaco'
import { TerminalPanel } from './Terminal'
import { Explorer, type ExplorerHandle } from './Explorer'
import { fileIcon } from './icons'
import { SearchPanel } from './Search'
import {
  type FsChange,
  type LineMatch,
  type TreeNode,
  baseName,
  confirmDialog,
  downloadFile,
  isDesktop,
  isWithin,
  listAllFiles,
  nodeAt,
  openOsFolder,
  readOsFile,
  samePath,
  saveOsFile,
  watchFolder,
  type Workspace,
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
  binary?: boolean
}

type Theme = 'vs-dark' | 'vs'
type SidebarView = 'explorer' | 'search'

interface Session { folder?: string; files: string[]; active?: string }

const NEW_KEY = isDesktop ? 'Ctrl+N' : 'Ctrl+Alt+N'
const CLOSE_KEY = isDesktop ? 'Ctrl+W' : 'Ctrl+Alt+W'

const modelUri = (id: string) => monaco.Uri.parse(id)
const isBinary = (text: string) => text.slice(0, 8000).includes('\0')

// ---------- persisted settings ----------
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`forge.${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
function store(key: string, value: unknown) {
  try { localStorage.setItem(`forge.${key}`, JSON.stringify(value)) } catch { /* storage unavailable */ }
}
function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => load(key, fallback))
  useEffect(() => store(key, value), [key, value])
  return [value, setValue] as const
}

export default function App() {
  const [root, setRoot] = useState<Workspace | null>(null)
  const [docs, setDocs] = useState<Doc[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [theme, setTheme] = useStored<Theme>('theme', 'vs-dark')
  const [wordWrap, setWordWrap] = useStored('wordWrap', false)
  const [minimap, setMinimap] = useStored('minimap', true)
  const [sidebarView, setSidebarView] = useStored<SidebarView>('sidebarView', 'explorer')
  const [searchFocus, setSearchFocus] = useState<{ n: number; seed?: string }>({ n: 0 })
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [quickOpen, setQuickOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [terminalOpen, setTerminalOpen] = useState(false)
  const untitledCount = useRef(0)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const explorerRef = useRef<ExplorerHandle>(null)
  const pendingReveal = useRef<{ id: string; line: number; column: number; length: number } | null>(null)
  const docsRef = useRef(docs)
  useEffect(() => { docsRef.current = docs })

  const active = docs.find((d) => d.id === activeId) ?? null

  const flash = useCallback((text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage(''), 2500)
  }, [])

  // ---------- file actions ----------
  const openFolder = useCallback(async () => {
    const ws = await pickFolder()
    if (!ws) return
    setRoot(ws)
    if (!ws.writable) flash('Opened read-only: Save will download files')
  }, [flash])

  const docFor = (node: TreeNode, text: string): Doc => ({
    id: `/${node.path}`,
    name: node.name,
    handle: node.handle as FileSystemFileHandle | undefined,
    osPath: node.osPath,
    saved: text,
    content: text,
    language: languageFor(node.name),
    binary: isBinary(text) || undefined,
  })

  const openFile = useCallback(async (node: TreeNode) => {
    const id = `/${node.path}`
    setActiveId(id)
    if (docsRef.current.some((d) => d.id === id)) return
    let text: string
    try {
      text = await readFile(node)
    } catch (err) {
      return flash(`Could not open ${node.name}: ${err}`)
    }
    setDocs((prev) => (prev.some((d) => d.id === id) ? prev : [...prev, docFor(node, text)]))
  }, [flash])

  const applyReveal = useCallback(() => {
    const p = pendingReveal.current
    const editor = editorRef.current
    if (!p || !editor || editor.getModel()?.uri.toString() !== modelUri(p.id).toString()) return
    pendingReveal.current = null
    const range = new monaco.Range(p.line, p.column, p.line, p.column + p.length)
    editor.setSelection(range)
    editor.revealRangeInCenterIfOutsideViewport(range)
    editor.focus()
  }, [])

  const openMatch = useCallback(async (node: TreeNode, m: LineMatch) => {
    pendingReveal.current = { id: `/${node.path}`, line: m.line, column: m.column, length: m.length }
    await openFile(node)
    applyReveal()
  }, [openFile, applyReveal])
  useEffect(applyReveal)

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
    if (!doc || doc.binary) return
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
  }, [flash])

  const closeDoc = useCallback(
    async (id: string) => {
      const doc = docs.find((d) => d.id === id)
      if (doc && doc.content !== doc.saved && !(await confirmDialog(`Discard unsaved changes to ${doc.name}?`))) return
      const idx = docs.findIndex((d) => d.id === id)
      const remaining = docs.filter((d) => d.id !== id)
      setDocs(remaining)
      if (activeId === id) setActiveId(remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
      monaco.editor.getModel(modelUri(id))?.dispose()
    },
    [docs, activeId],
  )

  // ---------- explorer file operations ----------
  const onRenamed = useCallback((from: string, to: string) => {
    if (!root) return
    const moved = new Map<string, string>() // old id -> new id
    const next = docsRef.current.map((d) => {
      if (!d.osPath || !isWithin(d.osPath, from)) return d
      const osPath = to + d.osPath.slice(from.length)
      const node = nodeAt(root, osPath, 'file')
      if (!node) return d
      const id = `/${node.path}`
      moved.set(d.id, id)
      const renamedItself = samePath(d.osPath, from)
      return { ...d, id, osPath, name: node.name, language: renamedItself ? languageFor(node.name) : d.language }
    })
    if (!moved.size) return
    setDocs(next)
    setActiveId((a) => (a && moved.get(a)) || a)
    // The editor picks up new models from the docs; drop the old ones afterwards
    window.setTimeout(() => moved.forEach((_, id) => monaco.editor.getModel(modelUri(id))?.dispose()))
  }, [root])

  const onDeleted = useCallback((osPath: string) => {
    const gone = docsRef.current.filter((d) => d.osPath && isWithin(d.osPath, osPath))
    if (!gone.length) return
    const close = new Set(gone.filter((d) => d.content === d.saved).map((d) => d.id))
    const remaining = docsRef.current
      .filter((d) => !close.has(d.id))
      // Dirty tabs stay open; with no path, Save asks where to put them
      .map((d) => (d.osPath && isWithin(d.osPath, osPath) ? { ...d, osPath: undefined, saved: '' } : d))
    setDocs(remaining)
    setActiveId((a) => (a && close.has(a) ? remaining.at(-1)?.id ?? null : a))
    close.forEach((id) => monaco.editor.getModel(modelUri(id))?.dispose())
  }, [])

  // ---------- watch the folder (desktop) ----------
  const reloadFromDisk = useCallback(async (paths: string[] | null) => {
    for (const d of docsRef.current) {
      if (!d.osPath || d.binary) continue
      if (paths && !paths.some((p) => samePath(p, d.osPath!))) continue
      let text: string
      try { text = await readOsFile(d.osPath) } catch { continue } // deleted: keep the tab as is
      if (text === d.saved) continue // includes our own saves
      if (d.content !== d.saved) { flash(`${d.name} changed on disk; you have unsaved edits`); continue }
      setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, saved: text, content: text } : x)))
      const model = monaco.editor.getModel(modelUri(d.id))
      // An edit (not setValue) keeps undo history
      if (model && model.getValue() !== text) model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
    }
  }, [flash])

  useEffect(() => {
    if (!root?.osPath) return
    const onChange = ({ paths, overflow }: FsChange) => {
      explorerRef.current?.refresh(overflow ? null : paths)
      reloadFromDisk(overflow ? null : paths)
    }
    watchFolder(root.osPath, onChange).catch((err) => flash(`Not watching folder: ${err}`))
  }, [root, reloadFromDisk, flash])

  // ---------- restore / remember the session (desktop) ----------
  const restored = useRef(!isDesktop)
  useEffect(() => {
    if (restored.current) return
    const session = load<Session>('session', { files: [] })
    ;(async () => {
      try {
        if (!session.folder) return
        const ws = await openOsFolder(session.folder)
        setRoot(ws)
        const opened: Doc[] = []
        for (const osPath of session.files) {
          const node = nodeAt(ws, osPath, 'file')
          if (!node) continue
          try { opened.push(docFor(node, await readOsFile(osPath))) } catch { /* file is gone */ }
        }
        setDocs(opened)
        const activeDoc = opened.find((d) => session.active && samePath(d.osPath!, session.active))
        setActiveId(activeDoc?.id ?? opened.at(-1)?.id ?? null)
      } catch {
        // Folder moved or no longer accessible: start empty
      } finally {
        restored.current = true
      }
    })()
  }, [])

  useEffect(() => {
    if (!restored.current || !isDesktop) return
    const files = docs.flatMap((d) => (d.osPath ? [d.osPath] : []))
    store('session', { folder: root?.osPath, files, active: active?.osPath } satisfies Session)
  }, [root, docs, active])

  // ---------- keyboard shortcuts ----------
  const showSearch = useCallback(() => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    const seed = selection && !selection.isEmpty() && selection.startLineNumber === selection.endLineNumber
      ? editor!.getModel()?.getValueInRange(selection)
      : undefined
    setSidebarView('search')
    setSearchFocus((f) => ({ n: f.n + 1, seed }))
  }, [setSidebarView])

  const actions = useRef({ saveDoc, newFile, openFolder, closeDoc, showSearch, active })
  useEffect(() => {
    actions.current = { saveDoc, newFile, openFolder, closeDoc, showSearch, active }
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.code === 'Backquote' || e.key === '`') { e.preventDefault(); setTerminalOpen((o) => !o); return }
      // Leave every other Ctrl shortcut to the shell while typing in the terminal
      if ((e.target as Element | null)?.closest?.('.xterm')) return
      const a = actions.current
      const key = e.key.toLowerCase()
      if (e.shiftKey && key === 'f') { e.preventDefault(); a.showSearch() }
      else if (e.shiftKey && key === 'e') { e.preventDefault(); setSidebarView('explorer') }
      else if (key === 's') { e.preventDefault(); a.saveDoc(a.active) }
      else if (key === 'p') { e.preventDefault(); setQuickOpen(true) }
      else if (key === 'o') { e.preventDefault(); a.openFolder() }
      // The desktop app owns Ctrl+N / Ctrl+W; in a browser those belong to the browser
      else if ((e.altKey || isDesktop) && key === 'n') { e.preventDefault(); a.newFile() }
      else if ((e.altKey || isDesktop) && key === 'w') { e.preventDefault(); if (a.active) a.closeDoc(a.active.id) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setSidebarView])

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
      if (await confirmDialog('You have unsaved changes. Quit anyway?')) await win.destroy()
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
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => actions.current.showSearch())
    applyReveal()
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
        <button onClick={() => saveDoc(active)} disabled={!active || active.binary} title="Ctrl+S">Save</button>
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
          <div className="sidebar-tabs">
            <button className={sidebarView === 'explorer' ? 'on' : ''} onClick={() => setSidebarView('explorer')} title="Explorer (Ctrl+Shift+E)">Explorer</button>
            <button className={sidebarView === 'search' ? 'on' : ''} onClick={showSearch} title="Search (Ctrl+Shift+F)">Search</button>
          </div>
          <div className="sidebar-view" hidden={sidebarView !== 'explorer'}>
            {root ? (
              <Explorer
                key={root.osPath ?? root.name}
                ref={explorerRef}
                ws={root}
                activeId={activeId}
                onOpen={openFile}
                onRenamed={onRenamed}
                onDeleted={onDeleted}
                flash={flash}
              />
            ) : (
              <div className="empty-side">
                <p>No folder open.</p>
                <button onClick={openFolder}>Open Folder</button>
              </div>
            )}
          </div>
          <div className="sidebar-view" hidden={sidebarView !== 'search'}>
            <SearchPanel ws={root} focus={searchFocus} onOpenMatch={openMatch} />
          </div>
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
                  title={d.osPath ?? d.id}
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
          {active?.binary ? (
            <div className="welcome">
              <p>{active.name} is a binary file and can't be shown as text.</p>
            </div>
          ) : active ? (
            <Editor
              path={active.id}
              // Only used when a model is first created (incl. after a rename): keep unsaved edits
              defaultValue={active.content}
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
        {active && !active.binary && (
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

// ---------- quick open (Ctrl+P) ----------
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
  const [files, setFiles] = useState<TreeNode[] | null>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  useEffect(() => {
    listAllFiles(root).then(setFiles, () => setFiles([]))
  }, [root])

  const results = useMemo(() => {
    const q = query.toLowerCase().replace(/\s+/g, '')
    if (!files) return []
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
          {!files && <li className="dim">Indexing…</li>}
          {files && results.length === 0 && <li className="dim">No matching files</li>}
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
        <li><kbd>Ctrl+Shift+F</kbd> Search in files</li>
        <li><kbd>Ctrl+S</kbd> Save</li>
        <li><kbd>{CLOSE_KEY}</kbd> Close tab</li>
        <li><kbd>Ctrl+`</kbd> Toggle terminal</li>
        <li><kbd>F1</kbd> Command palette (in editor)</li>
      </ul>
    </div>
  )
}
