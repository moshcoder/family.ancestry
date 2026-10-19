import { describe, expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { Network } from '../src/network.ts'
import { Local, businessKey } from '../src/local.ts'
import { createApp } from '../src/server.ts'

const SITE = 'http://family.test'
const CSRF = 'csrfcsrfcsrfcsrf1234'

function world() {
  const store = new Store(':memory:')
  const net = new Network(store)
  const local = new Local(store, net)
  const user = (email: string, name: string) => {
    const u = store.findOrCreateUser(email)
    store.setUserName(u.id, name)
    return store.user(u.id)!
  }
  return { store, net, local, user }
}

describe('local recommendations', () => {
  test('the same place, however it was typed', () => {
    expect(businessKey({ name: "Joe's", phone: '+1 (916) 555-0100' })).toBe(businessKey({ name: 'Joe Plumbing', phone: '916.555.0100' }))
    expect(businessKey({ name: 'A', website: 'https://www.joes.com/about' })).toBe('web:joes.com')
    expect(businessKey({ name: "Joe's Plumbing", town: 'Sacramento ' })).toBe('name:joe s plumbing|sacramento')
  })

  test('only people who know you see your recommendations; closer people count more', () => {
    const w = world()
    const me = w.user('me@x.com', 'Me')
    const mom = w.user('mom@x.com', 'Mom')
    const neighbor = w.user('ned@x.com', 'Ned')
    const pal = w.user('pal@x.com', 'Pal')
    const stranger = w.user('stranger@x.com', 'Stranger')
    for (const u of [mom, neighbor, pal]) w.net.connect(me.id, u.id)
    w.net.addContact(me.id, { name: 'Mom', circle: 'family' }, { linked_user_id: mom.id })
    w.net.addContact(me.id, { name: 'Ned', circle: 'neighbors' }, { linked_user_id: neighbor.id })
    w.net.addContact(me.id, { name: 'Pal', circle: 'friends' }, { linked_user_id: pal.id })

    w.local.recommend(pal.id, { name: 'Pal Pipes', category: 'plumber', phone: '555-0101' })
    w.local.recommend(pal.id, { name: 'Other Pipes', category: 'plumber', phone: '555-0102' })
    w.local.recommend(neighbor.id, { name: 'Other Pipes', category: 'Plumber', phone: '(555) 0102', note: 'Fixed our sump pump' })
    w.local.recommend(mom.id, { name: 'Dr. Lee', category: 'Dentist', town: 'Davis' })
    w.local.recommend(stranger.id, { name: 'Shady Pipes', category: 'Plumber', phone: '555-0666' })

    const plumbers = w.local.search(me.id, { category: 'plumber' })
    expect(plumbers.map((r) => [r.name, r.score])).toEqual([
      ['Other Pipes', 5], // a neighbor (3) and a friend (2)
      ['Pal Pipes', 2],
    ])
    expect(plumbers[0]!.by.map((b) => b.circle)).toEqual(['neighbors', 'friends'])
    expect(plumbers[0]!.by[0]!.note).toBe('Fixed our sump pump')
    expect(w.local.search(me.id, { q: 'davis' }).map((r) => r.name)).toEqual(['Dr. Lee'])
    // The stranger's pick never shows, and the stranger sees nobody's.
    expect(w.local.search(me.id, { q: 'shady' })).toEqual([])
    expect(w.local.search(stranger.id).map((r) => r.name)).toEqual(['Shady Pipes'])
    expect(w.local.categories(me.id)).toEqual([{ category: 'Plumber', n: 2 }, { category: 'Dentist', n: 1 }])

    // Recommending again updates instead of doubling; taking it back removes it.
    const again = w.local.recommend(pal.id, { name: 'Pal Pipes', category: 'Plumber', phone: '555 0101', note: 'still great' })
    expect(w.local.mine(pal.id)).toHaveLength(2)
    w.local.remove(pal.id, again.id)
    expect(w.local.search(me.id, { category: 'plumber' }).map((r) => r.name)).toEqual(['Other Pipes'])
  })

  test('tree-mates count, blocks do not', () => {
    const w = world()
    const me = w.user('me@x.com', 'Me')
    const cousin = w.user('cousin@x.com', 'Cousin')
    const tree = w.store.createTree(me.id, 'Fam')
    w.store.setMember(tree.id, cousin.id, 'viewer')
    w.local.recommend(cousin.id, { name: 'Bakery', category: 'Bakery' })
    expect(w.local.search(me.id)[0]).toMatchObject({ name: 'Bakery', score: 2 })
    w.net.block(me.id, cousin.id)
    expect(w.local.search(me.id)).toEqual([])
  })

  test('recommend one of your business contacts', () => {
    const w = world()
    const me = w.user('me@x.com', 'Me')
    const c = w.net.addContact(me.id, { name: 'Joe', company: "Joe's Plumbing", circle: 'business', phones: '555 0100', addresses: '12 Main St\nSacramento' })
    const r = w.local.recommendContact(me.id, c.id, { category: 'Plumber' })
    expect(r).toMatchObject({ name: "Joe's Plumbing", phone: '555 0100', town: 'Sacramento', contact_id: c.id })
  })

  test('pages: the Local page, neighbors in the network, and a crawlproof ad on every page', async () => {
    const store = new Store(':memory:')
    const auth = new Auth(store, async () => {}, SITE)
    const app = createApp({ store, auth, site: SITE })
    const me = store.findOrCreateUser('me@x.com') as User
    const cookie = `fa_session=${auth.createSession(me.id)}; fa_csrf=${CSRF}`
    const post = (path: string, fields: Record<string, string>) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) })
    const added = await post('/local', { name: 'Joe Plumbing', category: 'plumber', town: 'Sacramento', note: 'Came on a Sunday' })
    expect(added.headers.get('location')).toContain('Recommended%20Joe%20Plumbing')
    const res = await app.request(`${SITE}/local`, { headers: { cookie } })
    const page = await res.text()
    expect(page).toContain('Joe Plumbing')
    expect(page).toContain('Came on a Sunday')
    expect(page).toContain('crawlproof.com/api/ads/frame?slot=')
    expect(res.headers.get('content-security-policy')).toContain('frame-src https://crawlproof.com')
    const net = await (await app.request(`${SITE}/network?circle=neighbors`, { headers: { cookie } })).text()
    expect(net).toContain('Neighbors')
    // Local and Network carry their in-content unit, so no top unit is added there.
    expect(page).not.toContain('data-cp-ad')
    expect(net).not.toContain('data-cp-ad')
    expect(await (await app.request(`${SITE}/`)).text()).toContain('class="top-ad"')
    const api = await app.request(`${SITE}/api/v1/local?q=sacramento`, { headers: { cookie } })
    expect((await api.json()).results[0].name).toBe('Joe Plumbing')
  })
})
