import { expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'
import { exportGedcom, importGedcom } from '../src/gedcom.ts'
import { parseSocials, readContact, socialUrl } from '../src/contact.ts'
import { Network } from '../src/network.ts'

const SITE = 'https://family.test'

const setup = () => {
  const store = new Store(':memory:')
  const auth = new Auth(store, async () => {}, SITE)
  const app = createApp({ store, auth, site: SITE })
  const me = store.findOrCreateUser('a@example.com')
  const tree = store.createTree(me.id, 'Fam')
  /** A signed-in browser: GET once for the CSRF cookie, then post forms. */
  const browser = async (userId: string) => {
    const session = auth.createSession(userId)
    const first = await app.request(`${SITE}/trees`, { headers: { cookie: `fa_session=${session}` } })
    const csrf = first.headers.getSetCookie().find((x) => x.startsWith('fa_csrf='))!.split(';')[0]!.split('=')[1]!
    const cookie = `fa_session=${session}; fa_csrf=${csrf}`
    return {
      get: async (path: string) => (await app.request(`${SITE}${path}`, { headers: { cookie } })).text(),
      post: (path: string, fields: Record<string, string>) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...fields }) }),
    }
  }
  return { store, auth, app, me, tree, browser }
}

test('a person keeps emails, phones, addresses, links and socials; an edit changes only the lists it names', () => {
  const { store, tree } = setup()
  const tony = store.addPerson(tree.id, {
    given: 'Anthony',
    surname: 'Ettinger',
    emails: 'home: Tony@Example.com',
    phones: 'cell: 408 555 0100\nwork: 408 555 0199',
    addresses: 'home: 1 Main St\nLos Gatos CA 95030\n\ncabin: 9 Lake Rd',
    links: 'blog: https://dev.example.com\nnot a link',
    socials: 'instagram: @tony\nhttps://bsky.app/profile/tony.bsky.social',
  })
  const c = readContact(tony.contact)
  expect(c.emails).toEqual([{ label: 'home', value: 'tony@example.com' }])
  expect(c.phones.map((p) => p.label)).toEqual(['cell', 'work'])
  expect(c.addresses).toEqual([{ label: 'home', lines: '1 Main St\nLos Gatos CA 95030' }, { label: 'cabin', lines: '9 Lake Rd' }])
  expect(c.links).toEqual([{ label: 'blog', value: 'https://dev.example.com' }])
  expect(c.socials).toEqual([{ label: 'instagram', value: '@tony' }, { label: 'bluesky', value: 'https://bsky.app/profile/tony.bsky.social' }])

  // Only phones named: the rest of the card stays.
  const after = readContact(store.updatePerson(tree.id, tony.id, { phones: ['555 0000'] })!.contact)
  expect(after.phones).toEqual([{ label: null, value: '555 0000' }])
  expect(after.emails).toEqual(c.emails)
  // An edit that never mentions contact details leaves them alone.
  expect(readContact(store.updatePerson(tree.id, tony.id, { notes: 'x' })!.contact).emails).toEqual(c.emails)
  // Emptying every list clears the card.
  expect(store.updatePerson(tree.id, tony.id, { emails: '', phones: '', addresses: '', links: '', socials: '' })!.contact).toBeNull()
})

test('socials: handles become profile URLs; other schemes and unlabeled handles are dropped', () => {
  const s = parseSocials('ig: @tony\nmastodon: tony@mastodon.social\nfacebook: tony.ettinger\njavascript:alert(1)\n@nobody\nhttps://www.instagram.com/tony')
  expect(s.map((x) => x.label)).toEqual(['instagram', 'mastodon', 'facebook', 'instagram'])
  expect(s.map(socialUrl)).toEqual(['https://instagram.com/tony', 'https://mastodon.social/@tony', 'https://facebook.com/tony.ettinger', 'https://www.instagram.com/tony'])
  expect(socialUrl({ label: 'myspace', value: 'tom' })).toBeNull()
  expect(socialUrl({ label: 'instagram', value: '"><script>' })).toBeNull()
})

test('GEDCOM: contact details round-trip, a dated residence stays an event, privacy drops the living', () => {
  const { store, me, tree } = setup()
  const tony = store.addPerson(tree.id, { given: 'Tony', surname: 'E', living: 1, emails: 'home: t@example.com', phones: 'cell: 408 555 0100', addresses: 'home: 1 Main St\nLos Gatos CA', links: 'https://t.example', socials: 'instagram: @tony' })
  store.addEvent(tree.id, tony.id, { type: 'Residence', date: '1990', place: 'San Jose' })
  const ged = exportGedcom(store, tree.id).replace(/\r\n/g, '\n')
  expect(ged).toContain('1 EMAIL t@@example.com\n2 TYPE home')
  expect(ged).toContain('1 PHON 408 555 0100\n2 TYPE cell')
  expect(ged).toContain('1 RESI\n2 TYPE home\n2 ADDR 1 Main St\n3 CONT Los Gatos CA')
  expect(ged).toContain('1 _SOCIAL @@tony\n2 TYPE instagram')
  const copy = store.createTree(me.id, 'Copy')
  importGedcom(store, copy.id, ged)
  const back = store.people(copy.id)[0]!
  expect(readContact(back.contact)).toEqual(readContact(tony.contact))
  expect(store.events(copy.id, back.id).map((e) => e.type)).toEqual(['Residence'])
  expect(exportGedcom(store, copy.id).replace(/\r\n/g, '\n')).toBe(ged.replace(/1 FILE .*\n/, '1 FILE Copy.ged\n').replace(/1 NAME Fam\n/, '1 NAME Copy\n'))
  const priv = exportGedcom(store, tree.id, { privacy: true })
  expect(priv).not.toContain('EMAIL')
  expect(priv).not.toContain('408 555')
})

