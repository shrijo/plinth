import { EXAMPLE_CITY_NAME, METROPOLIS_NAME, parseProject, ProjectFileError, serializeProject } from '@plinth/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileSafe } from '../files.ts'
import type { Platform } from '../platform/index.ts'
import { AccountButton, InviteDialog, SharedWithYou } from '../cloud/Cloud.tsx'
import { useSession } from '../cloud/session.ts'
import { createCloudProject } from '../cloud/supabase.ts'
import {
  createExampleProject,
  createProject,
  deleteProject,
  duplicateProject,
  handOver,
  linkToCloud,
  listProjects,
  localCopyOf,
  openProject,
  setUpGallery,
  updateProject,
  type ExampleKind,
  type ProjectRecord,
} from './store.ts'

interface GalleryProps {
  platform: Platform
  /** Opens a project in the editor. */
  onOpen: (id: string) => void
  /** Opens the world, to make a site from a real place. */
  onExplore: () => void
}

/** Every city the user has, newest first, and the example to start from. */
export function Gallery({ platform, onOpen, onExplore }: GalleryProps) {
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const session = useSession()
  const [inviting, setInviting] = useState<ProjectRecord | null>(null)

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects())
    } catch (e) {
      setError(errorText(e))
      setProjects([])
    }
  }, [])

  useEffect(() => {
    void setUpGallery()
      .catch(() => undefined)
      .then(refresh)
  }, [refresh])

  useEffect(() => {
    document.title = 'Plinth'
  }, [])

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(e instanceof ProjectFileError ? e.message : errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const newCity = () =>
    run('Creating a new city…', async () => {
      const project = await createProject('Untitled city')
      handOver(project)
      onOpen(project.id)
    })

  const fromExample = (kind: ExampleKind) =>
    run(kind === 'metropolis' ? `Building ${METROPOLIS_NAME}, about 44,000 buildings…` : `Building ${EXAMPLE_CITY_NAME}…`, async () => {
      // Let the message show before the work blocks the page.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const project = await createExampleProject(kind)
      handOver(project)
      onOpen(project.id)
    })

  const importFile = () =>
    run('Opening the file…', async () => {
      const opened = await platform.openFile()
      if (!opened) return
      const file = parseProject(opened.contents)
      const project = await createProject(file.meta.name, file)
      handOver(project)
      onOpen(project.id)
    })

  return (
    <div className="gallery">
      <header className="app-header">
        <img className="app-logo" src="/favicon.svg" alt="" width={24} height={24} />
        <h1 className="gallery-title">Plinth</h1>
        <div className="app-actions">
          <AccountButton session={session} />
          <button type="button" className="app-button" onClick={() => void importFile()} disabled={!!busy}>
            Open file…
          </button>
          <button type="button" className="app-button" onClick={onExplore} disabled={!!busy} title="Make a site from a real place">
            Explore the world
          </button>
          <button type="button" className="app-button app-button-primary" onClick={() => void newCity()} disabled={!!busy}>
            New city
          </button>
        </div>
      </header>
      <main className="gallery-main">
        {error && (
          <p className="gallery-error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p className="gallery-busy" role="status">
            {busy}
          </p>
        )}
        <section aria-labelledby="gallery-yours">
          <h2 id="gallery-yours" className="gallery-heading">
            Your cities
          </h2>
          {projects === null ? (
            <p className="gallery-note">Loading…</p>
          ) : projects.length === 0 ? (
            <p className="gallery-note">No cities yet. Start a new one, or make a copy of the example below.</p>
          ) : (
            <ul className="gallery-grid">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  canShare={!!session}
                  onShare={() => run('Sharing in the cloud…', async () => {
                    const cloudId = await createCloudProject(project.name)
                    await linkToCloud(project.id, cloudId)
                    await refresh()
                  })}
                  onInvite={() => setInviting(project)}
                  onOpen={() => onOpen(project.id)}
                  onRename={(name) => run('Renaming…', async () => {
                    const opened = await openProject(project.id)
                    opened.doc.transact((tx) => tx.setMeta({ name }))
                    opened.close()
                    await updateProject(project.id, { name, updatedAt: Date.now() })
                    await refresh()
                  })}
                  onDuplicate={() => run('Duplicating…', async () => {
                    await duplicateProject(project.id)
                    await refresh()
                  })}
                  onDownload={() => run('Saving the file…', async () => {
                    const opened = await openProject(project.id)
                    try {
                      await platform.saveFile(serializeProject(opened.doc.getSnapshot()), `${fileSafe(project.name)}.plinth`, null)
                    } finally {
                      opened.close()
                    }
                  })}
                  onDelete={() => run('Deleting…', async () => {
                    if (!(await platform.confirm(`Delete “${project.name}”? This can't be undone.`))) return
                    await deleteProject(project.id)
                    await refresh()
                  })}
                />
              ))}
            </ul>
          )}
        </section>
        <SharedWithYou
          session={session}
          known={new Set((projects ?? []).flatMap((p) => (p.cloudId ? [p.cloudId] : [])))}
          onOpen={(cloud) => run('Opening the shared city…', async () => onOpen(await localCopyOf(cloud.id, cloud.name)))}
        />
        <section aria-labelledby="gallery-examples">
          <h2 id="gallery-examples" className="gallery-heading">
            Examples
          </h2>
          <div className="gallery-example">
            <div>
              <h3>{EXAMPLE_CITY_NAME}</h3>
              <p>
                A harbour city of about 160 buildings: towers on podiums downtown, courtyard blocks, terraced houses
                and villas, warehouses, a waterfront row along a curved harbour drive, and a town hall and library with
                their rooms drawn inside. Streets with bike lanes, parking and zebra crossings, and a diagonal road
                through a park.
              </p>
            </div>
            <button type="button" className="app-button" onClick={() => void fromExample('harbour')} disabled={!!busy}>
              Make a copy
            </button>
          </div>
          <div className="gallery-example">
            <div>
              <h3>{METROPOLIS_NAME}</h3>
              <p>
                A stress test the size of Manhattan: a grid of 12 avenues and 200 cross streets, about 21 km by 3 km,
                a large park, and some 44,000 buildings rising to towers of up to 90 floors downtown and in midtown.
                Takes a few seconds to build and wants a desktop computer.
              </p>
            </div>
            <button type="button" className="app-button" onClick={() => void fromExample('metropolis')} disabled={!!busy}>
              Make a copy
            </button>
          </div>
        </section>
      </main>
      {inviting?.cloudId && <InviteDialog cloudId={inviting.cloudId} name={inviting.name} onClose={() => setInviting(null)} />}
    </div>
  )
}

