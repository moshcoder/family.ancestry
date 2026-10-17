import { describe, expect, test } from 'bun:test'
import { Store, fullName, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { Network } from '../src/network.ts'
import { addRelative, createApp } from '../src/server.ts'
import { lifeKey, recordLifeEvent, timeline } from '../src/life.ts'
import { exportGedcom, importGedcom } from '../src/gedcom.ts'

const SITE = 'http://family.test'
const CSRF = 'csrfcsrfcsrfcsrf1234'

function family() {
  const store = new Store(':memory:')
  const owner = store.findOrCreateUser('owner@example.com')
  const viewer = store.findOrCreateUser('karen@example.com')
  const tree = store.createTree(owner.id, 'Ettingers')
  store.setMember(tree.id, viewer.id, 'viewer')
  const bob = store.addPerson(tree.id, { given: 'Robert', surname: 'Ettinger', sex: 'M', birth_date: '1930' })
  const karen = store.addPerson(tree.id, { given: 'Karen', surname: 'Ettinger', sex: 'F', birth_date: '1960', living: 1 })
  store.claimProfile(tree.id, karen.id, viewer.id)
  const life = (personId: string, body: Record<string, any>) => recordLifeEvent(store, tree.id, personId, body, addRelative)
  const auth = new Auth(store, async () => {}, SITE)
  const server = createApp({ store, auth, site: SITE, net: new Network(store) })
  const as = (user: User) => {
    const cookie = `fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`
    const bearer = auth.createToken(user.id, 'test')
    return {
      get: (path: string) => server.request(`${SITE}${path}`, { headers: { cookie } }),
      post: (path: string, fields: Record<string, string> = {}) => server.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
      api: (path: string, body: unknown) => server.request(`${SITE}/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }
  }
  return { store, tree, owner, viewer, bob, karen, life, as }
}

const types = (t: ReturnType<typeof timeline>) => t.map((e) => [e.type, e.date, e.description])

describe('life events go where they belong', () => {
  test('birth and death are the person’s own dates', () => {
    const { store, tree, bob, life } = family()
    life(bob.id, { what: 'death', date: '3 MAR 2010', place: 'Sacramento, California', description: 'Heart failure' })
    expect(store.person(tree.id, bob.id)).toMatchObject({ death_date: '3 MAR 2010', death_place: 'Sacramento, California', living: 0 })
    expect(store.person(tree.id, bob.id)!.notes).toContain('Death: Heart failure')
    life(bob.id, { what: 'birth', place: 'Chicago' })
    expect(store.person(tree.id, bob.id)).toMatchObject({ birth_date: '1930', birth_place: 'Chicago' })
    expect(store.events(tree.id, bob.id)).toEqual([])
  })

  test('marriage, divorce, remarriage: partnerships, and the timeline says so in order', () => {
    const { store, tree, bob, life } = family()
    life(bob.id, { what: 'marriage', date: '1955', place: 'Reno', with_given: 'Joan', with_surname: 'Miller' })
    const joan = store.spouseFamilies(tree.id, bob.id)[0]!
    expect(joan.family).toMatchObject({ kind: 'married', start_date: '1955', start_place: 'Reno' })
    life(bob.id, { what: 'divorce', date: '1962', place: 'Reno', with: `f:${joan.family.id}` })
    expect(store.family(tree.id, joan.family.id)).toMatchObject({ end_date: '1962', end_kind: 'divorced', end_place: 'Reno' })
    life(bob.id, { what: 'remarriage', date: '1964', with_given: 'Rose', with_surname: 'Hall' })
    life(bob.id, { what: 'job_change', date: '1971', description: 'Took over Ettinger Plumbing' })
    const p = store.person(tree.id, bob.id)!
    expect(types(timeline(p, store.spouseFamilies(tree.id, bob.id), store.events(tree.id, bob.id)))).toEqual([
      ['Birth', '1930', null],
      ['Marriage', '1955', 'with Joan Miller'],
      ['Divorce', '1962', 'with Joan Miller'],
      ['Remarriage', '1964', 'with Rose Hall'],
      ['Job change', '1971', 'Took over Ettinger Plumbing'],
    ])
  })

  test('marrying the same person again after a divorce is a second marriage; dating then marrying is one', () => {
    const { store, tree, bob, life } = family()
    life(bob.id, { what: 'dating', date: '1953', with_given: 'Joan', with_surname: 'Miller' })
    const [u] = store.spouseFamilies(tree.id, bob.id)
    life(bob.id, { what: 'marriage', date: '1955', with: `f:${u!.family.id}` })
    expect(store.spouseFamilies(tree.id, bob.id).map((x) => [x.family.kind, x.family.start_date])).toEqual([['married', '1955']])
    life(bob.id, { what: 'divorce', with: `f:${u!.family.id}` })
    expect(store.family(tree.id, u!.family.id)!.end_date).toBe('Divorced')
    life(bob.id, { what: 'marriage', date: '1970', with_person: u!.partner!.id })
    expect(store.spouseFamilies(tree.id, bob.id).length).toBe(2)
  })

  test('widowed: the partnership ends and the partner died then', () => {
    const { store, tree, bob, life } = family()
    life(bob.id, { what: 'marriage', with_given: 'Rose', with_surname: 'Hall' })
    const rose = store.spouseFamilies(tree.id, bob.id)[0]!.partner!
    life(bob.id, { what: 'widowed', date: '2001', with_person: `Rose Hall #${rose.id}` })
    expect(store.person(tree.id, rose.id)).toMatchObject({ death_date: '2001', living: 0 })
    expect(store.spouseFamilies(tree.id, bob.id)[0]!.family).toMatchObject({ end_kind: 'widowed', end_date: '2001' })
  })

  test('children: born (with the other parent), adopted, and step-children', () => {
    const { store, tree, bob, karen, life } = family()
    life(bob.id, { what: 'marriage', with_given: 'Rose', with_surname: 'Hall' })
    const u = store.spouseFamilies(tree.id, bob.id)[0]!
    life(bob.id, { what: 'child', date: '1966', place: 'Sacramento', with: `f:${u.family.id}`, child_given: 'David', child_surname: 'Ettinger' })
    const david = store.spouseFamilies(tree.id, bob.id)[0]!.children[0]!
    expect(david).toMatchObject({ given: 'David', birth_date: '1966', birth_place: 'Sacramento' })
    // A typed name that matches one person is that person.
    life(bob.id, { what: 'adopted_child', date: '1970', child: 'Karen Ettinger' })
    expect(store.parentFamilies(tree.id, karen.id).map((f) => f.relation)).toEqual(['adopted'])
    expect(store.events(tree.id, karen.id)[0]).toMatchObject({ type: 'Adoption', date: '1970', description: 'Adopted by Robert Ettinger' })
    expect(() => life(bob.id, { what: 'child', child: 'Nobody Here' })).toThrow('nobody called Nobody Here')

    // Rose had a son before; Bob becomes his step-father.
    const rose = u.partner!
    life(bob.id, { what: 'step_child', date: '1964', with: `f:${u.family.id}`, child_given: 'Tim', child_surname: 'Hall' })
    const tim = store.search(tree.id, 'Tim')[0]!
    expect(store.stepChildren(tree.id, bob.id)).toEqual([{ familyId: u.family.id, children: [expect.objectContaining({ id: tim.id })] }])
    expect(store.spouseFamilies(tree.id, rose.id).flatMap((x) => x.children.map(fullName))).toContain('Tim Hall')
    expect(store.stepParents(tree.id, tim.id).map((p) => p.id)).toEqual([bob.id])
    const t = timeline(store.person(tree.id, bob.id)!, store.spouseFamilies(tree.id, bob.id), store.events(tree.id, bob.id))
    expect(t.map((e) => e.type)).toEqual(['Birth', 'Birth of daughter', 'Became a step-parent', 'Birth of child', 'Adopted a child'])
  })

  test('anything else is a plain event; Other takes its own name', () => {
    const { store, tree, karen, life } = family()
    life(karen.id, { what: 'graduation', date: '1982', place: 'UC Davis' })
    life(karen.id, { what: 'other', custom: 'Won the county fair', date: '1975' })
    expect(store.events(tree.id, karen.id).map((e) => e.type)).toEqual(['Won the county fair', 'Graduation'])
    expect(lifeKey('Divorce')).toBe('divorce')
    expect(lifeKey('job change')).toBe('job_change')
    expect(lifeKey('Fishing trip')).toBeNull()
  })

  test('pets: birth, death, a move; never a marriage', () => {
    const { store, tree, bob, life } = family()
    const dog = store.addPet(tree.id, { given: 'Socs', species: 'Dog' }, [bob.id])
    life(dog.id, { what: 'death', date: '1968' })
    expect(store.person(tree.id, dog.id)!.death_date).toBe('1968')
    expect(() => life(dog.id, { what: 'marriage', with_given: 'Rex' })).toThrow('a pet does not have a marriage')
  })
})

describe('life events on the web and the API', () => {
  test('the form lists births, deaths, marriages, divorces, children and job changes', async () => {
    const { tree, bob, owner, as } = family()
    const page = await (await as(owner).get(`/t/${tree.id}/p/${bob.id}`)).text()
    for (const label of ['Birth', 'Death', 'Marriage', 'Remarriage', 'Divorce', 'Separation', 'Widowed', 'Child born', 'Became a step-parent', 'Job change', 'Retirement', 'Military', 'Moved'])
      expect(page).toContain(`>${label}</option>`)
    expect(page).toContain('data-life-event')
  })

  test('an editor records a divorce; a viewer on their own profile can add a job but not a marriage', async () => {
    const { store, tree, bob, karen, owner, viewer, as } = family()
    const me = as(owner)
    await me.post(`/t/${tree.id}/p/${bob.id}/events`, { what: 'marriage', date: '1955', with_given: 'Joan', with_surname: 'Miller' })
    const fam = store.spouseFamilies(tree.id, bob.id)[0]!.family
    const res = await me.post(`/t/${tree.id}/p/${bob.id}/events`, { what: 'divorce', date: '1962', with: `f:${fam.id}` })
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('ok=Divorce: Robert Ettinger and Joan Miller')
    const page = await (await me.get(`/t/${tree.id}/p/${bob.id}`)).text()
    expect(page).toContain('<b>Divorce</b>')
    expect(page).toContain('divorced 1962')

    const k = as(viewer)
    const page2 = await (await k.get(`/t/${tree.id}/p/${karen.id}`)).text()
    expect(page2).toContain('>Job change</option>')
    expect(page2).not.toContain('>Marriage</option>')
    await k.post(`/t/${tree.id}/p/${karen.id}/events`, { what: 'job_change', date: '1990', description: 'Nurse at Sutter' })
    expect(store.events(tree.id, karen.id).map((e) => e.type)).toEqual(['Job change'])
    const no = await k.post(`/t/${tree.id}/p/${karen.id}/events`, { what: 'marriage', with_given: 'Sam' })
    expect(decodeURIComponent(no.headers.get('location')!)).toContain('ask an editor')
    expect(store.spouseFamilies(tree.id, karen.id)).toEqual([])
  })

  test('the API (and so the CLI and MCP) take a label: type Death sets the death date', async () => {
    const { store, tree, bob, owner, as } = family()
    const res = await as(owner).api(`/trees/${tree.id}/people/${bob.id}/events`, { type: 'Death', date: '2010', place: 'Sacramento' })
    expect(res.status).toBe(201)
    expect(store.person(tree.id, bob.id)).toMatchObject({ death_date: '2010', living: 0 })
    await as(owner).api(`/trees/${tree.id}/people/${bob.id}/events`, { type: 'Fishing trip', date: '1980' })
    expect(store.events(tree.id, bob.id).map((e) => e.type)).toEqual(['Fishing trip'])
  })
})

describe('GEDCOM keeps how a partnership ended', () => {
  test('divorce place and a separation round-trip', () => {
    const { store, tree, bob, life } = family()
    life(bob.id, { what: 'marriage', date: '1955', with_given: 'Joan', with_surname: 'Miller', with_sex: 'F' })
    life(bob.id, { what: 'divorce', date: '1962', place: 'Reno', with_person: store.spouseFamilies(tree.id, bob.id)[0]!.partner!.id })
    life(bob.id, { what: 'marriage', date: '1964', with_given: 'Rose', with_surname: 'Hall', with_sex: 'F' })
    life(bob.id, { what: 'separation', date: '1999', with_person: store.search(tree.id, 'Rose')[0]!.id })
    const ged = exportGedcom(store, tree.id)
    expect(ged).toContain('1 DIV\r\n2 DATE 1962\r\n2 PLAC Reno')
    expect(ged).toContain('1 _END separated\r\n2 DATE 1999')
    const other = store.createTree(store.findOrCreateUser('x@example.com').id, 'Copy')
    importGedcom(store, other.id, ged)
    const copy = store.search(other.id, 'Robert')[0]!
    expect(store.spouseFamilies(other.id, copy.id).map((u) => [u.family.end_kind, u.family.end_date, u.family.end_place ?? null])).toEqual([
      ['divorced', '1962', 'Reno'],
      ['separated', '1999', null],
    ])
  })
})
