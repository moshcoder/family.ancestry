/**
 * The family photo album: every photo in the tree in one place, and albums
 * ("Christmas 1985", "Grandma's 90th") that any verified member can add to.
 *
 * Verified means a member of the tree (owner, editor or viewer) who signed in
 * with their own email: the magic link proved it. An account that arrived by
 * pit.world alone has no email of its own (a placeholder @pit.invalid), so it
 * can look at the album but not add to it until it signs in with an email.
 *
 * Whoever uploaded a photo can caption it, say who is in it, move it to
 * another album or delete it; so can the tree's editors and owner. Whoever made
 * an album can rename or delete it (its photos stay in the tree).
 */
import type { Context, Hono } from 'hono'
import { canEdit, emailVerified, fullName, type Album, type Media, type Person, type Role, type Store, type Tree, type User } from './db.js'
import * as html from './html.js'
import type { Ctx } from './html.js'

export type AlbumDeps = {
  store: Store
  site: string
  ctx: (c: Context, extra?: Partial<Ctx>) => Ctx
  form: (c: Context) => Promise<Record<string, any>>
  treeFor: (c: Context, need?: 'view' | 'edit' | 'manage' | 'owner') => { error: Response } | { error?: undefined; tree: Tree; role: Role; user: User }
  image: { types: Set<string>; max: number }
  /** Photos one person may upload a day, across every tree. */
  dailyUploads?: number
}

/** At most this many files in one form post (the page's script sends them one at a time). */
export const FILES_PER_POST = 20
export const DAILY_UPLOADS = 500

/** What the bytes are, whatever the browser said: JPEG, PNG, GIF, WebP or AVIF, or null. */
export function sniffImage(data: Uint8Array): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => data[i + k] === b)
  const ascii = (i: number, s: string) => [...s].every((ch, k) => data[i + k] === ch.charCodeAt(0))
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif'
  return null
}

type Photo = Media & { uploader: string | null }
type Access = { tree: Tree; role: Role; user: User }

export const canUpload = (a: Pick<Access, 'role' | 'user'>) => Boolean(a.role) && emailVerified(a.user)
export const canManagePhoto = (a: Pick<Access, 'role' | 'user'>, m: Pick<Media, 'uploaded_by'>) => canEdit(a.role) || (Boolean(m.uploaded_by) && m.uploaded_by === a.user.id)
export const canManageAlbum = (a: Pick<Access, 'role' | 'user'>, album: Pick<Album, 'created_by'>) => canEdit(a.role) || album.created_by === a.user.id

// ---- pages ------------------------------------------------------------------

const esc = html.esc
const csrf = (ctx: Ctx) => html.csrfField(ctx)
const when = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const personOptions = (people: Person[], selected: string | null = null) =>
  `<option value="">— nobody in particular —</option>${people.map((p) => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${esc(fullName(p))}${p.kind === 'pet' ? ' (pet)' : ''}</option>`).join('')}`
const albumOptions = (albums: Album[], selected: string | null = null, none = '— no album, just the family photos —') =>
  `<option value="">${esc(none)}</option>${albums.map((a) => `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${esc(a.title)}</option>`).join('')}`

function grid(tree: Tree, photos: Photo[]): string {
  if (!photos.length) return '<p class="empty">No photos here yet.</p>'
  return `<div class="photos album-grid">${photos
    .map((m) => `<figure><a href="/t/${tree.id}/photo/${m.id}"><img loading="lazy" src="/t/${tree.id}/media/${m.id}" alt="${esc(m.caption ?? m.filename)}"></a><figcaption>${esc(m.caption ?? '')}${m.uploader ? `<span class="by">${esc(m.uploader.replace(/@.*/, ''))}</span>` : ''}</figcaption></figure>`)
    .join('')}</div>`
}

function uploadForm(ctx: Ctx, tree: Tree, access: Access, albums: Album[], people: Person[], albumId: string | null): string {
  if (!canUpload(access))
    return `<p class="panel muted">You can look at the family photos. To add yours, <a href="/signin?next=${encodeURIComponent(`/t/${tree.id}/photos`)}">sign in with your email</a> once, so the family knows the photos came from you.</p>`
  return `<form method="post" action="/t/${tree.id}/photos" enctype="multipart/form-data" class="panel pform" data-album-upload>${csrf(ctx)}
