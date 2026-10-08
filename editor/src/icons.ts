/** Emoji icon for a file name, used by the explorer, search and Go to File. */
export function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: '🟦', tsx: '⚛', js: '🟨', jsx: '⚛', json: '🧾', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', rs: '🦀', go: '🐹', java: '☕', png: '🖼', jpg: '🖼', svg: '🖼',
  }
  return map[ext ?? ''] ?? '📄'
}