test('web: you fill in your own contact info; another viewer cannot; the page links tel/mailto/socials', async () => {
  const { store, me, tree, browser } = setup()
  const kurt = store.findOrCreateUser('kurt@example.com')
  const liz = store.findOrCreateUser('liz@example.com')
  store.setMember(tree.id, kurt.id, 'viewer')
  store.setMember(tree.id, liz.id, 'viewer')
  const kp = store.addPerson(tree.id, { given: 'Kurt', surname: 'R', living: 1 })
  store.claimProfile(tree.id, kp.id, kurt.id)

  const k = await browser(kurt.id)
  const empty = await k.get(`/t/${tree.id}/p/${kp.id}`)
  expect(empty).toContain('Add how the family can reach you')
  expect(empty).toContain(`action="/t/${tree.id}/p/${kp.id}/contact"`)
  const saved = await k.post(`/t/${tree.id}/p/${kp.id}/contact`, { phones: 'cell: (408) 555-0100', emails: 'kurt@example.com', addresses: '', links: '', socials: 'instagram: @kurt' })
  expect(saved.status).toBe(302)
  expect(decodeURIComponent(saved.headers.get('location')!)).toContain('Contact info saved')
  const page = await k.get(`/t/${tree.id}/p/${kp.id}`)
  expect(page).toContain('href="tel:4085550100"')
  expect(page).toContain('href="mailto:kurt@example.com"')
  expect(page).toContain('href="https://instagram.com/kurt"')
  expect(page).toContain('Edit contact info')

  const l = await browser(liz.id)
  expect((await l.post(`/t/${tree.id}/p/${kp.id}/contact`, { phones: '0' })).status).toBe(403)
  // Liz still sees it: she is in the family. No form for her.
  const seen = await l.get(`/t/${tree.id}/p/${kp.id}`)
  expect(seen).toContain('tel:4085550100')
  expect(seen).not.toContain(`/p/${kp.id}/contact"`)

  // Adding a person takes contact info too.
  const owner = await browser(me.id)
  expect(await owner.get(`/t/${tree.id}`)).toContain('name="socials"')
  await owner.post(`/t/${tree.id}/people`, { given: 'Nan', surname: 'E', emails: 'nan@example.com' })
  expect(readContact(store.people(tree.id).find((p) => p.given === 'Nan')!.contact).emails[0]!.value).toBe('nan@example.com')
})

test('the same person in two trees: contact edits carry to the copy', () => {
  const { store, me, tree } = setup()
  const tony = store.addPerson(tree.id, { given: 'Tony', surname: 'E', phones: '1' })
  const other = store.createTree(me.id, 'Other')
  const [copy] = store.copyPeople(other.id, me.id, [{ tree: tree.id, person: tony.id }]).added
  expect(readContact(copy!.contact).phones[0]!.value).toBe('1')
  const { synced } = store.updatePersonEverywhere(tree.id, tony.id, { phones: '2', emails: 't@example.com' }, me.id)
  expect(synced).toBe(1)
  const c = readContact(store.person(other.id, copy!.id)!.contact)
  expect(c.phones[0]!.value).toBe('2')
  expect(c.emails[0]!.value).toBe('t@example.com')
})

test('add to my network: the person card comes along; API returns the card parsed', async () => {
  const { store, auth, app, me, tree, browser } = setup()
  const tony = store.addPerson(tree.id, { given: 'Tony', surname: 'E', living: 1, emails: 't@example.com', phones: 'cell: 555', socials: 'instagram: @tony' })
  const b = await browser(me.id)
  expect(await b.get(`/t/${tree.id}/p/${tony.id}`)).toContain('value="t@example.com"')
  await b.post(`/t/${tree.id}/p/${tony.id}/network`, { circle: 'family' })
  const contact = new Network(store).contactForPerson(me.id, tree.id, tony.id)!
  expect(contact.emails.map((e) => e.value)).toEqual(['t@example.com'])
  expect(contact.phones).toEqual([{ label: 'cell', value: '555' }])
  expect(contact.links).toEqual([{ label: 'instagram', value: 'https://instagram.com/tony' }])

  const token = auth.createToken(me.id, 'test')
  const res = await app.request(`${SITE}/api/v1/trees/${tree.id}/people/${tony.id}`, { headers: { authorization: `Bearer ${token}` } })
  const body = (await res.json()) as any
  expect(body.person.contact.phones).toEqual([{ label: 'cell', value: '555' }])
})