<h2>Add photos</h2>
<label>Photos <span class="muted small">JPEG, PNG, GIF, WebP or AVIF, up to 8 MB each; pick as many as you like</span><input type="file" name="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif" multiple required></label>
<div class="grid2"><label>Album<select name="album_id">${albumOptions(albums, albumId)}</select></label><label>Or start a new album<input name="album_title" maxlength="200" placeholder="Christmas 1985"></label></div>
<div class="grid2"><label>Who is in them <span class="muted small">optional</span><select name="person_id">${personOptions(people)}</select></label><label>Caption <span class="muted small">optional, for all of them</span><input name="caption" maxlength="1000" placeholder="Lake Tahoe, summer 1978"></label></div>
<p class="muted small" data-upload-status hidden></p>
<button>Upload</button></form>`
}

export function photosPage(ctx: Ctx, access: Access, v: { albums: (Album & { photos: number; cover: string | null })[]; photos: Photo[]; people: Person[]; more: number | null }): string {
  const { tree } = access
  const albums = v.albums.length
    ? `<ul class="albums">${v.albums.map((a) => `<li><a href="/t/${tree.id}/albums/${a.id}">${a.cover ? `<img loading="lazy" src="/t/${tree.id}/media/${a.cover}" alt="">` : '<span class="nocover">no photos yet</span>'}<b>${esc(a.title)}</b><span class="muted small">${a.photos} photo${a.photos === 1 ? '' : 's'}</span></a></li>`).join('')}</ul>`
    : '<p class="muted">No albums yet. Start one when you upload, or below.</p>'
  return html.layout(
    ctx,
    `Photos · ${tree.name}`,
    `<h1>Family photos</h1>
<p class="muted">Every photo in ${esc(tree.name)}, newest first: people's, businesses' and everything the family shared. Only members of the tree can see them.</p>
${uploadForm(ctx, tree, access, v.albums, v.people, null)}
<section><h2>Albums</h2>${albums}
${canUpload(access) ? `<details class="panel"><summary>New album</summary><form method="post" action="/t/${tree.id}/albums" class="pform">${csrf(ctx)}<label>Title<input name="title" maxlength="200" required placeholder="Grandma's 90th"></label><label>About it <span class="muted small">optional</span><textarea name="description" rows="2" maxlength="2000"></textarea></label><button>Create album</button></form></details>` : ''}</section>
<section><h2>All photos</h2>${grid(tree, v.photos)}${v.more ? `<p><a class="btn" href="/t/${tree.id}/photos?before=${v.more}">Older photos</a></p>` : ''}</section>`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', 'Photos']], wide: true },
  )
}

export function albumPage(ctx: Ctx, access: Access, v: { album: Album; albums: Album[]; photos: Photo[]; people: Person[]; creator: string | null; more: number | null }): string {
  const { tree } = access
  const a = v.album
  const manage = canManageAlbum(access, a)
  return html.layout(
    ctx,
    `${a.title} · ${tree.name}`,
    `<h1>${esc(a.title)}</h1>
<p class="muted">${a.description ? `${esc(a.description)} · ` : ''}${v.creator ? `started by ${esc(v.creator)} · ` : ''}${when(a.created_at)}</p>
${uploadForm(ctx, tree, access, v.albums, v.people, a.id)}
${grid(tree, v.photos)}${v.more ? `<p><a class="btn" href="/t/${tree.id}/albums/${a.id}?before=${v.more}">Older photos</a></p>` : ''}
${manage ? `<details class="panel"><summary>Edit album</summary><form method="post" action="/t/${tree.id}/albums/${a.id}" class="pform">${csrf(ctx)}<label>Title<input name="title" value="${esc(a.title)}" maxlength="200" required></label><label>About it<textarea name="description" rows="2" maxlength="2000">${esc(a.description ?? '')}</textarea></label><button>Save</button></form>
<form method="post" action="/t/${tree.id}/albums/${a.id}/delete" class="inline" data-confirm="Delete this album? Its photos stay in the family photos.">${csrf(ctx)}<button class="x">Delete album</button></form></details>` : ''}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], [`/t/${tree.id}/photos`, 'Photos'], ['', a.title]], wide: true },
  )
}

