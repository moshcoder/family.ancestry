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

test('circle prints each lifespan once', async () => {
  const store = new Store(':memory:')
  const me = store.findOrCreateUser('a@example.com')
  const tree = store.createTree(me.id, 'T')
  const a = store.addPerson(tree.id, { given: 'Ann', surname: 'X' })
  const b = store.addPerson(tree.id, { given: 'Bea', surname: 'X', birth_date: '1971' })
  store.addBond(tree.id, a.id, b.id, 'friend')
  const auth = new Auth(store, async () => {}, 'https://family.test')
  const app = createApp({ store, auth, site: 'https://family.test' })
  const html = await (await app.request(`https://family.test/t/${tree.id}/p/${a.id}`, { headers: { cookie: `fa_session=${auth.createSession(me.id)}` } })).text()
  const at = html.indexOf('<section class="circle"')
  expect(html.slice(at, html.indexOf('</section>', at)).split('1971').length - 1).toBe(1)
})

test('partner row: viewers see Married/Partner, editors set the relationship status in place', async () => {
  const { store, me, tree, david } = family()
  const CSRF = 'testcsrftoken0123456789'
  const auth = new Auth(store, async () => {}, 'https://family.test')
  const app = createApp({ store, auth, site: 'https://family.test' })
  const cookie = `fa_session=${auth.createSession(me.id)}; fa_csrf=${CSRF}`
  const page = async (c = cookie) => {
    const html = await (await app.request(`https://family.test/t/${tree.id}/p/${david.id}`, { headers: { cookie: c } })).text()
    const at = html.indexOf('<section class="circle"')
    return html.slice(at, html.indexOf('</section>', at))
  }
  const fam = store.spouseFamilies(tree.id, david.id)[0]!.family
  const circle = await page()
  expect(circle).toContain('aria-label="Relationship status"')
  for (const word of ['Married', 'Engaged', 'Partner', 'Dating', 'Separated', 'Divorced', 'Widowed']) expect(circle).toContain(`>${word}</option>`)
  expect(circle).toContain('value="partners" selected')
  expect(circle).toContain(`id="union-${fam.id}"`)
  const post = (status: string) =>
    app.request(`https://family.test/t/${tree.id}/f/${fam.id}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', referer: `https://family.test/t/${tree.id}/p/${david.id}` }, body: new URLSearchParams({ _csrf: CSRF, status }) })
  await post('married')
  expect(store.family(tree.id, fam.id)).toMatchObject({ kind: 'married', end_kind: null })
  await post('divorced')
  expect(store.family(tree.id, fam.id)).toMatchObject({ kind: 'married', end_kind: 'divorced' })
  expect(await page()).toContain('value="divorced" selected')
  await post('married')
  expect(store.family(tree.id, fam.id)).toMatchObject({ kind: 'married', end_kind: null, end_date: null })
  // A viewer gets the word, not the select.
  const viewer = store.findOrCreateUser('v@example.com')
  store.setMember(tree.id, viewer.id, 'viewer')
  const seen = await page(`fa_session=${auth.createSession(viewer.id)}`)
  expect(seen).toContain('<span class="tag">Married</span>')
  expect(seen).not.toContain('aria-label="Relationship status"')
})

test('API sets a relationship status and refuses a made-up one', async () => {
  const { store, me, tree, david } = family()
  const auth = new Auth(store, async () => {}, 'https://family.test')
  const app = createApp({ store, auth, site: 'https://family.test' })
  const fam = store.spouseFamilies(tree.id, david.id)[0]!.family
  const patch = (status: string) =>
    app.request(`https://family.test/api/v1/trees/${tree.id}/families/${fam.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${auth.createToken(me.id, 'test')}`, 'content-type': 'application/json' }, body: JSON.stringify({ status }) })
  const ok = (await (await patch('separated')).json()) as any
  expect(ok.family).toMatchObject({ kind: 'partners', end_kind: 'separated' })
  expect((await patch('situationship')).status).toBe(400)
})
