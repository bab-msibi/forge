import { useEffect, useRef, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { baseName, isDesktop } from './fs'

const THEMES = {
  dark: { background: '#1e1e1e', foreground: '#cccccc', cursor: '#aeafad', selectionBackground: '#264f78' },
  light: { background: '#ffffff', foreground: '#333333', cursor: '#000000', selectionBackground: '#add6ff' },
}

interface Session { key: number; title: string; cwd?: string; exited: boolean }

export function TerminalPanel({ visible, cwd, dark, onHide }: {
  visible: boolean
  cwd?: string
  dark: boolean
  onHide: () => void
}) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeKey, setActiveKey] = useState<number | null>(null)
  const [height, setHeight] = useState(260)
  const nextKey = useRef(1)

  const add = () => {
    const key = nextKey.current++
    // Each terminal remembers the folder it was started in
    const title = `${cwd ? baseName(cwd) : '~'} · ${key}`
    setSessions((s) => [...s, { key, title, cwd, exited: false }])
    setActiveKey(key)
  }

  const remove = (key: number) => {
    const rest = sessions.filter((s) => s.key !== key)
    setSessions(rest)
    if (activeKey === key) setActiveKey(rest.at(-1)?.key ?? null)
    if (rest.length === 0) onHide()
  }

  // Open a first terminal the first time the panel is shown
  useEffect(() => {
    if (visible && sessions.length === 0 && isDesktop) add()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const startResize = (e: React.PointerEvent) => {
    const startY = e.clientY
    const startH = height
    const move = (ev: PointerEvent) =>
      setHeight(Math.min(Math.max(startH + startY - ev.clientY, 100), window.innerHeight - 160))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="terminal-panel" style={{ height, display: visible ? 'flex' : 'none' }}>
      <div className="terminal-resizer" onPointerDown={startResize} />
      <div className="terminal-header">
        <span className="terminal-label">TERMINAL</span>
        {sessions.map((s) => (
          <div
            key={s.key}
            className={`terminal-tab ${s.key === activeKey ? 'active' : ''}`}
            onClick={() => setActiveKey(s.key)}
          >
            <span title={s.cwd ?? 'Home folder'}>{s.title}{s.exited ? ' (exited)' : ''}</span>
            <button className="tab-close" title="Kill terminal" onClick={(e) => { e.stopPropagation(); remove(s.key) }}>×</button>
          </div>
        ))}
        <span className="spacer" />
        {isDesktop && <button className="icon-btn" title="New terminal" onClick={add}>＋</button>}
        <button className="icon-btn" title="Hide panel (Ctrl+`)" onClick={onHide}>⌄</button>
      </div>
      <div className="terminal-body">
        {!isDesktop && (
          <div className="terminal-unavailable">
            The terminal is available in the desktop app. Run <kbd>npm run desktop</kbd>.
          </div>
        )}
        {sessions.map((s) => (
          <TerminalView
            key={s.key}
            cwd={s.cwd}
            dark={dark}
            active={visible && s.key === activeKey}
            onExit={() => setSessions((all) => all.map((x) => (x.key === s.key ? { ...x, exited: true } : x)))}
          />
        ))}
      </div>
    </div>
  )
}

function TerminalView({ cwd, dark, active, onExit }: {
  cwd?: string
  dark: boolean
  active: boolean
  onExit: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onExitRef = useRef(onExit)
  useEffect(() => { onExitRef.current = onExit })

  // Create the terminal and its shell once; cwd is fixed at spawn time
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: dark ? THEMES.dark : THEMES.light,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // Ctrl+C copies when text is selected (otherwise it interrupts); Ctrl+V pastes
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey) return true
      if (e.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      if (e.key === 'v') {
        e.preventDefault()
        navigator.clipboard.readText().then((t) => term.paste(t))
        return false
      }
      return true
    })

    let id: number | null = null
    let disposed = false
    const onData = new Channel<ArrayBuffer | number[]>()
    onData.onmessage = (chunk) => term.write(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk))
    const onExitChan = new Channel<number>()
    onExitChan.onmessage = (code) => {
      term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
      onExitRef.current()
    }

    invoke<number>('pty_spawn', { cwd, cols: term.cols, rows: term.rows, onData, onExit: onExitChan })
      .then((ptyId) => {
        if (disposed) return void invoke('pty_kill', { id: ptyId })
        id = ptyId
      })
      .catch((err) => term.write(`\x1b[31mFailed to start shell: ${err}\x1b[0m\r\n`))

    const input = term.onData((data) => { if (id !== null) invoke('pty_write', { id, data }).catch(() => {}) })
    const resize = term.onResize(({ cols, rows }) => { if (id !== null) invoke('pty_resize', { id, cols, rows }).catch(() => {}) })

    const observer = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent) fit.fit()
    })
    observer.observe(hostRef.current!)

    return () => {
      disposed = true
      observer.disconnect()
      input.dispose()
      resize.dispose()
      if (id !== null) invoke('pty_kill', { id }).catch(() => {})
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = dark ? THEMES.dark : THEMES.light
  }, [dark])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      fitRef.current?.fit()
      termRef.current?.focus()
    })
  }, [active])

  return <div ref={hostRef} className="terminal-view" style={{ display: active ? 'block' : 'none' }} />
}
