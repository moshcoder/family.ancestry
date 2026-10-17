import { describe, expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { Network } from '../src/network.ts'
import { createApp } from '../src/server.ts'
import { exportGedcom, importGedcom, parseLines } from '../src/gedcom.ts'
import { businessFields, formatBusiness, formatPerson } from '../src/cli.ts'
import { createMcpServer } from '../src/mcp.ts'
import { SAMPLE_GED } from './fixtures.ts'

const SITE = 'http://family.test'
const CSRF = 'csrfcsrfcsrfcsrf1234'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

/** The Ettingers, with a plumbing company three of them ran. */
function family() {
  const store = new Store(':memory:')
  const owner = store.findOrCreateUser('owner@example.com')
  const tree = store.createTree(owner.id, 'Ettingers')
  const add = (given: string, extra: Record<string, unknown> = {}) => store.addPerson(tree.id, { given, surname: 'Ettinger', ...extra })
  const grandpa = add('Karl', { sex: 'M', birth_date: '1899', death_date: '1971' })
  const dad = add('Robert', { sex: 'M', birth_date: '1930', death_date: '2010' })
  const me = add('Anthony', { sex: 'M', birth_date: '1975', living: 1 })
  const f1 = store.createFamily(tree.id, grandpa.id, null)
  store.addChild(tree.id, f1.id, dad.id)
  const f2 = store.createFamily(tree.id, dad.id, null)
  store.addChild(tree.id, f2.id, me.id)
  const biz = store.addBusiness(tree.id, { name: 'Ettinger Plumbing', category: 'Plumbing', founded: '1952', closed: '1990', place: 'Sacramento, California', website: 'ettingerplumbing.com', notes: 'Three trucks @ the peak.\nEveryone worked summers.' })
  store.addBusinessRole(tree.id, biz.id, grandpa.id, { role: 'founder', start_date: '1952', end_date: '1971' })
  store.addBusinessRole(tree.id, biz.id, dad.id, { role: 'owner', title: 'Master plumber', start_date: '1971', end_date: '1990' })
  store.addBusinessRole(tree.id, biz.id, me.id, { role: 'employee', start_date: '1989', end_date: '1990', note: 'weekends' })
  return { store, owner, tree, grandpa, dad, me, biz }
}

describe('businesses in the store', () => {
  test('a business is its own entry, with people in roles, both ways', () => {
    const { store, tree, grandpa, dad, me, biz } = family()
    expect(biz.website).toBe('https://ettingerplumbing.com')
    expect(store.businessPeople(tree.id, biz.id).map((r) => [r.person.given, r.role])).toEqual([['Karl', 'founder'], ['Robert', 'owner'], ['Anthony', 'employee']])
    expect(store.businessesOf(tree.id, dad.id).map((r) => [r.business.name, r.title])).toEqual([['Ettinger Plumbing', 'Master plumber']])
    expect(store.businessesOf(tree.id, me.id)[0]!.note).toBe('weekends')
    expect(store.stats(tree.id)).toMatchObject({ people: 3, businesses: 1 })
    // One person can hold two roles in the same business.
    store.addBusinessRole(tree.id, biz.id, grandpa.id, { role: 'investor' })
    expect(store.businessesOf(tree.id, grandpa.id).map((r) => r.role)).toEqual(['founder', 'investor'])
  })

  test('kept out of the bloodline: pedigree, descendants, relationships, the people list', () => {
    const { store, tree, grandpa, me, biz } = family()
    expect([...store.pedigree(tree.id, me.id, 4).values()].map((p) => p.given)).toEqual(['Anthony', 'Robert', 'Karl'])
    const names: string[] = []
    const walk = (d: any) => (names.push(d.person.given), d.unions.forEach((u: any) => u.children.forEach(walk)))
    walk(store.descendants(tree.id, grandpa.id, 5))
    expect(names).toEqual(['Karl', 'Robert', 'Anthony'])
    expect(store.people(tree.id).map((p) => p.given)).not.toContain('Ettinger Plumbing')
    expect(store.search(tree.id, 'plumbing')).toEqual([])
    expect(store.relationship(tree.id, me.id, biz.id)).toBeNull()
  })

  test('search finds a business by name, trade, town, year and the people in it', () => {
    const { store, tree } = family()
    for (const q of ['ettinger plumbing', 'plumbing sacramento', '1952', 'robert', 'anthony ettinger']) expect(store.searchBusinesses(tree.id, q).map((b) => b.name)).toEqual(['Ettinger Plumbing'])
    expect(store.searchBusinesses(tree.id, 'bakery')).toEqual([])
  })

  test('pets do not run businesses; bad roles are refused; deleting either side is clean', () => {
    const { store, tree, dad, biz } = family()
    const pet = store.addPet(tree.id, { given: 'Rex', species: 'Dog' }, [dad.id])
    expect(() => store.addBusinessRole(tree.id, biz.id, pet.id, { role: 'owner' })).toThrow('pets do not run businesses')
    expect(() => store.addBusinessRole(tree.id, biz.id, dad.id, { role: 'emperor' })).toThrow('role must be one of')
    expect(() => store.addBusiness(tree.id, { name: '  ' })).toThrow('give the business a name')
    // A role label works as well as its key.
    expect(store.addBusinessRole(tree.id, biz.id, dad.id, { role: 'Investor' }).role).toBe('investor')
    store.deletePerson(tree.id, dad.id)
    expect(store.businessPeople(tree.id, biz.id).map((r) => r.person.given)).toEqual(['Karl', 'Anthony'])
    store.deleteBusiness(tree.id, biz.id)
    expect(store.businesses(tree.id)).toEqual([])
    expect(store.people(tree.id).filter((p) => p.kind === 'person').map((p) => p.given)).toEqual(['Anthony', 'Karl'])
  })

  test('another tree cannot reach a business by id', () => {
    const { store, biz, dad } = family()
    const other = store.createTree(store.findOrCreateUser('x@example.com').id, 'Other')
    expect(store.business(other.id, biz.id)).toBeNull()
    expect(() => store.addBusinessRole(other.id, biz.id, dad.id, { role: 'owner' })).toThrow('no such business')
  })
})

describe('businesses in GEDCOM', () => {
  test('exported as a custom _BUS record plus a marked OCCU, and back without loss or doubling', () => {
    const { store, tree, owner } = family()
    const ged = exportGedcom(store, tree.id)
    expect(ged).toContain('0 @B1@ _BUS')
    expect(ged).toContain('1 NAME Ettinger Plumbing')
    expect(ged).toContain('1 OCCU Master plumber, Ettinger Plumbing')
    expect(ged).toContain('2 DATE FROM 1971 TO 1990')
    expect(ged).toContain('2 _BUS @B1@')
    // Every line is still well-formed GEDCOM, and records stay in order.
    for (const line of ged.trim().split('\r\n')) expect(line).toMatch(/^\d+ (@[^@]+@ )?[A-Z_][A-Z0-9_]*( .*)?$/)
    expect(ged.trim().endsWith('0 TRLR')).toBe(true)

    const copy = store.createTree(owner.id, 'Ettingers')
    const r = importGedcom(store, copy.id, ged)
    expect(r.businesses).toBe(1)
    expect(r.warnings).toEqual([])
    const [b] = store.businesses(copy.id)
    expect(b).toMatchObject({ name: 'Ettinger Plumbing', category: 'Plumbing', founded: '1952', closed: '1990', place: 'Sacramento, California', website: 'https://ettingerplumbing.com', notes: 'Three trucks @ the peak.\nEveryone worked summers.' })
    expect(store.businessPeople(copy.id, b!.id).map((x) => [x.person.given, x.role, x.title, x.start_date, x.end_date, x.note])).toEqual([
      ['Karl', 'founder', null, '1952', '1971', null],
      ['Robert', 'owner', 'Master plumber', '1971', '1990', null],
      ['Anthony', 'employee', null, '1989', '1990', 'weekends'],
    ])
    // The OCCU lines that carried the roles did not turn into Occupation events.
    expect(store.allEvents(copy.id)).toEqual([])
    // And a second trip changes nothing but the date in the header.
    const strip = (g: string) => g.replace(/^1 DATE .*$/m, '').replace(/^1 FILE .*$/m, '')
    expect(strip(exportGedcom(store, copy.id))).toBe(strip(ged))
  })

  test('privacy keeps the business and drops what a living person did', () => {
    const { store, tree } = family()
    const ged = exportGedcom(store, tree.id, { privacy: true })
    expect(ged).toContain('1 NAME Ettinger Plumbing')
    expect(ged).toContain('1 OCCU Founder, Ettinger Plumbing')
    expect(ged).not.toContain('weekends')
    const bus = parseLines(ged).find((r) => r.tag === '_BUS')!
    expect(bus.children.filter((c) => c.tag === '_ROLE')).toHaveLength(2)
  })

  test('a file from another program still imports, and an ordinary OCCU stays an event', () => {
    const store = new Store(':memory:')
    const tree = store.createTree(store.findOrCreateUser('o@example.com').id, 'T')
    const r = importGedcom(store, tree.id, SAMPLE_GED)
    expect(r.businesses).toBeUndefined()
    expect(store.allEvents(tree.id).map((e) => e.type)).toContain('Occupation')
  })

  test('a _BUS role pointing at nobody is a warning, not a failure', () => {
    const store = new Store(':memory:')
    const tree = store.createTree(store.findOrCreateUser('o@example.com').id, 'T')
    const r = importGedcom(store, tree.id, '0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n0 @B1@ _BUS\n1 NAME Shop\n1 _ROLE @I9@\n2 TYPE owner\n1 _ROLE @I1@\n2 TYPE wizard\n0 TRLR\n')
    expect(r.warnings).toEqual(['business @B1@ lists unknown person @I9@'])
    const [b] = store.businesses(tree.id)
    expect(store.businessPeople(tree.id, b!.id).map((x) => x.role)).toEqual(['other'])
  })
})

function app() {
  const f = family()
  const auth = new Auth(f.store, async () => {}, SITE)
  const net = new Network(f.store)
  const server = createApp({ store: f.store, auth, site: SITE, net })
  const as = (user: User) => {
    const cookie = `fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`
    const bearer = auth.createToken(user.id, 'test')
    return {
      get: (path: string) => server.request(`${SITE}${path}`, { headers: { cookie } }),
      post: (path: string, fields: Record<string, string> = {}) => server.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
      upload: (path: string, form: FormData) => (form.set('_csrf', CSRF), server.request(`${SITE}${path}`, { method: 'POST', headers: { cookie }, body: form })),
      api: (path: string, method = 'GET', body?: unknown) => server.request(`${SITE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    }
  }
  return { ...f, net, as }
}

describe('businesses on the web and the API', () => {
  test('the person page lists their businesses; the business page lists its people; free without the Family plan', async () => {
    const { tree, dad, biz, owner, as, store } = app()
    expect(store.tree(tree.id)!.plan_paid_at).toBeNull()
    const me = as(owner)
    const person = await (await me.get(`/t/${tree.id}/p/${dad.id}`)).text()
    expect(person).toContain('<h2>Businesses</h2>')
    expect(person).toContain(`href="/t/${tree.id}/b/${biz.id}"`)
    expect(person).toContain('Master plumber')
    const page = await me.get(`/t/${tree.id}/b/${biz.id}`)
    expect(page.status).toBe(200)
    const body = await page.text()
    for (const s of ['Ettinger Plumbing', 'Founder', 'Karl Ettinger', 'Robert Ettinger', 'ettingerplumbing.com', 'Sacramento, California', 'Everyone worked summers']) expect(body).toContain(s)
    // The bloodline pages do not mention it.
    expect(await (await me.get(`/t/${tree.id}/pedigree/${dad.id}`)).text()).not.toContain('Ettinger Plumbing')
    expect(await (await me.get(`/t/${tree.id}/descendants/${dad.id}`)).text()).not.toContain('Ettinger Plumbing')
    // Tree search finds it; the businesses page lists it.
    expect(await (await me.get(`/t/${tree.id}?q=plumbing`)).text()).toContain(`/t/${tree.id}/b/${biz.id}`)
    expect(await (await me.get(`/t/${tree.id}/businesses`)).text()).toContain('Ettinger Plumbing')
  })

  test('add a business from a person page, add people to it, upload its photo, remove a role', async () => {
    const { tree, me: anthony, owner, as, store } = app()
    const me = as(owner)
    const added = await me.post(`/t/${tree.id}/businesses`, { person_id: anthony.id, name: 'Profullstack', category: 'Software', founded: '2016', role: 'founder', start_date: '2016' })
    expect(added.headers.get('location')).toContain('Added%20Profullstack')
    const [b] = store.searchBusinesses(tree.id, 'profullstack')
    expect(store.businessPeople(tree.id, b!.id).map((r) => [r.person.given, r.role])).toEqual([['Anthony', 'founder']])
    // A new person can be added straight into a business.
    await me.post(`/t/${tree.id}/b/${b!.id}/people`, { given: 'Pat', surname: 'Doe', role: 'investor' })
    expect(store.businessPeople(tree.id, b!.id).map((r) => r.role)).toEqual(['founder', 'investor'])
    const form = new FormData()
    form.set('file', new File([PNG], 'shop.png', { type: 'image/png' }))
    expect((await me.upload(`/t/${tree.id}/b/${b!.id}/media`, form)).status).toBe(302)
    const photo = store.business(tree.id, b!.id)!.photo_id
    expect(photo).toBeTruthy()
    expect((await me.get(`/t/${tree.id}/media/${photo}`)).headers.get('content-type')).toBe('image/png')
    // Text files are not photos.
    const txt = new FormData()
    txt.set('file', new File(['hi'], 'x.txt', { type: 'text/plain' }))
    expect((await me.upload(`/t/${tree.id}/b/${b!.id}/media`, txt)).headers.get('location')).toContain('Photos%20must%20be')
    const role = store.businessPeople(tree.id, b!.id)[1]!
    const removed = await me.post(`/t/${tree.id}/business-roles/${role.id}/delete`, { back: 'https://evil.example/' })
    expect(removed.headers.get('location')).toBe(`/t/${tree.id}/b/${b!.id}`)
    expect(store.businessPeople(tree.id, b!.id)).toHaveLength(1)
    // Deleting the photo clears the main photo.
    await me.post(`/t/${tree.id}/media/${photo}/delete`)
    expect(store.business(tree.id, b!.id)!.photo_id).toBeNull()
  })

  test('viewers look but cannot change; strangers get 404', async () => {
    const { tree, biz, as, store } = app()
    const viewer = store.findOrCreateUser('viewer@example.com')
    store.setMember(tree.id, viewer.id, 'viewer')
    const v = as(viewer)
    expect((await v.get(`/t/${tree.id}/b/${biz.id}`)).status).toBe(200)
    expect((await v.post(`/t/${tree.id}/b/${biz.id}`, { name: 'Hacked' })).status).toBe(403)
    expect((await v.api(`/trees/${tree.id}/businesses`, 'POST', { name: 'Nope' })).status).toBe(403)
    const stranger = as(store.findOrCreateUser('stranger@example.com'))
    expect((await stranger.get(`/t/${tree.id}/b/${biz.id}`)).status).toBe(404)
    expect((await stranger.api(`/trees/${tree.id}/businesses/${biz.id}`)).status).toBe(404)
    expect(store.business(tree.id, biz.id)!.name).toBe('Ettinger Plumbing')
  })

  test('API: create with people, read, search, patch, roles, delete; persons carry their businesses', async () => {
    const { tree, dad, me: anthony, owner, as } = app()
    const me = as(owner)
    const created = await me.api(`/trees/${tree.id}/businesses`, 'POST', { name: 'Ettinger Farms', category: 'Farm', founded: '1920', people: [{ person_id: dad.id, role: 'partner', start_date: '1950' }] })
    expect(created.status).toBe(201)
    const { business } = await created.json()
    expect(business.people.map((p: any) => [p.name, p.role, p.label])).toEqual([['Robert Ettinger', 'partner', 'Partner']])
    expect(business.url).toBe(`${SITE}/t/${tree.id}/b/${business.id}`)
    const list = await (await me.api(`/trees/${tree.id}/businesses?q=farm`)).json()
    expect(list.businesses.map((b: any) => b.name)).toEqual(['Ettinger Farms'])
    const both = await (await me.api(`/trees/${tree.id}/search?q=ettinger`)).json()
    expect(both.people.length).toBe(3)
    expect(both.businesses.map((b: any) => b.name).sort()).toEqual(['Ettinger Farms', 'Ettinger Plumbing'])
    const patched = await (await me.api(`/trees/${tree.id}/businesses/${business.id}`, 'PATCH', { closed: '1999', website: 'not a url' })).json()
    expect(patched.business).toMatchObject({ name: 'Ettinger Farms', closed: '1999', website: null })
    const withRole = await (await me.api(`/trees/${tree.id}/businesses/${business.id}/people`, 'POST', { person_id: anthony.id, role: 'employee', title: 'Farmhand' })).json()
    expect(withRole.business.people.map((p: any) => p.label)).toEqual(['Partner', 'Farmhand'])
    expect((await me.api(`/trees/${tree.id}/businesses/${business.id}/people`, 'POST', { person_id: anthony.id, role: 'king' })).status).toBe(400)
    const person = await (await me.api(`/trees/${tree.id}/people/${dad.id}`)).json()
    expect(person.person.businesses.map((b: any) => [b.business.name, b.role])).toEqual([['Ettinger Farms', 'partner'], ['Ettinger Plumbing', 'owner']])
    const roleId = withRole.business.people[1].role_id
    expect((await me.api(`/trees/${tree.id}/business-roles/${roleId}`, 'DELETE')).status).toBe(200)
    expect((await me.api(`/trees/${tree.id}/businesses/${business.id}`, 'DELETE')).status).toBe(200)
    expect((await me.api(`/trees/${tree.id}/businesses/${business.id}`)).status).toBe(404)
    // The people stay.
    expect((await me.api(`/trees/${tree.id}/people/${anthony.id}`)).status).toBe(200)
  })

  test('a Network contact link is private to the member who made it', async () => {
    const { tree, biz, owner, as, store, net } = app()
    const editor = store.findOrCreateUser('editor@example.com')
    store.setMember(tree.id, editor.id, 'editor')
    const mine = net.addContact(owner.id, { circle: 'business', name: 'Ettinger Plumbing office', company: 'Ettinger Plumbing' })
    const me = as(owner)
    await me.post(`/t/${tree.id}/b/${biz.id}/contact`, { contact_id: mine.id })
    expect(await (await me.get(`/t/${tree.id}/b/${biz.id}`)).text()).toContain(`href="/network/c/${mine.id}"`)
    const theirs = as(editor)
    const page = await (await theirs.get(`/t/${tree.id}/b/${biz.id}`)).text()
    expect(page).not.toContain(mine.id)
    // Someone else's contact id cannot be linked.
    const bad = await theirs.api(`/trees/${tree.id}/businesses/${biz.id}/contact`, 'POST', { contact_id: mine.id })
    expect(bad.status).toBe(400)
    // "Add it to my network" makes a business contact from the entry.
    const made = await (await theirs.api(`/trees/${tree.id}/businesses/${biz.id}/contact`, 'POST', { create: true })).json()
    expect(made.business.contact.name).toBe('Ettinger Plumbing')
    const contact = net.contact(editor.id, made.business.contact.id)!
    expect(contact).toMatchObject({ circle: 'business', company: 'Ettinger Plumbing' })
    expect(contact.links.map((l) => l.value)).toEqual(['https://ettingerplumbing.com'])
    expect(store.businessContact(biz.id, owner.id)).toBe(mine.id)
  })
})

describe('businesses in the CLI and MCP', () => {
  test('flags, and the text the CLI, TUI and MCP print', () => {
    expect(businessFields({ name: 'X', category: 'Farm', town: 'Davis', note: 'n', founded: '1920' })).toEqual({ name: 'X', category: 'Farm', place: 'Davis', notes: 'n', founded: '1920' })
    const text = formatBusiness({ id: 'b1', name: 'Ettinger Plumbing', category: 'Plumbing', founded: '1952', closed: '1990', place: 'Sacramento', website: null, notes: null, url: 'u', people: [{ role_id: 'r1', id: 'p1', name: 'Karl Ettinger', role: 'founder', label: 'Founder', title: null, start_date: '1952', end_date: null }] })
    expect(text).toContain('Ettinger Plumbing (1952–1990)')
    expect(text).toContain('founder Karl Ettinger [p1] 1952–')
    const person = formatPerson({ id: 'p1', name: 'Karl Ettinger', given: 'Karl', surname: 'Ettinger', sex: 'M', birth_date: null, birth_place: null, death_date: null, death_place: null, living: 0, notes: null, url: 'u', parents: [], unions: [], events: [], sources: [], photos: [], businesses: [{ role_id: 'r1', business: { id: 'b1', name: 'Ettinger Plumbing', category: null }, role: 'founder', label: 'Founder', title: null, start_date: '1952', end_date: '1971' }] })
    expect(person).toContain('founder Ettinger Plumbing [b1] 1952–1971')
  })

  test('MCP registers the business tools', () => {
    const tools = Object.keys((createMcpServer() as any)._registeredTools ?? {})
    for (const name of ['search_businesses', 'get_business', 'add_business', 'update_business', 'add_business_role', 'remove_business_role', 'link_business_contact']) expect(tools).toContain(name)
  })
})
