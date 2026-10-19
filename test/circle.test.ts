import { expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'

/** David: parents, a sister with a son, a partner and a daughter, a pet, a friend, a job. */
function family() {
  const store = new Store(':memory:')
  const me = store.findOrCreateUser('a@example.com')
  const tree = store.createTree(me.id, 'Ettinger')
  const add = (given: string, surname = 'Ettinger') => store.addPerson(tree.id, { given, surname })
  const [ac, kathleen, david, sis, nephew, karen, kid, grandpa, alex] = ['A.C.', 'Kathleen', 'David', 'Sue', 'Tim', 'Karen', 'Anthony', 'Grandpa', 'Alex'].map((n) => add(n))
  const parents = store.createFamily(tree.id, ac!.id, kathleen!.id)
  store.addChild(tree.id, parents.id, david!.id)
  store.addChild(tree.id, parents.id, sis!.id)
  store.addChild(tree.id, store.createFamily(tree.id, grandpa!.id, null).id, ac!.id)
  store.addChild(tree.id, store.createFamily(tree.id, sis!.id, null).id, nephew!.id)
  store.addChild(tree.id, store.createFamily(tree.id, david!.id, karen!.id, { kind: 'partners' }).id, kid!.id)
  store.addBond(tree.id, david!.id, alex!.id, 'friend')
  const socs = store.addPet(tree.id, { given: 'Socs', species: 'Dog' }, [david!.id])
  const ibm = store.addBusiness(tree.id, { name: 'IBM' })
  store.addBusinessRole(tree.id, ibm.id, david!.id, { role: 'employee' })
  return { store, me, tree, david: david!, socs, sis: sis! }
}

test('circle groups everyone once: family near and far, pets, friends, businesses', () => {
  const { store, tree, david, socs } = family()
  const c = store.circle(tree.id, david.id)
  const by = Object.fromEntries(c.groups.map((g) => [g.label, g.people.map((r) => r.person.given)]))
  expect(by).toEqual({
    Parents: ['A.C.', 'Kathleen'],
    'Brothers and sisters': ['Sue'],
    Partners: ['Karen'],
    Children: ['Anthony'],
    Grandparents: ['Grandpa'],
    'Nieces and nephews': ['Tim'],
    Pets: ['Socs'],
    'Friends, godparents and others': ['Alex'],
  })
  expect(c.businesses.map((b) => [b.business.name, b.role])).toEqual([['IBM', 'employee']])
  // On the pet's own page its people are its owners.
  expect(store.circle(tree.id, socs.id).groups.map((g) => g.label)).toEqual(['Owners'])
})

test('person page shows the circle and starts a new family tree from the ticked people', async () => {
  const { store, me, tree, david, sis } = family()
  const auth = new Auth(store, async () => {}, 'https://family.test')
  const app = createApp({ store, auth, site: 'https://family.test' })
  const cookie = `fa_session=${auth.createSession(me.id)}`
  const html = await (await app.request(`https://family.test/t/${tree.id}/p/${david.id}`, { headers: { cookie } })).text()
  expect(html).toContain("Everyone in David's life")
  expect(html).toContain('Nieces and nephews')
  expect(html).toContain('>IBM</a>')
  expect(html).toContain('Start a new family tree')
  // Close family is ticked by default, the wider family is not.
  expect(html).toContain(`value="p:${tree.id}:${sis.id}" checked`)

  const api = await (await app.request(`https://family.test/api/v1/trees/${tree.id}/people/${david.id}`, { headers: { authorization: `Bearer ${auth.createToken(me.id, "test")}` } })).json()
  expect(api.person.circle.groups.find((g: any) => g.label === 'Pets').people[0].name).toBe('Socs')
  expect(api.person.circle.businesses[0]).toMatchObject({ name: 'IBM', role: 'employee' })
})
