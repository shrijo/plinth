import { PROJECT_FILE_EXTENSION } from '@plinth/core'
import { invoke } from '@tauri-apps/api/core'
import { ask, open, save } from '@tauri-apps/plugin-dialog'
import type { ExportType, FileHandle, OpenedFile, Platform, SavedFile } from './types.ts'

/** Desktop file access through native dialogs and the app's Rust commands. */

const FILTERS = [{ name: 'Plinth project', extensions: [PROJECT_FILE_EXTENSION] }]

export const tauriPlatform: Platform = {
  kind: 'desktop',

  async openFile(): Promise<OpenedFile | null> {
    const path = await open({ multiple: false, directory: false, filters: FILTERS })
    if (typeof path !== 'string') return null
    const contents = await invoke<string>('read_text_file', { path })
    return { name: basename(path), contents, handle: { kind: 'path', path } }
  },

  async saveFile(contents, suggestedName, handle): Promise<SavedFile | null> {
    let path = handle?.kind === 'path' ? handle.path : await save({ defaultPath: suggestedName, filters: FILTERS })
    if (!path) return null
    if (!path.toLowerCase().endsWith(`.${PROJECT_FILE_EXTENSION}`)) path += `.${PROJECT_FILE_EXTENSION}`
    await invoke('write_text_file', { path, contents })
    return { name: basename(path), handle: { kind: 'path', path } }
  },

  async exportFile(contents, suggestedName, type: ExportType) {
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: type.description, extensions: [type.extension] }],
    })
    if (!path) return null
    if (typeof contents === 'string') await invoke('write_text_file', { path, contents })
    // Binary data goes as the raw request body; header values must be ASCII, so the path is encoded.
    else await invoke('write_binary_file', contents, { headers: { path: encodeURIComponent(path) } })
    return basename(path)
  },

  confirm(message) {
    return ask(message, { title: 'Plinth', kind: 'warning' })
  },

  serializeHandle(handle: FileHandle | null) {
    return handle?.kind === 'path' ? handle.path : null
  },

  restoreHandle(saved: string) {
    return { kind: 'path', path: saved }
  },
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
