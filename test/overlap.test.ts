import { expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { Network } from '../src/network.ts'
import { createApp } from '../src/server.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

function world() {
  const store = new Store(':memory:')
  const sent: { to: string; subject: string; text: string }[] = []
  const auth = new Auth(store, async (m) => void sent.push(m), SITE)
  const net = new Network(store)
  const app = createApp({ store, auth, site: SITE, net })
  const as = (user: User) => {
    const cookie = `fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`
    const get = (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } })
    const post = (path: string, fields: [string, string][]) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['_csrf', CSRF], ...fields]) })
    return { get, post }
  }
  return { store, net, as, sent }
}

test('a new tree starts from people already in another tree: links, events and accounts come along', async () => {
  const { store, as, sent } = world()
  const me = store.findOrCreateUser('me@example.com')
  const liz = store.findOrCreateUser('liz@example.com')
  const ettinger = store.createTree(me.id, 'The Ettinger Family')
  const anthony = store.addPerson(ettinger.id, { given: 'Anthony', surname: 'Ettinger', sex: 'M', living: 1 })
  const mom = store.addPerson(ettinger.id, { given: 'Liz', surname: 'Toshikian', sex: 'F', living: 1 })
  const kid = store.addPerson(ettinger.id, { given: 'Kathleen', surname: 'Ettinger', sex: 'F', birth_date: '2008', living: 1 })
  const other = store.addPerson(ettinger.id, { given: 'Joe', surname: 'Ettinger', sex: 'M' })
  const fam = store.createFamily(ettinger.id, anthony.id, mom.id, { kind: 'married' })
  store.addChild(ettinger.id, fam.id, kid.id)
  store.addEvent(ettinger.id, kid.id, { type: 'Graduation', date: '2026', place: 'Los Gatos' })
  store.claimProfile(ettinger.id, anthony.id, me.id)
  store.setMember(ettinger.id, liz.id, 'viewer')
  store.claimProfile(ettinger.id, mom.id, liz.id)

  const page = await (await as(me).get('/trees')).text()
  expect(page).toContain('Add people you already have')
  expect(page).toContain(`value="p:${ettinger.id}:${kid.id}"`)

  const res = await as(me).post('/trees', [['name', 'The Toshikian Family'], ['pick', `p:${ettinger.id}:${mom.id}`], ['pick', `p:${ettinger.id}:${kid.id}`], ['share', '1']])
  expect(res.status).toBe(302)
  const treeId = res.headers.get('location')!.match(/\/t\/([^?]+)/)![1]!
  expect(decodeURIComponent(res.headers.get('location')!)).toContain('Added 2 people; 1 of them can now see this tree (emailed liz@example.com)')
  // Liz is told, or being added is invisible to her.
  expect(sent.map((m) => m.to)).toEqual(['liz@example.com'])
  expect(sent[0]!.subject).toContain('added you to the The Toshikian Family family tree')
  expect(sent[0]!.text).toContain(`${SITE}/t/`)
  const people = store.people(treeId)
  expect(people.map((p) => p.given).sort()).toEqual(['Kathleen', 'Liz'])
  const newMom = people.find((p) => p.given === 'Liz')!
  const newKid = people.find((p) => p.given === 'Kathleen')!
  // Mother and daughter stay linked; Anthony was not picked, so the family has one known parent.
  expect(store.parents(treeId, newKid.id).map((p) => p.id)).toEqual([newMom.id])
  expect(store.events(treeId, newKid.id)[0]).toMatchObject({ type: 'Graduation', place: 'Los Gatos' })
  // Liz has an account: she sees the new tree and is still herself in it.
  expect(store.role(treeId, liz.id)).toBe('viewer')
  expect(store.profilePerson(treeId, liz.id)).toBe(newMom.id)
  // The original tree is untouched.
  expect(store.people(ettinger.id)).toHaveLength(4)
  expect(store.person(ettinger.id, other.id)).not.toBeNull()
})

test('without share, accounts are not given access; someone else\'s tree cannot be copied from', async () => {
  const { store } = world()
  const me = store.findOrCreateUser('me@example.com')
  const liz = store.findOrCreateUser('liz@example.com')
  const stranger = store.findOrCreateUser('x@example.com')
  const mine = store.createTree(me.id, 'Mine')
  const mom = store.addPerson(mine.id, { given: 'Liz', surname: 'T' })
  store.setMember(mine.id, liz.id, 'viewer')
  store.claimProfile(mine.id, mom.id, liz.id)
  const theirs = store.createTree(stranger.id, 'Theirs')
  const secret = store.addPerson(theirs.id, { given: 'Secret', surname: 'Person' })

  const target = store.createTree(me.id, 'New')
  const r = store.copyPeople(target.id, me.id, [{ tree: mine.id, person: mom.id }, { tree: theirs.id, person: secret.id }])
  expect(r.added.map((p) => p.given)).toEqual(['Liz'])
  expect(store.role(target.id, liz.id)).toBeNull()
})

test('an existing tree brings in people from another tree and from the network', async () => {
  const { store, net, as, sent } = world()
  const me = store.findOrCreateUser('me@example.com')
  const shawn = store.findOrCreateUser('shawn@example.com')
  const a = store.createTree(me.id, 'A')
  const p1 = store.addPerson(a.id, { given: 'Grandpa', surname: 'X', sex: 'M' })
  const p2 = store.addPerson(a.id, { given: 'Grandma', surname: 'X', sex: 'F' })
  store.createFamily(a.id, p1.id, p2.id, { kind: 'married' })
  const b = store.createTree(me.id, 'B')
  store.addPerson(b.id, { given: 'Already', surname: 'Here' })
  const contact = net.addContact(me.id, { name: 'Shawn Sarkis', circle: 'family' }, { linked_user_id: shawn.id })

  const page = await (await as(me).get(`/t/${b.id}`)).text()
  expect(page).toContain('Bring in people from your other trees')
  expect(page).toContain(`value="c:${contact.id}"`)
  expect(page).not.toContain(`value="p:${b.id}:`)

  const res = await as(me).post(`/t/${b.id}/bring`, [['pick', `p:${a.id}:${p1.id}`], ['pick', `p:${a.id}:${p2.id}`], ['pick', `c:${contact.id}`], ['share', '1']])
  expect(decodeURIComponent(res.headers.get('location')!)).toContain('Added 3 people; 1 of them can now see this tree (emailed shawn@example.com)')
  expect(sent.map((m) => m.to)).toEqual(['shawn@example.com'])
  const gp = store.people(b.id).find((p) => p.given === 'Grandpa')!
  expect(store.spouseFamilies(b.id, gp.id)[0]!.partner!.given).toBe('Grandma')
  const sh = store.people(b.id).find((p) => p.given === 'Shawn')!
  expect(sh.surname).toBe('Sarkis')
  expect(store.profilePerson(b.id, shawn.id)).toBe(sh.id)
  expect(net.contact(me.id, contact.id)!.person_id).toBe(sh.id)
})
