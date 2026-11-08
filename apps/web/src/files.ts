/** A project name as a safe file name. */
export function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled'
}
