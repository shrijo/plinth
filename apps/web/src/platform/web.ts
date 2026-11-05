import { PROJECT_FILE_EXTENSION } from '@plinth/core'
import type { ExportType, ImportType, OpenedFile, Platform, SavedFile } from './types.ts'

/**
 * Browser file access. Uses the File System Access API where available
 * (Chromium), so Save writes back to the same file; elsewhere it falls back
 * to a file input and a download.
 */

interface PickerType {
  description: string
  accept: Record<string, string[]>
}

interface FileSystemAccessWindow {
  showOpenFilePicker?: (options: { types: PickerType[]; multiple?: boolean }) => Promise<FileSystemFileHandle[]>
  showSaveFilePicker?: (options: { types: PickerType[]; suggestedName?: string }) => Promise<FileSystemFileHandle>
}

const PICKER_TYPES: PickerType[] = [
  { description: 'Plinth project', accept: { 'application/json': [`.${PROJECT_FILE_EXTENSION}`] } },
]

const fsWindow = window as unknown as FileSystemAccessWindow

export const webPlatform: Platform = {
  kind: 'web',

  async openFile(type?: ImportType): Promise<OpenedFile | null> {
    const types: PickerType[] = type
      ? [{ description: type.description, accept: { 'application/octet-stream': type.extensions.map((e) => `.${e}`) } }]
      : PICKER_TYPES
    if (fsWindow.showOpenFilePicker) {
      try {
        const [handle] = await fsWindow.showOpenFilePicker({ types })
        if (!handle) return null
        const file = await handle.getFile()
        return { name: file.name, contents: await file.text(), handle: { kind: 'browser', handle } }
      } catch (error) {
        if (isAbort(error)) return null
        throw error
      }
    }
    const file = await pickWithInput(type ? type.extensions.map((e) => `.${e}`).join(',') : undefined)
    return file ? { name: file.name, contents: await file.text(), handle: null } : null
  },

  async saveFile(contents, suggestedName, handle): Promise<SavedFile | null> {
    if (handle?.kind === 'browser') {
      await writeTo(handle.handle, contents)
      return { name: handle.handle.name, handle }
    }
    if (fsWindow.showSaveFilePicker) {
      try {
        const picked = await fsWindow.showSaveFilePicker({ types: PICKER_TYPES, suggestedName })
        await writeTo(picked, contents)
        return { name: picked.name, handle: { kind: 'browser', handle: picked } }
      } catch (error) {
        if (isAbort(error)) return null
        throw error
      }
    }
    download(contents, suggestedName)
    return { name: suggestedName, handle: null }
  },

  async exportFile(contents, suggestedName, type: ExportType) {
    if (fsWindow.showSaveFilePicker) {
      try {
        const picked = await fsWindow.showSaveFilePicker({
          types: [{ description: type.description, accept: { [type.mime]: [`.${type.extension}`] } }],
          suggestedName,
        })
        await writeTo(picked, contents)
        return picked.name
      } catch (error) {
        if (isAbort(error)) return null
        throw error
      }
    }
    download(contents, suggestedName, type.mime)
    return suggestedName
  },

  async confirm(message) {
    return window.confirm(message)
  },

  // Browser handles can't be stored as text; Save asks for a place again after a reload.
  serializeHandle: () => null,
  restoreHandle: () => null,
}

async function writeTo(handle: FileSystemFileHandle, contents: string | ArrayBuffer): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(contents)
  await writable.close()
}

function download(contents: string | ArrayBuffer, name: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function pickWithInput(accept = `.${PROJECT_FILE_EXTENSION},application/json`): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