export function photoPage(ctx: Ctx, access: Access, v: { photo: Photo; album: Album | null; albums: Album[]; person: Person | null; business: { id: string; name: string } | null; people: Person[] }): string {
  const { tree } = access
  const m = v.photo
  const manage = canManagePhoto(access, m)
  const facts = [
    v.person ? `<a class="pl sex-${v.person.sex}" href="/t/${tree.id}/p/${v.person.id}">${esc(fullName(v.person))}</a>` : '',
    v.business ? `<a class="pl biz" href="/t/${tree.id}/b/${v.business.id}">${esc(v.business.name)}</a>` : '',
    v.album ? `in <a href="/t/${tree.id}/albums/${v.album.id}">${esc(v.album.title)}</a>` : '',
    m.uploader ? `shared by ${esc(m.uploader)}` : '',
    when(m.created_at),
  ].filter(Boolean)
  return html.layout(
    ctx,
    `${m.caption ?? 'Photo'} · ${tree.name}`,
    `<figure class="photo-full"><a href="/t/${tree.id}/media/${m.id}"><img src="/t/${tree.id}/media/${m.id}" alt="${esc(m.caption ?? m.filename)}"></a>${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>
<p class="muted">${facts.join(' · ')}</p>
${manage ? `<details class="panel"><summary>Edit photo</summary><form method="post" action="/t/${tree.id}/photo/${m.id}" class="pform">${csrf(ctx)}<label>Caption<input name="caption" value="${esc(m.caption ?? '')}" maxlength="1000"></label>
<div class="grid2"><label>Who is in it<select name="person_id">${personOptions(v.people, m.person_id)}</select></label><label>Album<select name="album_id">${albumOptions(v.albums, m.album_id ?? null, '— no album —')}</select></label></div><button>Save</button></form>
<form method="post" action="/t/${tree.id}/photo/${m.id}/delete" class="inline" data-confirm="Delete this photo for everyone?">${csrf(ctx)}<button class="x">Delete photo</button></form></details>` : ''}
${v.album && canManageAlbum(access, v.album) && v.album.cover_id !== m.id ? `<form method="post" action="/t/${tree.id}/albums/${v.album.id}" class="inline">${csrf(ctx)}<input type="hidden" name="cover_id" value="${m.id}"><button class="link small">Use as the album cover</button></form>` : ''}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], [`/t/${tree.id}/photos`, 'Photos'], ...(v.album ? ([[`/t/${tree.id}/albums/${v.album.id}`, v.album.title]] as [string, string][]) : []), ['', 'Photo']] },
  )
}

// ---- routes -------------------------------------------------------------------

export function mountAlbums(app: Hono<any>, api: Hono<any>, d: AlbumDeps) {
  const { store, site } = d
  const daily = d.dailyUploads ?? DAILY_UPLOADS
  const flash = (path: string, message: string) => `${path}?ok=${encodeURIComponent(message)}`
  const people = (treeId: string) => store.people(treeId, 5000)
  const page = (c: Context) => {
    const before = Number(c.req.query('before'))
    return Number.isFinite(before) && before > 0 ? before : null
  }
  const PAGE = 120
  const more = (photos: Photo[]) => (photos.length === PAGE ? photos[photos.length - 1]!.created_at : null)
  const userName = (id: string | null | undefined) => {
    const u = id ? store.user(id) : null
    return u ? (u.name ?? (emailVerified(u) ? u.email : null)) : null
  }

  /**
   * Store photos from a form or an API call. Every file is checked by its bytes,
   * not by what the browser called it. Returns what was saved and what was refused.
   */
  const save = (
    access: Access,
    files: { name: string; data: Uint8Array }[],
    body: Record<string, any>,
  ): { saved: Media[]; refused: string[]; album: Album | null } => {
    if (!canUpload(access)) throw new Error('sign in with your email to add photos')
    const treeId = access.tree.id
    const refused: string[] = []
    let left = daily - store.uploadsSince(access.user.id, Date.now() - 86_400_000)
    if (left <= 0) throw new Error(`that is ${daily} photos today, the most one person can add in a day; try again tomorrow`)
    const personId = body.person_id ? String(body.person_id) : null
    if (personId && !store.person(treeId, personId)) throw new Error('that person is not in this tree')
    return store.tx(() => {
      let album = body.album_id ? store.album(treeId, String(body.album_id)) : null
      if (body.album_id && !album) throw new Error('no such album in this tree')
      const title = String(body.album_title ?? body.album ?? '').trim()
      if (!album && title) album = store.albums(treeId).find((a) => a.title.toLowerCase() === title.toLowerCase()) ?? store.addAlbum(treeId, access.user.id, { title })
      const saved: Media[] = []
      for (const f of files) {
        const mime = sniffImage(f.data)
        if (!mime || !d.image.types.has(mime)) refused.push(`${f.name}: not a JPEG, PNG, GIF, WebP or AVIF`)
        else if (f.data.byteLength > d.image.max) refused.push(`${f.name}: over 8 MB`)
        else if (left <= 0) refused.push(`${f.name}: over today's limit of ${daily}`)
        else {
          saved.push(store.addMedia(treeId, personId, { filename: f.name, mime, data: f.data, caption: body.caption ?? null, albumId: album?.id ?? null, uploadedBy: access.user.id }))
          left--
        }
      }
      return { saved, refused, album }
    })
  }
  const filesFrom = async (value: unknown): Promise<{ name: string; data: Uint8Array }[]> => {
    const list = (Array.isArray(value) ? value : [value]).filter((f): f is File => f instanceof File && f.size > 0).slice(0, FILES_PER_POST)
    return Promise.all(list.map(async (f) => ({ name: f.name || 'photo', data: new Uint8Array(await f.arrayBuffer()) })))
  }
  const photoOut = (treeId: string, m: Media & { uploader?: string | null }) => ({ ...m, url: `${site}/t/${treeId}/media/${m.id}`, page: `${site}/t/${treeId}/photo/${m.id}` })
  const albumOut = (treeId: string, a: Album & { photos?: number; cover?: string | null }) => ({ ...a, url: `${site}/t/${treeId}/albums/${a.id}` })

  // ---- pages ----
  app.get('/t/:tree/photos', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const photos = store.photos(t.tree.id, { limit: PAGE, before: page(c) })
    return c.html(photosPage(d.ctx(c), t, { albums: store.albums(t.tree.id), photos, people: canUpload(t) ? people(t.tree.id) : [], more: more(photos) }))
  })
  app.post('/t/:tree/photos', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const wantsJson = (c.req.header('accept') ?? '').includes('application/json')
    const body = await d.form(c)
    // The CSRF check read the form once keeping one value per field; read it again for every file.
    const all = (await c.req.parseBody({ all: true }).catch(() => ({}))) as Record<string, unknown>
    const back = body.back_album ? `/t/${t.tree.id}/albums/${String(body.back_album).replace(/[^A-Za-z0-9_-]/g, '')}` : `/t/${t.tree.id}/photos`
    try {
      const files = await filesFrom(all.file ?? body.file)
      if (!files.length) throw new Error('pick at least one photo')
      const r = save(t, files, body)
      if (wantsJson) return c.json({ saved: r.saved.map((m) => photoOut(t.tree.id, m)), refused: r.refused, album: r.album ? albumOut(t.tree.id, r.album) : null }, r.saved.length ? 201 : 400)
      const where = r.album ? `/t/${t.tree.id}/albums/${r.album.id}` : back
      const note = `${r.saved.length} photo${r.saved.length === 1 ? '' : 's'} added${r.refused.length ? `; not added: ${r.refused.join('; ')}` : ''}`
      return c.redirect(flash(where, note))
    } catch (error) {
      if (wantsJson) return c.json({ error: (error as Error).message }, canUpload(t) ? 400 : 403)
      return c.redirect(flash(back, `Not added: ${(error as Error).message}`))
    }
  })
  app.post('/t/:tree/albums', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const back = `/t/${t.tree.id}/photos`
    if (!canUpload(t)) return c.redirect(flash(back, 'Sign in with your email to start an album.'))
    try {
      const a = store.addAlbum(t.tree.id, t.user.id, await d.form(c))
      return c.redirect(`/t/${t.tree.id}/albums/${a.id}`)
    } catch (error) {
      return c.redirect(flash(back, `Not created: ${(error as Error).message}`))
    }
  })
  app.get('/t/:tree/albums/:album', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const album = store.album(t.tree.id, c.req.param('album')!)
    if (!album) return c.html(html.messagePage(d.ctx(c), 'Not found', 'No album by that id in this tree.'), 404)
    const photos = store.photos(t.tree.id, { albumId: album.id, limit: PAGE, before: page(c) })
    return c.html(albumPage(d.ctx(c), t, { album, albums: store.albums(t.tree.id), photos, people: canUpload(t) ? people(t.tree.id) : [], creator: userName(album.created_by), more: more(photos) }))
  })
  app.post('/t/:tree/albums/:album', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const album = store.album(t.tree.id, c.req.param('album')!)
    if (!album) return c.notFound()
    const back = `/t/${t.tree.id}/albums/${album.id}`
    if (!canManageAlbum(t, album)) return c.redirect(flash(back, 'Only whoever started this album, or an editor, can change it.'))
    store.updateAlbum(t.tree.id, album.id, await d.form(c))
    return c.redirect(flash(back, 'Saved'))
  })
  app.post('/t/:tree/albums/:album/delete', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const album = store.album(t.tree.id, c.req.param('album')!)
    if (!album) return c.notFound()
    if (!canManageAlbum(t, album)) return c.redirect(flash(`/t/${t.tree.id}/albums/${album.id}`, 'Only whoever started this album, or an editor, can delete it.'))
    store.deleteAlbum(t.tree.id, album.id)
    return c.redirect(flash(`/t/${t.tree.id}/photos`, 'Album deleted; its photos are still here'))
  })
  const photoFor = (treeId: string, id: string): Photo | null => {
    const m = store.mediaInfo(treeId, id)
    return m ? { ...m, uploader: userName(m.uploaded_by) } : null
  }
  app.get('/t/:tree/photo/:media', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const photo = photoFor(t.tree.id, c.req.param('media')!)
    if (!photo) return c.html(html.messagePage(d.ctx(c), 'Not found', 'No photo by that id in this tree.'), 404)
    const business = photo.business_id ? store.business(t.tree.id, photo.business_id) : null
    return c.html(
      photoPage(d.ctx(c), t, {
        photo,
        album: photo.album_id ? store.album(t.tree.id, photo.album_id) : null,
        albums: store.albums(t.tree.id),
        person: photo.person_id ? store.person(t.tree.id, photo.person_id) : null,
        business: business ? { id: business.id, name: business.name } : null,
        people: canManagePhoto(t, photo) ? people(t.tree.id) : [],
      }),
    )
  })
  app.post('/t/:tree/photo/:media', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const m = store.mediaInfo(t.tree.id, c.req.param('media')!)
    if (!m) return c.notFound()
    const back = `/t/${t.tree.id}/photo/${m.id}`
    if (!canManagePhoto(t, m)) return c.redirect(flash(back, 'Only whoever shared this photo, or an editor, can change it.'))
    try {
      const body = await d.form(c)
      store.updateMedia(t.tree.id, m.id, { caption: body.caption, person_id: body.person_id, album_id: body.album_id })
      return c.redirect(flash(back, 'Saved'))
    } catch (error) {
      return c.redirect(flash(back, (error as Error).message))
    }
  })
  app.post('/t/:tree/photo/:media/delete', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const m = store.mediaInfo(t.tree.id, c.req.param('media')!)
    if (!m) return c.notFound()
    if (!canManagePhoto(t, m)) return c.redirect(flash(`/t/${t.tree.id}/photo/${m.id}`, 'Only whoever shared this photo, or an editor, can delete it.'))
    store.deleteMedia(t.tree.id, m.id)
    return c.redirect(flash(m.album_id ? `/t/${t.tree.id}/albums/${m.album_id}` : `/t/${t.tree.id}/photos`, 'Photo deleted'))
  })

  // ---- /api/v1 ----
  const bad = (c: Context, error: unknown, status: 400 | 403 | 404 = 400) => c.json({ error: error instanceof Error ? error.message : String(error) }, status)
  const json = async (c: Context): Promise<Record<string, any>> => ((await c.req.json().catch(() => ({}))) as Record<string, any>) ?? {}

  api.get('/trees/:tree/albums', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    return c.json({ albums: store.albums(t.tree.id).map((a) => albumOut(t.tree.id, a)), can_upload: canUpload(t) })
  })
  /** {title, description?} */
  api.post('/trees/:tree/albums', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    if (!canUpload(t)) return bad(c, 'sign in with your email to start an album', 403)
    try {
      return c.json({ album: albumOut(t.tree.id, store.addAlbum(t.tree.id, t.user.id, await json(c))) }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.get('/trees/:tree/albums/:album', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const a = store.album(t.tree.id, c.req.param('album')!)
    if (!a) return bad(c, 'no such album', 404)
    const limit = Math.min(500, Number(c.req.query('limit')) || 200)
    return c.json({ album: albumOut(t.tree.id, a), photos: store.photos(t.tree.id, { albumId: a.id, limit, before: page(c) }).map((m) => photoOut(t.tree.id, m)) })
  })
  /** {title?, description?, cover_id?} */
  api.patch('/trees/:tree/albums/:album', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const a = store.album(t.tree.id, c.req.param('album')!)
    if (!a) return bad(c, 'no such album', 404)
    if (!canManageAlbum(t, a)) return bad(c, 'only whoever started this album, or an editor, can change it', 403)
    return c.json({ album: albumOut(t.tree.id, store.updateAlbum(t.tree.id, a.id, await json(c))!) })
  })
  api.delete('/trees/:tree/albums/:album', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const a = store.album(t.tree.id, c.req.param('album')!)
    if (!a) return bad(c, 'no such album', 404)
    if (!canManageAlbum(t, a)) return bad(c, 'only whoever started this album, or an editor, can delete it', 403)
    store.deleteAlbum(t.tree.id, a.id)
    return c.json({ ok: true })
  })
  api.get('/trees/:tree/photos', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const limit = Math.min(500, Number(c.req.query('limit')) || 200)
    return c.json({ photos: store.photos(t.tree.id, { albumId: c.req.query('album') || null, limit, before: page(c) }).map((m) => photoOut(t.tree.id, m)), can_upload: canUpload(t) })
  })
  /**
   * Multipart (file, as many as FILES_PER_POST; caption?, album_id? or album_title?, person_id?),
   * or JSON {filename, data_base64, caption?, album_id? | album_title?, person_id?}.
   */
  api.post('/trees/:tree/photos', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    if (!canUpload(t)) return bad(c, 'sign in with your email to add photos', 403)
    try {
      let body: Record<string, any>
      let files: { name: string; data: Uint8Array }[]
      if ((c.req.header('content-type') ?? '').includes('application/json')) {
        body = await json(c)
        if (typeof body.data_base64 !== 'string' || !body.data_base64) throw new Error('send data_base64 (the photo, base64) and a filename')
        files = [{ name: String(body.filename ?? 'photo'), data: new Uint8Array(Buffer.from(body.data_base64, 'base64')) }]
      } else {
        body = (await c.req.parseBody({ all: true }).catch(() => ({}))) as Record<string, any>
        files = await filesFrom(body.file)
        for (const k of ['caption', 'album_id', 'album_title', 'person_id']) if (Array.isArray(body[k])) body[k] = body[k][0]
      }
      if (!files.length) throw new Error('send at least one photo')
      const r = save(t, files, body)
      return c.json({ saved: r.saved.map((m) => photoOut(t.tree.id, m)), refused: r.refused, album: r.album ? albumOut(t.tree.id, r.album) : null }, r.saved.length ? 201 : 400)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.get('/trees/:tree/photos/:media', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const m = photoFor(t.tree.id, c.req.param('media')!)
    return m ? c.json({ photo: photoOut(t.tree.id, m) }) : bad(c, 'no such photo', 404)
  })
  /** {caption?, person_id?, album_id?} */
  api.patch('/trees/:tree/photos/:media', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const m = store.mediaInfo(t.tree.id, c.req.param('media')!)
    if (!m) return bad(c, 'no such photo', 404)
    if (!canManagePhoto(t, m)) return bad(c, 'only whoever shared this photo, or an editor, can change it', 403)
    try {
      return c.json({ photo: photoOut(t.tree.id, store.updateMedia(t.tree.id, m.id, await json(c))!) })
    } catch (error) {
      return bad(c, error)
    }
  })
  api.delete('/trees/:tree/photos/:media', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const m = store.mediaInfo(t.tree.id, c.req.param('media')!)
    if (!m) return bad(c, 'no such photo', 404)
    if (!canManagePhoto(t, m)) return bad(c, 'only whoever shared this photo, or an editor, can delete it', 403)
    store.deleteMedia(t.tree.id, m.id)
    return c.json({ ok: true })
  })
}
