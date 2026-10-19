import { describe, expect, test } from 'bun:test'
import { nameFits, Store, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'
import { Network } from '../src/network.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

function world() {
  const store = new Store(':memory:')
  const auth = new Auth(store, async () => {}, SITE)
  const app = createApp({ store, auth, site: SITE, net: new Network(store) })
  const as = (u: User) => {
    const cookie = `fa_session=${auth.createSession(u.id)}; fa_csrf=${CSRF}`
    return {
      get: (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } }),
      post: (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
    }
  }
  const user = (email: string, name: string | null) => {
    const u = store.findOrCreateUser(email)
    if (name) store.setUserName(u.id, name)
    return store.user(u.id)!
  }
  const claim = (treeId: string, personId: string, userId: string) => store.db.query('INSERT INTO profiles (tree_id, person_id, user_id, created_at) VALUES (?,?,?,?)').run(treeId, personId, userId, Date.now())
  return { store, as, user, claim }
}

describe('claiming yourself', () => {
  test('names: first, last, nickname, or the email; no name on the account cannot be checked', () => {
    const tony = { name: 'Anthony Ettinger', email: 'ettinger@gmail.com' }
    expect(nameFits(tony, { given: 'Anthony', surname: 'Ettinger' })).toBe(true)
    expect(nameFits(tony, { given: 'Tony', surname: 'Ettinger' })).toBe(true)
    expect(nameFits(tony, { given: 'Joellen', surname: 'Arnold' })).toBe(false)
    expect(nameFits({ name: 'Karen', email: 'ettingerkaren@gmail.com' }, { given: 'Karen', surname: 'Rademacher' })).toBe(true)
    expect(nameFits({ name: 'K', email: 'ettingerkaren@gmail.com' }, { given: 'Karen', surname: 'Ettinger' })).toBe(true)
    expect(nameFits({ name: null, email: 'x@example.com' }, { given: 'Joellen', surname: 'Arnold' })).toBe(true)
  })

  test('adding your aunt never offers to make her you, and the server refuses it', async () => {
    const w = world()
    const owner = w.user('anthony@example.com', 'Anthony Ettinger')
    const me = w.user('ettinger@example.com', 'Anthony Ettinger')
    const tree = w.store.createTree(owner.id, 'The Ettinger Family')
    w.store.setMember(tree.id, me.id, 'admin')
    await w.as(me).post(`/t/${tree.id}/people`, { given: 'Joellen', surname: 'Arnold', living: '1' })
    const aunt = w.store.people(tree.id, 100).find((p) => p.given === 'Joellen')!
    expect(await (await w.as(me).get(`/t/${tree.id}/p/${aunt.id}?added=1`)).text()).not.toContain('This is me')
    await w.as(me).post(`/t/${tree.id}/claim`, { person_id: aunt.id })
    expect(w.store.profilePerson(tree.id, me.id)).toBeNull()
    expect(await (await w.as(me).get(`/t/${tree.id}/claim`)).text()).not.toContain('Joellen')
    // "Add yourself" with someone else's name is refused too.
    await w.as(me).post(`/t/${tree.id}/claim`, { given: 'Joellen', surname: 'Arnold' })
    expect(w.store.profilePerson(tree.id, me.id)).toBeNull()

    // His own entry still works.
    const self = w.store.addPerson(tree.id, { given: 'Tony', surname: 'Ettinger', living: '1' })
    expect(await (await w.as(me).get(`/t/${tree.id}/p/${self.id}`)).text()).toContain('This is me')
    await w.as(me).post(`/t/${tree.id}/claim`, { person_id: self.id })
    expect(w.store.profilePerson(tree.id, me.id)).toBe(self.id)
  })

  test('the migration releases only claims nothing backs', () => {
    const w = world()
    const owner = w.user('anthony@example.com', 'Anthony Ettinger')
    const me = w.user('ettinger@example.com', 'Anthony Ettinger')
    const maile = w.user('2peanut@example.com', null)
    const karen = w.user('karen@example.com', 'Karen Ettinger')
    const liz = w.user('liz@example.com', 'Liz Toshikian')
    const tree = w.store.createTree(owner.id, 'The Ettinger Family')
    for (const u of [me, maile, karen, liz]) w.store.setMember(tree.id, u.id, 'viewer')
    const add = (given: string, surname: string) => w.store.addPerson(tree.id, { given, surname, living: '1' })

    const anthony = add('Anthony', 'Ettinger')
    w.claim(tree.id, anthony.id, owner.id) // name fits: kept
    const joellen = add('Joellen', 'Arnold')
    w.claim(tree.id, joellen.id, me.id) // the bug: released
    const mai = add('Maile', 'Toshikian')
    w.claim(tree.id, mai.id, maile.id) // no name to check: kept
    const elizabeth = add('Elizabeth', 'Guizio')
    w.claim(tree.id, elizabeth.id, liz.id) // a different name, but her invite proves it: kept
    w.store.db.query("INSERT INTO invites (token_hash, tree_id, role, email, created_by, created_at, expires_at, used_by, person_id) VALUES ('h', ?, 'viewer', ?, ?, 0, 0, ?, ?)").run(tree.id, liz.email, owner.id, liz.id, elizabeth.id)

    const released = w.store.releaseMisclaims()
    expect(released.map((r) => r.person)).toEqual(['Joellen Arnold'])
    expect(w.store.profileUser(tree.id, joellen.id)).toBeNull()
    for (const [p, u] of [[anthony, owner], [mai, maile], [elizabeth, liz]] as const) expect(w.store.profileUser(tree.id, p.id)?.id).toBe(u.id)
    expect(w.store.releaseMisclaims()).toEqual([])
    expect(karen.id).toBeTruthy()
  })
})
