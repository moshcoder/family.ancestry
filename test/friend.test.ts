import { expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'

test('a friend in the tree: "How are we related?" says friend, both ways', async () => {
  const store = new Store(':memory:')
  const auth = new Auth(store, async () => {}, 'https://family.test')
  const me = store.findOrCreateUser('a@example.com')
  const tree = store.createTree(me.id, 'Fam')
  const anthony = store.addPerson(tree.id, { given: 'Anthony', surname: 'Ettinger', sex: 'M' })
  const alex = store.addPerson(tree.id, { given: 'Alex', surname: 'Drexel', sex: 'M' })
  store.addBond(tree.id, anthony.id, alex.id, 'friend')
  expect(store.bondsFor(tree.id, alex.id)[0]!.label).toBe('Friend')
  const app = createApp({ store, auth, site: 'https://family.test' })
  const cookie = `fa_session=${auth.createSession(me.id)}`
  const page = async (a: string, b: string) => (await app.request(`https://family.test/t/${tree.id}/relate?a=${a}&b=${b}`, { headers: { cookie } })).text()
  expect(await page(anthony.id, alex.id)).toContain("Anthony Ettinger's <b>friend</b>")
  expect(await page(alex.id, anthony.id)).toContain("Alex Drexel's <b>friend</b>")
  // No bond, no family line: still says so.
  const stranger = store.addPerson(tree.id, { given: 'Pat', surname: 'Nobody' })
  expect(await page(anthony.id, stranger.id)).toContain('No connection found')
})