interface CardProps {
  project: ProjectRecord
  /** Signed in, so the city can be shared. */
  canShare: boolean
  onShare: () => void
  onInvite: () => void
  onOpen: () => void
  onRename: (name: string) => void
  onDuplicate: () => void
  onDownload: () => void
  onDelete: () => void
}

function ProjectCard({ project, canShare, onShare, onInvite, onOpen, onRename, onDuplicate, onDownload, onDelete }: CardProps) {
  const thumbnail = useObjectUrl(project.thumbnail)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  const stats = project.stats
  return (
    <li className="gallery-card">
      <button type="button" className="gallery-thumb" onClick={onOpen} aria-label={`Open ${project.name}`}>
        {thumbnail ? <img src={thumbnail} alt="" /> : <span className="gallery-thumb-empty">No preview yet</span>}
      </button>
      <div className="gallery-card-body">
        {renaming ? (
          <input
            className="gallery-rename"
            defaultValue={project.name}
            aria-label="City name"
            autoFocus
            onBlur={(e) => {
              const name = e.target.value.trim()
              setRenaming(false)
              if (name && name !== project.name) onRename(name)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.currentTarget.value = project.name
                e.currentTarget.blur()
              }
            }}
          />
        ) : (
          <button type="button" className="gallery-name" onClick={onOpen}>
            {project.name}
          </button>
        )}
        <p className="gallery-meta">
          {stats
            ? `${stats.buildings} ${stats.buildings === 1 ? 'building' : 'buildings'} · ${stats.streets} streets · ${Math.round(stats.floorArea).toLocaleString()} m²`
            : ''}
        </p>
        <p className="gallery-meta">
          Edited {timeAgo(project.updatedAt)}
          {project.cloudId && <span className="gallery-badge">Shared</span>}
        </p>
      </div>
      <div className="gallery-card-menu" ref={menuRef}>
        <button
          type="button"
          className="gallery-more"
          aria-label={`More for ${project.name}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          ⋯
        </button>
        {menu && (
          <div className="app-menu-list" role="menu">
            {[
              ['Open', onOpen],
              ['Rename', () => setRenaming(true)],
              ['Duplicate', onDuplicate],
              ['Save as file…', onDownload],
              ...(canShare ? [project.cloudId ? ['Invite people…', onInvite] : ['Share in the cloud', onShare]] : []),
              ['Delete', onDelete],
            ].map(([label, action]) => (
              <button
                key={label as string}
                type="button"
                role="menuitem"
                className="app-menu-item"
                data-danger={label === 'Delete' || undefined}
                onClick={() => {
                  setMenu(false)
                  ;(action as () => void)()
                }}
              >
                {label as string}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

/** An object URL for a blob, revoked when it changes or the component goes. */
function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob])
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )
  return url
}

function timeAgo(time: number): string {
  const seconds = Math.max(0, (Date.now() - time) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(time).toLocaleDateString()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
