import { expect, test } from 'bun:test'
import { Store, fullName } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { addRelative, createApp } from '../src/server.ts'

const setup = () => {
  const store = new Store(':memory:')
  const auth = new Auth(store, async () => {}, 'https://family.test')
  const me = store.findOrCreateUser('a@example.com')
  const tree = store.createTree(me.id, 'Fam')
  const martha = store.addPerson(tree.id, { given: 'Martha', surname: 'Ettinger', sex: 'F' })
  const app = createApp({ store, auth, site: 'https://family.test' })
  const cookie = `fa_session=${auth.createSession(me.id)}`
  const get = async (path: string) => (await app.request(`https://family.test${path}`, { headers: { cookie } })).text()
  return { store, tree, martha, get }
}

test('the whole family: aunts, cousins, nieces, grandchildren, great-grandparents, with Unknowns in between', async () => {
  const { store, tree, martha, get } = setup()
  const rel = (as: string, given: string, sex: string, extra: Record<string, string> = {}) => addRelative(store, tree.id, martha.id, { as, given, surname: 'X', sex, ...extra })
  const aunt = rel('aunt_uncle', 'Ann', 'F')
  const cousin = rel('cousin', 'Cal', 'M', { via: aunt.id })
  const niece = rel('niece_nephew', 'Nia', 'F')
  const grandkid = rel('grandchild', 'Gus', 'M')
  const great = rel('great_grandparent', 'Greta', 'F')
  const words = async (b: string) => (await get(`/t/${tree.id}/relate?a=${martha.id}&b=${b}`)).replace(/<[^>]+>/g, '')
  expect(await words(aunt.id)).toContain('aunt')
  expect(await words(cousin.id)).toContain('cousin')
  expect(await words(niece.id)).toContain('niece')
  expect(await words(grandkid.id)).toContain('grandson')
  expect(await words(great.id)).toContain('great-grandmother')
  // The links nobody knows yet are Unknown people, there to be filled in.
  expect(store.people(tree.id, 100).filter((p) => p.given === 'Unknown').length).toBeGreaterThan(0)
  // A known cousin's parent is the picked aunt, not a new Unknown.
  expect(store.parents(tree.id, cousin.id).map(fullName)).toEqual(['Ann X'])
})

test('Add a friend is on every person page, open, with every kind of bond', async () => {
  const { tree, martha, get, store } = setup()
  const html = await get(`/t/${tree.id}/p/${martha.id}`)
  expect(html).toContain('Add a friend, neighbor, coworker, godparent')
  for (const k of ['friend', 'best_friend', 'coworker', 'classmate', 'mentor', 'roommate', 'employer', 'ex', 'teammate', 'served_with', 'godparent']) expect(html).toContain(`value="${k}"`)
  for (const t of ['Add an aunt or uncle', 'Add a cousin', 'Add a niece or nephew', 'Add a grandchild', 'Add a great-grandparent']) expect(html).toContain(t)
  expect(html).toContain('<option value="engaged">engaged</option>')
  const bob = store.addPerson(tree.id, { given: 'Bob', surname: 'Ettinger', sex: 'M' })
  store.addBond(tree.id, martha.id, bob.id, 'coworker')
  expect(store.bondsFor(tree.id, bob.id)[0]!.label).toBe('Coworker')
})
