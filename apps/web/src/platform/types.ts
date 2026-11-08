/** Where a project file lives, so Save can write back to it. */
export type FileHandle =
  | { kind: 'path'; path: string }
  | { kind: 'browser'; handle: FileSystemFileHandle }

export interface OpenedFile {
  name: string
  contents: string
  handle: FileHandle | null
}

export interface SavedFile {
  name: string
  handle: FileHandle | null
}

/** A kind of file to open other than a project: data to import. */
export interface ImportType {
  description: string
  /** Extensions without the dot. */
  extensions: string[]
}

/** A kind of exported file. */
export interface ExportType {
  description: string
  extension: string
  mime: string
}

/** The native features the app needs, with one version for browsers and one for the desktop app. */
export interface Platform {
  kind: 'web' | 'desktop'
  /** Asks the user for a project file (or a file of `type`). Null if they cancel. */
  openFile(type?: ImportType): Promise<OpenedFile | null>
  /**
   * Writes a project file: to `handle` if given, otherwise to a place the user
   * picks. Null if they cancel.
   */
  saveFile(contents: string, suggestedName: string, handle: FileHandle | null): Promise<SavedFile | null>
  /** Saves an exported file where the user picks. Returns its name, or null if they cancel. */
  exportFile(contents: string | ArrayBuffer, suggestedName: string, type: ExportType): Promise<string | null>
  confirm(message: string): Promise<boolean>
  /** Remembers a handle across restarts, where the platform allows it. */
  serializeHandle(handle: FileHandle | null): string | null
  restoreHandle(saved: string): FileHandle | null
}
