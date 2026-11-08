import type { Platform } from './types.ts'
import { webPlatform } from './web.ts'

export type { FileHandle, Platform } from './types.ts'

/** True inside the Tauri desktop app. */
export function isDesktop(): boolean {
  return '__TAURI_INTERNALS__' in window
}

/** The platform the app runs on. The desktop code is only loaded in the desktop app. */
export async function loadPlatform(): Promise<Platform> {
  if (!isDesktop()) return webPlatform
  const { tauriPlatform } = await import('./tauri.ts')
  return tauriPlatform
}
