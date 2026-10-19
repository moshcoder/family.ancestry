import { describe, expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'
import { Network } from '../src/network.ts'
import { slugify, validSlug } from '../src/profile.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

function world() {
  const store = new Store(':memory:')
  const auth = new Auth(store, async () => {}, SITE)
  const app = createApp({ store, auth, site: SITE, net: new Network(store) })
  const browser = (cookie: string) => ({
    get: (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } }),
    post: (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
  })
  const as = (user: User) => browser(`fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`)
  const stranger = () => browser(`fa_csrf=${CSRF}`)
  const user = (email: string, name: string | null = null) => {
    const u = store.findOrCreateUser(email)
    if (name) store.setUserName(u.id, name)
    return store.user(u.id)!
  }
  const bearer = (user: User) => {
    const token = auth.createToken(user.id, 'test')
    return {
      get: (path: string) => app.request(`${SITE}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }),
      post: (path: string, body: unknown) => app.request(`${SITE}/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }
  }
  return { store, app, as, stranger, user, bearer }
}

const ANTHONY = { slug: 'anthony.ettinger', name: 'Anthony Ettinger', nickname: 'Tony', city: 'Los Gatos', region: 'CA', country: 'USA', hometown: 'Chicago', bio: 'Builds things.', socials: 'github: chovy', links: 'blog: https://example.com/blog', email: '', published: '1' }

describe('public profiles', () => {
  test('slugs: dots between words, nothing else', () => {
    expect(slugify('Anthony Ettinger')).toBe('anthony.ettinger')
    expect(slugify('Anthony Ettinger', 'Los Gatos', 'CA', 'USA')).toBe('anthony.ettinger.los.gatos.ca.usa')
    expect(slugify('José  Núñez!')).toBe('jose.nunez')
    expect(validSlug('anthony.ettinger')).toBe(true)
    expect(validSlug('a..b')).toBe(false)
    expect(validSlug('settings')).toBe(false)
    expect(validSlug('ab')).toBe(false)
  })

  test('off until turned on; on, it shows only what the owner typed, never the tree', async () => {
    const w = world()
    const tony = w.user('tony@example.com', 'Anthony Ettinger')
    const tree = w.store.createTree(tony.id, 'The Ettinger Family')
    const me = w.store.addPerson(tree.id, { given: 'Anthony', surname: 'Ettinger', nickname: 'Tony', birth_date: '4 JUL 1975', birth_place: 'Secretville, Illinois', living: '1' })
    const mom = w.store.addPerson(tree.id, { given: 'Maidenname', surname: 'Motherly', living: '1' })
    w.store.db.query('INSERT INTO profiles (tree_id, person_id, user_id, created_at) VALUES (?,?,?,?)').run(tree.id, me.id, tony.id, Date.now())

    // The form starts from the claimed person's name and suggests the plain slug.
    const form = await (await w.as(tony).get('/settings/profile')).text()
    expect(form).toContain('value="anthony.ettinger"')
    expect(form).toContain('value="Anthony Ettinger"')
    expect(form).not.toContain('Secretville')

    await w.as(tony).post('/settings/profile', { ...ANTHONY, published: '' })
    expect((await w.stranger().get('/profile/anthony.ettinger')).status).toBe(404)
    // The owner can look before turning it on.
    expect(await (await w.as(tony).get('/profile/anthony.ettinger')).text()).toContain('Only you can see this')

    const saved = await w.as(tony).post('/settings/profile', ANTHONY)
    expect(saved.status).toBe(200)
    const res = await w.stranger().get('/profile/anthony.ettinger')
    expect(res.status).toBe(200)
    const page = await res.text()
    for (const shown of ['Anthony Ettinger', 'Tony', 'Los Gatos, CA, USA', 'From Chicago', 'Builds things.', 'https://github.com/chovy', 'https://example.com/blog']) expect(page).toContain(shown)
    for (const secret of ['1975', 'Secretville', 'Motherly', 'Maidenname', 'The Ettinger Family', 'tony@example.com', tree.id]) expect(page).not.toContain(secret)
    expect(page).toContain('<meta name="robots" content="noindex">')
    // Case does not matter in the address.
    expect((await w.stranger().get('/profile/Anthony.Ettinger')).status).toBe(200)

    const card = await (await w.stranger().get('/profile/anthony.ettinger/card.vcf')).text()
    expect(card).toContain('FN:Anthony Ettinger')
    expect(card).toContain('ADR:;;;Los Gatos;CA;;USA')
    expect(card).not.toContain('BDAY')
    expect(mom.id).toBeTruthy()
  })

  test('an account claimed as a relative never gets the relative on its form', async () => {
    const w = world()
    const tony = w.user('tony@example.com', 'Anthony Ettinger')
    const tree = w.store.createTree(tony.id, 'The Ettinger Family')
    const aunt = w.store.addPerson(tree.id, { given: 'Joellen', surname: 'Arnold', nickname: 'Jo', living: '1' })
    w.store.db.query('INSERT INTO profiles (tree_id, person_id, user_id, created_at) VALUES (?,?,?,?)').run(tree.id, aunt.id, tony.id, Date.now())
    const form = await (await w.as(tony).get('/settings/profile')).text()
    expect(form).toContain('value="Anthony Ettinger"')
    expect(form).toContain('value="anthony.ettinger"')
    for (const wrong of ['Joellen', 'Arnold', 'value="Jo"']) expect(form).not.toContain(wrong)
  })

  test('addresses are unique: the second Anthony Ettinger is offered the town', async () => {
    const w = world()
    const a = w.user('a@example.com', 'Anthony Ettinger')
    const b = w.user('b@example.com', 'Anthony Ettinger')
    await w.as(a).post('/settings/profile', ANTHONY)
    expect(await (await w.as(b).get('/settings/profile')).text()).not.toContain('value="anthony.ettinger"')
    const clash = await w.as(b).post('/settings/profile', { ...ANTHONY, city: 'Sacramento' })
    expect(clash.status).toBe(400)
    expect(await clash.text()).toContain('anthony.ettinger.sacramento')
    expect((await w.as(b).post('/settings/profile', { ...ANTHONY, slug: 'anthony.ettinger.sacramento', city: 'Sacramento' })).status).toBe(200)
    expect((await w.stranger().get('/profile/anthony.ettinger.sacramento')).status).toBe(200)
  })

  test('find people: one search, facets with counts, free and signed out', async () => {
    const w = world()
    await w.as(w.user('a@example.com', 'A')).post('/settings/profile', ANTHONY)
    await w.as(w.user('k@example.com', 'K')).post('/settings/profile', { ...ANTHONY, slug: 'karen.ettinger', name: 'Karen Ettinger', nickname: '', city: 'Sacramento' })
    await w.as(w.user('z@example.com', 'Z')).post('/settings/profile', { ...ANTHONY, slug: 'zed.hidden', name: 'Zed Hidden', published: '' })
    const owner = w.user('o@example.com', 'Owner')
    const tree = w.store.createTree(owner.id, 'The Ettinger Family')
    await w.as(owner).post(`/t/${tree.id}/listing`, { listed: '1', listing: 'Ettingers of Chicago' })

    const all = await (await w.stranger().get('/people?q=ettinger')).text()
    expect(all).toContain('Anthony Ettinger')
    expect(all).toContain('Karen Ettinger')
    expect(all).toContain('The Ettinger Family')
    expect(all).not.toContain('Zed Hidden')
    expect(all).toContain('Narrow it down')
    expect(all).toMatch(/Los Gatos<\/span><span class="facet-count">1</)
    expect(all).toMatch(/Sacramento<\/span><span class="facet-count">1</)

    const city = await (await w.stranger().get('/people?q=ettinger&city=los%20gatos')).text()
    expect(city).toContain('Anthony Ettinger')
    expect(city).not.toContain('Karen Ettinger')
    expect(city).toContain('class="facet-item on"')

    const fams = await (await w.stranger().get('/people?kind=families')).text()
    expect(fams).toContain('The Ettinger Family')
    expect(fams).not.toContain('Karen Ettinger')
  })

  test('API: read and write your own, search everyone public', async () => {
    const w = world()
    const tony = w.user('tony@example.com', 'Tony Example')
    const api = w.bearer(tony)
    const before = (await (await api.get('/profile')).json()) as any
    expect(before.profile).toBeNull()
    expect(before.draft.slug).toBe('tony.example')
    const saved = (await (await api.post('/profile', { city: 'Los Gatos', published: true })).json()) as any
    expect(saved.profile.url).toBe(`${SITE}/profile/tony.example`)
    expect(saved.profile.published).toBe(true)
    const found = (await (await api.get('/people?city=los%20gatos')).json()) as any
    expect(found.hits.map((h: any) => h.name)).toEqual(['Tony Example'])
    expect((await api.post('/profile', { email: 'not an email' })).status).toBe(400)
  })
})
