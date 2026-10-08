// Bundle Monaco locally (no CDN) and wire up its web workers through Vite.
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

loader.config({ monaco })

/** Pick a Monaco language id from a file name using Monaco's own registry. */
export function languageFor(name: string): string {
  const lower = name.toLowerCase()
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === lower)) return lang.id
  }
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.some((ext) => lower.endsWith(ext.toLowerCase()))) return lang.id
  }
  return 'plaintext'
}

export { monaco }
