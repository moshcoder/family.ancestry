import { describe, expect, test } from 'bun:test'
import { Store, emailVerified, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { Network } from '../src/network.ts'
import { createApp } from '../src/server.ts'
import { sniffImage } from '../src/album.ts'

const SITE = 'http://family.test'
const RELAY = 'https://family.test.pit.world'
const CSRF = 'csrfcsrfcsrfcsrf1234'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
const png = (name = 'photo.png') => new File([PNG], name, { type: 'image/png' })

/** The Ettingers: an owner, an editor, two viewers (one only via pit.world), and someone outside the family. */
function family(opts: { dailyUploads?: number } = {}) {
  const store = new Store(':memory:')
  const owner = store.findOrCreateUser('owner@example.com')
  const editor = store.findOrCreateUser('editor@example.com')
  const viewer = store.findOrCreateUser('karen@example.com')
  store.setUserName(viewer.id, 'Karen')
  const bridged = store.createBridgedUser('pitworld', 'did:key:z6Mk-test', 'Bridged Cousin')
  const outsider = store.findOrCreateUser('stranger@example.com')
  const tree = store.createTree(owner.id, 'The Ettinger Family')
  store.setMember(tree.id, editor.id, 'editor')
  store.setMember(tree.id, viewer.id, 'viewer')
  store.setMember(tree.id, bridged.id, 'viewer')
  const grandma = store.addPerson(tree.id, { given: 'Rose', surname: 'Ettinger', sex: 'F', birth_date: '1931' })
  const auth = new Auth(store, async () => {}, SITE)
  const server = createApp({ store, auth, site: SITE, publicSite: RELAY, net: new Network(store), redirectHosts: ['family.tree'] })
  const as = (user: User) => {
    const cookie = `fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`
    const bearer = auth.createToken(user.id, 'test')
    return {
      get: (path: string) => server.request(`${SITE}${path}`, { headers: { cookie } }),
      post: (path: string, fields: Record<string, string> = {}) => server.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
      upload: (path: string, form: FormData, headers: Record<string, string> = {}) => (form.set('_csrf', CSRF), server.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, ...headers }, body: form })),
      api: (path: string, method = 'GET', body?: unknown) => server.request(`${SITE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    }
  }
  return { store, owner, editor, viewer, bridged, outsider, tree, grandma, server, as }
}

const formOf = (fields: Record<string, string>, files: File[]) => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  for (const f of files) form.append('file', f)
  return form
}

describe('the photo album in the store', () => {
  test('albums hold photos; deleting an album keeps its photos; covers follow the photos', () => {
    const { store, tree, viewer, grandma } = family()
    const xmas = store.addAlbum(tree.id, viewer.id, { title: 'Christmas 1985', description: 'At Rose and Karl’s' })
    const a = store.addMedia(tree.id, grandma.id, { filename: 'tree.png', mime: 'image/png', data: PNG, caption: 'The tree', albumId: xmas.id, uploadedBy: viewer.id })
    const b = store.addMedia(tree.id, null, { filename: 'presents.png', mime: 'image/png', data: PNG, albumId: xmas.id, uploadedBy: viewer.id })
    store.addMedia(tree.id, grandma.id, { filename: 'portrait.png', mime: 'image/png', data: PNG })
    expect(store.albums(tree.id)).toMatchObject([{ title: 'Christmas 1985', photos: 2, cover: b.id }])
    expect(store.photos(tree.id).length).toBe(3)
    expect(store.photos(tree.id, { albumId: xmas.id }).map((m) => [m.filename, m.uploader])).toEqual([['presents.png', 'Karen'], ['tree.png', 'Karen']])
    // A person in an album photo gets it on their own page too (and it becomes their portrait if they had none).
    expect(store.mediaFor(tree.id, grandma.id).map((m) => m.id)).toContain(a.id)
    expect(store.person(tree.id, grandma.id)!.photo_id).toBe(a.id)

    store.updateAlbum(tree.id, xmas.id, { cover_id: a.id })
    expect(store.albums(tree.id)[0]!.cover).toBe(a.id)
    store.deleteMedia(tree.id, a.id)
    expect(store.album(tree.id, xmas.id)!.cover_id).toBeNull()
    store.deleteAlbum(tree.id, xmas.id)
    expect(store.albums(tree.id)).toEqual([])
    expect(store.mediaInfo(tree.id, b.id)!.album_id).toBeNull()
  })

  test('moving a photo, and who is in it', () => {
    const { store, tree, viewer, grandma } = family()
    const one = store.addAlbum(tree.id, viewer.id, { title: 'One' })
    const two = store.addAlbum(tree.id, viewer.id, { title: 'Two' })
    const m = store.addMedia(tree.id, null, { filename: 'x.png', mime: 'image/png', data: PNG, albumId: one.id })
    store.updateMedia(tree.id, m.id, { album_id: two.id, person_id: grandma.id, caption: 'Rose at the lake' })
    expect(store.mediaInfo(tree.id, m.id)).toMatchObject({ album_id: two.id, person_id: grandma.id, caption: 'Rose at the lake' })
    store.updateMedia(tree.id, m.id, { person_id: '' })
    expect(store.person(tree.id, grandma.id)!.photo_id).toBeNull()
    expect(() => store.updateMedia(tree.id, m.id, { album_id: 'nope' })).toThrow('no such album')
  })

  test('the bytes decide what a file is', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('GIF89a....'))).toBe('image/gif')
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull()
  })

  test('verified means an email of their own', () => {
    const { viewer, bridged } = family()
    expect(emailVerified(viewer)).toBe(true)
    expect(emailVerified(bridged)).toBe(false)
  })
})

describe('the photo album on the web', () => {
  test('a viewer who signed in with email uploads several photos into a new album (no JavaScript)', async () => {
    const { tree, viewer, store, as } = family()
    const karen = as(viewer)
    const res = await karen.upload(`/t/${tree.id}/photos`, formOf({ album_title: 'Lake Tahoe 1978', caption: 'Summer' }, [png('a.png'), png('b.png'), png('c.png')]))
    expect(res.status).toBe(302)
    const album = store.albums(tree.id)[0]!
    expect(album).toMatchObject({ title: 'Lake Tahoe 1978', photos: 3, created_by: viewer.id })
    expect(res.headers.get('location')).toBe(`/t/${tree.id}/albums/${album.id}?ok=${encodeURIComponent('3 photos added')}`)
    const page = await (await karen.get(`/t/${tree.id}/albums/${album.id}`)).text()
    expect(page).toContain('Lake Tahoe 1978')
    expect(page.match(/class="by">Karen</g)?.length).toBe(3)
    // The same title again lands in the same album.
    await karen.upload(`/t/${tree.id}/photos`, formOf({ album_title: 'lake tahoe 1978' }, [png()]))
    expect(store.albums(tree.id)).toMatchObject([{ photos: 4 }])
    const all = await (await karen.get(`/t/${tree.id}/photos`)).text()
    expect(all).toContain('Family photos')
    expect(all).toContain('data-album-upload')
  })

  test('the page script posts one file at a time and gets JSON back', async () => {
    const { tree, viewer, as } = family()
    const res = await as(viewer).upload(`/t/${tree.id}/photos`, formOf({ album_title: 'Grandma’s 90th' }, [png()]), { accept: 'application/json' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.saved.length).toBe(1)
    expect(body.album.title).toBe('Grandma’s 90th')
    expect(body.album.url).toBe(`${SITE}/t/${tree.id}/albums/${body.album.id}`)
  })

  test('anything that is not an image is refused by its bytes, whatever it claims to be', async () => {
    const { tree, viewer, store, as } = family()
    const fake = new File([new TextEncoder().encode('<script>alert(1)</script>')], 'evil.png', { type: 'image/png' })
    const res = await as(viewer).upload(`/t/${tree.id}/photos`, formOf({}, [fake, png('ok.png')]), { accept: 'application/json' })
    const body = (await res.json()) as any
    expect(body.saved.map((m: any) => m.filename)).toEqual(['ok.png'])
    expect(body.refused).toEqual(['evil.png: not a JPEG, PNG, GIF, WebP or AVIF'])
    expect(store.photos(tree.id).length).toBe(1)
  })

  test('a pit.world-only account can look but not add; outsiders see nothing', async () => {
    const { tree, bridged, outsider, store, as } = family()
    const cousin = as(bridged)
    const page = await (await cousin.get(`/t/${tree.id}/photos`)).text()
    expect(page).toContain('sign in with your email')
    expect(page).not.toContain('data-album-upload')
    const res = await cousin.upload(`/t/${tree.id}/photos`, formOf({}, [png()]))
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('Not added: sign in with your email to add photos')
    expect((await cousin.post(`/t/${tree.id}/albums`, { title: 'Mine' })).status).toBe(302)
    expect(store.albums(tree.id)).toEqual([])
    expect(store.photos(tree.id)).toEqual([])
    const stranger = as(outsider)
    expect((await stranger.get(`/t/${tree.id}/photos`)).status).toBe(404)
    expect((await stranger.upload(`/t/${tree.id}/photos`, formOf({}, [png()]))).status).toBe(404)
  })

  test('who may change or delete: the uploader and editors, not other viewers', async () => {
    const { tree, viewer, editor, owner, store, as } = family()
    const other = store.findOrCreateUser('nanette@example.com')
    store.setMember(tree.id, other.id, 'viewer')
    const mine = store.addMedia(tree.id, null, { filename: 'k.png', mime: 'image/png', data: PNG, uploadedBy: viewer.id })
    const nan = as(other)
    expect(await (await nan.get(`/t/${tree.id}/photo/${mine.id}`)).text()).not.toContain('Edit photo')
    await nan.post(`/t/${tree.id}/photo/${mine.id}`, { caption: 'vandalised' })
    await nan.post(`/t/${tree.id}/photo/${mine.id}/delete`)
    expect(store.mediaInfo(tree.id, mine.id)!.caption).toBeNull()

    const karen = as(viewer)
    expect(await (await karen.get(`/t/${tree.id}/photo/${mine.id}`)).text()).toContain('Edit photo')
    await karen.post(`/t/${tree.id}/photo/${mine.id}`, { caption: 'Karen at six', person_id: '', album_id: '' })
    expect(store.mediaInfo(tree.id, mine.id)!.caption).toBe('Karen at six')

    const theirs = store.addMedia(tree.id, null, { filename: 'o.png', mime: 'image/png', data: PNG, uploadedBy: owner.id })
    await karen.post(`/t/${tree.id}/photo/${theirs.id}/delete`)
    expect(store.mediaInfo(tree.id, theirs.id)).not.toBeNull()
    await as(editor).post(`/t/${tree.id}/photo/${theirs.id}/delete`)
    expect(store.mediaInfo(tree.id, theirs.id)).toBeNull()

    // Albums: whoever started one, or an editor.
    const album = store.addAlbum(tree.id, viewer.id, { title: 'Karen’s' })
    await nan.post(`/t/${tree.id}/albums/${album.id}`, { title: 'Nanette’s now' })
    expect(store.album(tree.id, album.id)!.title).toBe('Karen’s')
    await karen.post(`/t/${tree.id}/albums/${album.id}`, { title: 'Karen’s photos' })
    expect(store.album(tree.id, album.id)!.title).toBe('Karen’s photos')
    await as(editor).post(`/t/${tree.id}/albums/${album.id}/delete`)
    expect(store.album(tree.id, album.id)).toBeNull()
  })

  test('a daily cap per person', async () => {
    const { tree, viewer, store } = family()
    const auth = new Auth(store, async () => {}, SITE)
    const server = createApp({ store, auth, site: SITE, net: new Network(store) })
    // The cap lives in mountAlbums; 500 by default. Fill it from the store, then try one more.
    for (let i = 0; i < 500; i++) store.addMedia(tree.id, null, { filename: `${i}.png`, mime: 'image/png', data: PNG, uploadedBy: viewer.id })
    const form = formOf({ _csrf: CSRF }, [png()])
    const res = await server.request(`${SITE}/t/${tree.id}/photos`, { method: 'POST', headers: { cookie: `fa_session=${auth.createSession(viewer.id)}; fa_csrf=${CSRF}`, accept: 'application/json' }, body: form })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toContain('500 photos today')
  })

  test('the tree page links to the photos', async () => {
    const { tree, viewer, as } = family()
    expect(await (await as(viewer).get(`/t/${tree.id}`)).text()).toContain(`href="/t/${tree.id}/photos"`)
  })
})

describe('the photo album API', () => {
  test('albums and photos: list, upload as base64, change, delete', async () => {
    const { tree, viewer, grandma, as } = family()
    const api = as(viewer).api
    const created = (await (await api(`/trees/${tree.id}/albums`, 'POST', { title: 'Reunion 2026' })).json()) as any
    expect(created.album.title).toBe('Reunion 2026')
    const up = await api(`/trees/${tree.id}/photos`, 'POST', { filename: 'rose.jpg', data_base64: Buffer.from(JPEG).toString('base64'), album_id: created.album.id, person_id: grandma.id, caption: 'Rose' })
    expect(up.status).toBe(201)
    const photo = ((await up.json()) as any).saved[0]
    expect(photo).toMatchObject({ mime: 'image/jpeg', album_id: created.album.id, person_id: grandma.id, page: `${SITE}/t/${tree.id}/photo/${photo.id}` })
    const list = (await (await api(`/trees/${tree.id}/albums`)).json()) as any
    expect(list).toMatchObject({ can_upload: true, albums: [{ title: 'Reunion 2026', photos: 1 }] })
    expect(((await (await api(`/trees/${tree.id}/photos?album=${created.album.id}`)).json()) as any).photos.map((p: any) => p.uploader)).toEqual(['Karen'])
    expect(((await (await api(`/trees/${tree.id}/photos/${photo.id}`, 'PATCH', { caption: 'Rose, 95' })).json()) as any).photo.caption).toBe('Rose, 95')
    expect((await api(`/trees/${tree.id}/photos/${photo.id}`, 'DELETE')).status).toBe(200)
    expect(((await (await api(`/trees/${tree.id}/photos`)).json()) as any).photos).toEqual([])
  })

  test('a pit.world-only account gets 403 on upload', async () => {
    const { tree, bridged, as } = family()
    const res = await as(bridged).api(`/trees/${tree.id}/photos`, 'POST', { filename: 'a.png', data_base64: Buffer.from(PNG).toString('base64') })
    expect(res.status).toBe(403)
  })
})

describe('family.tree redirects to family.ancestry', () => {
  test('same path, permanently; through the relay it stays on the relay', async () => {
    const { server } = family()
    const direct = await server.request('http://family.tree/t/abc/p/def?ok=Saved', { headers: { host: 'family.tree' } })
    expect(direct.status).toBe(301)
    expect(direct.headers.get('location')).toBe(`${SITE}/t/abc/p/def?ok=Saved`)
    const relayed = await server.request('http://family.tree/photos', { headers: { host: 'family.tree', 'x-forwarded-host': 'family.tree.pit.world' } })
    expect(relayed.headers.get('location')).toBe(`${RELAY}/photos`)
    // Only the configured name redirects.
    expect((await server.request(`${SITE}/health`)).status).toBe(200)
  })
})
