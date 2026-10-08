import { useEffect, useRef, useState } from 'react'
import { type LineMatch, type SearchOptions, type SearchResults, type TreeNode, type Workspace, searchWorkspace } from './fs'
import { fileIcon } from './icons'

export function SearchPanel({ ws, focus, onOpenMatch }: {
  ws: Workspace | null
  /** Bumped to focus the input; `seed` pre-fills it (e.g. the editor selection). */
  focus: { n: number; seed?: string }
  onOpenMatch: (node: TreeNode, match: LineMatch) => void
}) {
  const [opts, setOpts] = useState<SearchOptions>({ query: '', caseSensitive: false, wholeWord: false, regex: false })
  const [results, setResults] = useState<SearchResults | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [rerun, setRerun] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const request = useRef(0)

  useEffect(() => {
    if (!focus.n) return
    if (focus.seed) setOpts((o) => ({ ...o, query: focus.seed! }))
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select() })
  }, [focus])

  useEffect(() => {
    const id = ++request.current
    if (!ws || !opts.query) return
    const timer = window.setTimeout(async () => {
      setBusy(true)
      try {
        const r = await searchWorkspace(ws, opts)
        if (id !== request.current) return
        setResults(r); setError(''); setCollapsed(new Set())
      } catch (err) {
        if (id !== request.current) return
        setResults(null); setError(String(err))
      } finally {
        if (id === request.current) setBusy(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [ws, opts, rerun])

  // An emptied box shows nothing, whatever the last search returned
  const active = !!(ws && opts.query)
  const shown = active ? results : null

  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex') => setOpts((o) => ({ ...o, [key]: !o[key] }))
  const total = shown?.files.reduce((n, f) => n + f.matches.length, 0) ?? 0

  return (
    <div className="search-panel">
      <div className="sidebar-title">
        <span>SEARCH</span>
        <span className="spacer" />
        <button className="icon-btn" title="Search again" disabled={!opts.query} onClick={() => setRerun((n) => n + 1)}>⟳</button>
        <button className="icon-btn" title="Collapse All" disabled={!shown}
          onClick={() => setCollapsed(new Set(shown?.files.map((f) => f.node.path)))}>⊟</button>
      </div>
      <div className="search-box">
        <input
          ref={input}
          placeholder={ws ? 'Search' : 'Open a folder to search'}
          disabled={!ws}
          value={opts.query}
          spellCheck={false}
          onChange={(e) => setOpts((o) => ({ ...o, query: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && setRerun((n) => n + 1)}
        />
        <button className={`toggle${opts.caseSensitive ? ' on' : ''}`} title="Match Case" onClick={() => toggle('caseSensitive')}>Aa</button>
        <button className={`toggle${opts.wholeWord ? ' on' : ''}`} title="Match Whole Word" onClick={() => toggle('wholeWord')}><u>ab</u></button>
        <button className={`toggle${opts.regex ? ' on' : ''}`} title="Use Regular Expression" onClick={() => toggle('regex')}>.*</button>
      </div>
      <div className="search-summary">
        {!active ? '' : error ? <span className="error">{error}</span>
          : busy ? 'Searching…'
          : shown ? (total
            ? `${total} result${total === 1 ? '' : 's'} in ${shown.files.length} file${shown.files.length === 1 ? '' : 's'}${shown.truncated ? ' (stopped at the limit; refine your search)' : ''}`
            : 'No results')
          : ''}
      </div>
      <div className="search-results">
        {shown?.files.map(({ node, matches }) => {
          const closed = collapsed.has(node.path)
          const dir = node.path.slice(node.path.indexOf('/') + 1, -node.name.length - 1)
          return (
            <div key={node.path}>
              <div className="tree-item result-file" onClick={() => setCollapsed((s) => {
                const n = new Set(s)
                if (closed) n.delete(node.path); else n.add(node.path)
                return n
              })} title={node.path}>
                <span className="chevron">{closed ? '▸' : '▾'}</span>
                <span className="icon">{fileIcon(node.name)}</span>
                <span>{node.name}</span>
                <span className="dim result-dir">{dir}</span>
                <span className="badge">{matches.length}</span>
              </div>
              {!closed && matches.map((m, i) => (
                <div key={i} className="tree-item result-line" onClick={() => onOpenMatch(node, m)} title={`Line ${m.line}`}>
                  {m.preview.slice(0, m.previewStart)}
                  <mark>{m.preview.slice(m.previewStart, m.previewStart + m.previewLength)}</mark>
                  {m.preview.slice(m.previewStart + m.previewLength)}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
