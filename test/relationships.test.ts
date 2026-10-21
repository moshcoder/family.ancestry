import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Store, type User } from '../src/db.ts'
import { Auth, type Mail } from '../src/auth.ts'
import { Network } from '../src/network.ts'
import { addRelative, createApp, parseInvitees } from '../src/server.ts'
import { describeRelation } from '../src/relate.ts'
import { exportGedcom, importGedcom } from '../src/gedcom.ts'
import { planFromEnv, verifyWebhook } from '../src/plan.ts'

const SITE = 'http://family.test'
const CSRF = 'csrfcsrfcsrfcsrf1234'

function setup() {
  const store = new Store(':memory:')
  const user = store.findOrCreateUser('owner@example.com')
  const tree = store.createTree(user.id, 'Fam')
  const add = (given: string, sex = 'U', extra: Record<string, unknown> = {}) => store.addPerson(tree.id, { given, surname: 'Doe', sex, ...extra })
  const words = (a: string, b: string) => describeRelation(store.relationship(tree.id, a, b), store.siblings(tree.id, a).find((s) => s.person.id === b))
  return { store, user, tree, add, words, rel: (person: string, body: Record<string, unknown>) => addRelative(store, tree.id, person, body) }
}

function world(env: Record<string, string> = {}) {
  const store = new Store(':memory:')
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const calls: { url: string; body: any; auth: string | null }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') })
    const id = `cs_${calls.length}`
    return new Response(JSON.stringify({ success: true, id, url: `https://coinpay.test/checkout/${id}`, status: 'open', methods: ['USDC_POL', 'BTC', 'PAYPAL'], expires_at: null }), { status: 201 })
  }) as unknown as typeof fetch
  const plan = planFromEnv(env)
  const app = createApp({ store, auth, site: SITE, net: new Network(store), plan, fetcher })
  const as = (user: User) => {
    const cookie = `fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`
    return {
      get: (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } }),
      post: (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
    }
  }
  return { store, mail, app, as, calls, plan, auth, user: (email: string) => store.findOrCreateUser(email) }
}

describe('siblings', () => {
  test('a full sibling with no parents recorded, then the parents arrive', () => {
    const { store, tree, add, rel, words } = setup()
    const me = add('Me', 'F')
    const bro = rel(me.id, { as: 'sibling', given: 'Bro', sex: 'M' })
    expect(store.siblings(tree.id, me.id).map((s) => [s.person.id, s.kind])).toEqual([[bro.id, 'full']])
    expect(words(me.id, bro.id)).toBe('brother')
    // Adding a parent to one of them fills the shared family, so it is the other's parent too.
    const mom = rel(me.id, { as: 'parent', given: 'Mom', sex: 'F' })
    expect(store.parents(tree.id, bro.id).map((p) => p.id)).toEqual([mom.id])
  })

  test('half, step, adopted and foster siblings, named properly', () => {
    const { store, tree, add, rel, words } = setup()
    const me = add('Me', 'F')
    const mom = rel(me.id, { as: 'parent', given: 'Mom', sex: 'F' })
    const dad = rel(me.id, { as: 'parent', given: 'Dad', sex: 'M' })
    const half = rel(me.id, { as: 'sibling', sibling: 'half', via: dad.id, given: 'Half', sex: 'M' })
    expect(store.parents(tree.id, half.id).map((p) => p.id)).toEqual([dad.id])
    expect(words(me.id, half.id)).toBe('half-brother')

    // Mom remarries; her new husband's daughter from before is a step-sister.
    const stepdad = rel(mom.id, { as: 'partner', given: 'Stepdad', sex: 'M' })
    expect(store.stepParents(tree.id, me.id).map((p) => p.id)).toEqual([stepdad.id])
    expect(words(me.id, stepdad.id)).toBe('stepfather')
    const stepsis = rel(me.id, { as: 'sibling', sibling: 'step', via: stepdad.id, given: 'Stepsis', sex: 'F' })
    expect(store.parents(tree.id, stepsis.id).map((p) => p.id)).toEqual([stepdad.id])
    expect(words(me.id, stepsis.id)).toBe('stepsister')

    const adopted = rel(me.id, { as: 'sibling', sibling: 'adopted', given: 'Ada', sex: 'F' })
    const foster = rel(me.id, { as: 'sibling', sibling: 'foster', given: 'Fos', sex: 'M' })
    const kinds = Object.fromEntries(store.siblings(tree.id, me.id).map((s) => [s.person.given, s.kind]))
    expect(kinds).toEqual({ Ada: 'adoptive', Fos: 'foster', Half: 'half', Stepsis: 'step' })
    expect(words(me.id, adopted.id)).toBe('sister (by adoption)')
    expect(words(me.id, foster.id)).toBe('foster brother')
    // And from the other side.
    expect(words(half.id, me.id)).toBe('half-sister')
  })

  test('half needs a real parent', () => {
    const { add, rel } = setup()
    const me = add('Me')
    expect(() => rel(me.id, { as: 'sibling', sibling: 'half', given: 'X' })).toThrow(/which parent/)
  })
})

describe('parents we do not know, and who raised you', () => {
  test('grandparents with an unknown parent between, who raised them', () => {
    const { store, tree, add, rel, words } = setup()
    const me = add('Me', 'M')
    const grandma = rel(me.id, { as: 'grandparent', given: 'Rose', sex: 'F', raised: '1' })
    const [unknown] = store.parents(tree.id, me.id)
    expect(unknown!.given).toBe('Unknown')
    expect(store.parents(tree.id, unknown!.id).map((p) => p.id)).toEqual([grandma.id])
    expect(words(me.id, grandma.id)).toBe('grandmother')
    // Grandpa joins on the same unknown parent's side.
    const grandpa = rel(me.id, { as: 'grandparent', via: unknown!.id, given: 'Walt', sex: 'M', raised: '1' })
    expect(store.parents(tree.id, unknown!.id).map((p) => p.id).sort()).toEqual([grandma.id, grandpa.id].sort())
    expect(store.bondsFor(tree.id, me.id).map((b) => `${b.label} ${b.other.given}`)).toEqual(['Raised by Rose', 'Raised by Walt'])
    expect(store.bondsFor(tree.id, grandma.id).map((b) => `${b.label} ${b.other.given}`)).toEqual(['Raised Me'])
  })

  test('adoptive, step and foster parents and children in words', () => {
    const { add, rel, words } = setup()
    const kid = add('Kid', 'F')
    const amom = rel(kid.id, { as: 'parent', relation: 'adopted', given: 'Amom', sex: 'F' })
    const fdad = rel(kid.id, { as: 'parent', relation: 'foster', given: 'Fdad', sex: 'M' })
    expect(words(kid.id, amom.id)).toBe('adoptive mother')
    expect(words(amom.id, kid.id)).toBe('adopted daughter')
    expect(words(kid.id, fdad.id)).toBe('foster father')
    const gran = rel(amom.id, { as: 'parent', given: 'Gran', sex: 'F' })
    expect(words(kid.id, gran.id)).toBe('grandmother (by adoption)')
  })

  test('friends, neighbors, work and school: each reads right from both sides and survives GEDCOM', () => {
    const { store, tree, add, user } = setup()
    const me = add('Me')
    const boss = add('Boss')
    const prof = add('Prof')
    const doc = add('Doc')
    store.addBond(tree.id, me.id, boss.id, 'employer')
    store.addBond(tree.id, me.id, prof.id, 'teacher')
    store.addBond(tree.id, me.id, doc.id, 'doctor')
    store.addBond(tree.id, me.id, add('Pal').id, 'best_friend')
    expect(store.bondsFor(tree.id, me.id).map((b) => `${b.label} ${b.other.given}`)).toEqual(['Employer Boss', 'Teacher Prof', 'Family doctor Doc', 'Best friend Pal'])
    expect(store.bondsFor(tree.id, boss.id).map((b) => b.label)).toEqual(['Employee'])
    expect(store.bondsFor(tree.id, prof.id).map((b) => b.label)).toEqual(['Student'])
    const copy = store.createTree(user.id, 'Copy')
    importGedcom(store, copy.id, exportGedcom(store, tree.id))
    const me2 = store.people(copy.id).find((p) => p.given === 'Me')!
    expect(store.bondsFor(copy.id, me2.id).map((b) => b.kind)).toEqual(['employer', 'teacher', 'doctor', 'best_friend'])
  })

  test('godparents and guardians, kept out of the bloodline', () => {
    const { store, tree, add, user } = setup()
    const kid = add('Kid')
    const god = add('God')
    store.addBond(tree.id, kid.id, god.id, 'godparent')
    expect(store.bondsFor(tree.id, god.id)[0]!.label).toBe('Godchild')
    expect(store.relationship(tree.id, kid.id, god.id)).toBeNull()
    expect(() => store.addBond(tree.id, kid.id, god.id, 'nemesis')).toThrow(/kind must be/)
    void user
  })

  test('GEDCOM keeps bonds (ASSO/RELA) and leaves pets out', () => {
    const { store, tree, add, user } = setup()
    const kid = add('Kid')
    const gran = add('Gran')
    store.addBond(tree.id, kid.id, gran.id, 'raised_by')
    store.addPet(tree.id, { given: 'Rex', species: 'Dog' }, [kid.id])
    const ged = exportGedcom(store, tree.id)
    expect(ged).toContain('2 RELA Raised by')
    expect(ged).not.toContain('Rex')
    const copy = store.createTree(user.id, 'Copy')
    importGedcom(store, copy.id, ged)
    const kid2 = store.people(copy.id).find((p) => p.given === 'Kid')!
    expect(store.bondsFor(copy.id, kid2.id).map((b) => `${b.label} ${b.other.given}`)).toEqual(['Raised by Gran'])
  })
})

describe('boyfriends and girlfriends', () => {
  test('only a marriage makes an in-law', () => {
    const { store, tree, add, rel, words } = setup()
    const dad = add('Dad', 'M')
    const daughter = rel(dad.id, { as: 'child', given: 'Daughter', sex: 'F' })
    const boyfriend = rel(daughter.id, { as: 'partner', kind: 'dating', given: 'Boyfriend', sex: 'M' })
    expect(store.spouseFamilies(tree.id, daughter.id).find((u) => u.partner?.id === boyfriend.id)!.family.kind).toBe('dating')
    expect(words(dad.id, boyfriend.id)).toBe("daughter's boyfriend")
    expect(words(daughter.id, boyfriend.id)).toBe('boyfriend')
    expect(words(boyfriend.id, daughter.id)).toBe('girlfriend')
    expect(words(boyfriend.id, dad.id)).toBe("girlfriend's father")

    // Partners who never married are partners, not in-laws either.
    const son = rel(dad.id, { as: 'child', given: 'Son', sex: 'M' })
    const partner = rel(son.id, { as: 'partner', kind: 'partners', given: 'Partner', sex: 'F' })
    expect(words(dad.id, partner.id)).toBe("son's partner")

    // When they marry, the words follow.
    const fam = store.spouseFamilies(tree.id, daughter.id).find((u) => u.partner?.id === boyfriend.id)!.family
    store.updateFamily(tree.id, fam.id, { kind: 'married' })
    expect(words(dad.id, boyfriend.id)).toBe('son-in-law')
  })

  test('GEDCOM keeps dating through a round trip', () => {
    const { store, tree, add, rel, user } = setup()
    const her = add('Her', 'F')
    rel(her.id, { as: 'partner', kind: 'dating', given: 'Him', sex: 'M' })
    const ged = exportGedcom(store, tree.id)
    expect(ged).toContain('1 TYPE dating')
    expect(ged).not.toContain('1 MARR')
    const copy = store.createTree(user.id, 'Copy')
    importGedcom(store, copy.id, ged)
    expect(store.families(copy.id).map((f) => f.kind)).toEqual(['dating'])
  })
})

describe('pets', () => {
  test('pets have owners, never parents or partners', () => {
    const { store, tree, add, rel } = setup()
    const me = add('Me')
    const rex = store.addPet(tree.id, { given: 'Rex', species: 'Dog' }, [me.id])
    expect(rex.kind).toBe('pet')
    expect(store.petsOf(tree.id, me.id).map((p) => p.given)).toEqual(['Rex'])
    expect(store.bondsFor(tree.id, rex.id)[0]!.label).toBe('Owner')
    expect(() => rel(me.id, { as: 'child', existing_id: rex.id })).toThrow(/pets/)
    expect(() => rel(rex.id, { as: 'parent', given: 'X' })).toThrow(/pets/)
    expect(store.stats(tree.id)).toMatchObject({ people: 1, pets: 1 })
  })

  test('pets need the Family plan; admins have it free', async () => {
    const w = world({ ADMIN_EMAILS: 'boss@example.com' })
    const free = w.user('free@example.com')
    const boss = w.user('boss@example.com')
    const freeTree = w.store.createTree(free.id, 'Free')
    const me = w.store.addPerson(freeTree.id, { given: 'Me' })
    const res = await w.as(free).post(`/t/${freeTree.id}/p/${me.id}/pets`, { given: 'Rex' })
    expect(res.headers.get('location')).toContain(`/t/${freeTree.id}/plan`)
    expect(w.store.petsOf(freeTree.id, me.id)).toHaveLength(0)

    const bossTree = w.store.createTree(boss.id, 'Boss')
    const b = w.store.addPerson(bossTree.id, { given: 'Boss' })
    const ok = await w.as(boss).post(`/t/${bossTree.id}/p/${b.id}/pets`, { given: 'Rex', species: 'Dog', living: '1' })
    expect(ok.headers.get('location')).toMatch(new RegExp(`/t/${bossTree.id}/p/`))
    expect(w.store.petsOf(bossTree.id, b.id).map((p) => p.species)).toEqual(['Dog'])
    expect(await (await w.as(boss).get(`/t/${bossTree.id}/plan`)).text()).toContain('Included with your admin account')
  })
})

describe('Family plan payment', () => {
  const env = { COINPAY_API_KEY: 'cp_live_x', COINPAY_BUSINESS_ID: 'biz', COINPAY_WEBHOOK_SECRET: 'whsec', COINPAY_API_URL: 'https://coinpay.test/api', FAMILY_PLAN_USD: '49' }
  const sign = (body: string, secret = 'whsec', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`

  const hook = (w: ReturnType<typeof world>, payload: unknown, secret = 'whsec') => {
    const body = JSON.stringify(payload)
    return w.app.request(`${SITE}/webhooks/coinpay`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-coinpay-signature': sign(body, secret) } })
  }
  const event = (type: string, data: Record<string, unknown>) => ({ id: `evt_${type}`, type, business_id: 'biz', data: { payment_id: 'pay_9', amount_usd: 49, ...data } })

  test('checkout opens a CoinPay session for the signed-in buyer, no chain picked', async () => {
    const w = world(env)
    const u = w.user('payer@example.com')
    const tree = w.store.createTree(u.id, 'Fam')
    const page = await (await w.as(u).get(`/t/${tree.id}/plan`)).text()
    expect(page).not.toContain('name="chain"')
    expect(page).not.toContain('name="email"')
    const res = await w.as(u).post(`/t/${tree.id}/plan/checkout`)
    expect(res.headers.get('location')).toBe('https://coinpay.test/checkout/cs_1')
    expect(w.calls[0]!.url).toBe('https://coinpay.test/api/checkout/sessions')
    expect(w.calls[0]!.auth).toBe('Bearer cp_live_x')
    const sent = w.calls[0]!.body
    expect(sent).toMatchObject({ amount: 49, currency: 'USD', customer_email: 'payer@example.com', account_id: u.id, property: 'family.test', success_url: `${SITE}/t/${tree.id}/plan?paid=1`, cancel_url: `${SITE}/t/${tree.id}/plan`, metadata: { tree_id: tree.id, user_id: u.id, product: 'family_plan' } })
    expect(sent.blockchain).toBeUndefined()
    expect(sent.payment_method).toBeUndefined()
    const row = w.store.paymentBySession('cs_1')!
    expect(row).toMatchObject({ tree_id: tree.id, user_id: u.id, status: 'pending', amount_cents: 4900 })
    expect(sent.metadata.payment_ref).toBe(row.ref)
  })

  test('an account without an email is asked for one; the API answers the url', async () => {
    const w = world(env)
    const u = w.user('did123@pit.invalid')
    const tree = w.store.createTree(u.id, 'Fam')
    expect(await (await w.as(u).get(`/t/${tree.id}/plan`)).text()).toContain('name="email"')
    const none = await w.as(u).post(`/t/${tree.id}/plan/checkout`)
    expect(none.headers.get('location')).toContain('email')
    expect(w.calls).toHaveLength(0)
    await w.as(u).post(`/t/${tree.id}/plan/checkout`, { email: 'Me@Example.com' })
    expect(w.calls[0]!.body.customer_email).toBe('me@example.com')

    const api = (body: unknown) => w.app.request(`${SITE}/api/v1/trees/${tree.id}/plan/checkout`, { method: 'POST', headers: { authorization: `Bearer ${w.auth.createToken(u.id, 'test')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await api({})).status).toBe(400)
    const ok = await api({ email: 'me@example.com' })
    expect(ok.status).toBe(201)
    expect(await ok.json()).toMatchObject({ url: 'https://coinpay.test/checkout/cs_2', sessionId: 'cs_2' })
    const info = await (await w.app.request(`${SITE}/api/v1/trees/${tree.id}/plan`, { headers: { authorization: `Bearer ${w.auth.createToken(u.id, 'test')}` } })).json()
    expect(info).toMatchObject({ active: false, payable: true })
    expect(info.chains).toBeUndefined()

  })

  test('the webhook settles by session id: nested, PayPal completed, forwarded, once', async () => {
    const w = world(env)
    const u = w.user('payer@example.com')
    const tree = w.store.createTree(u.id, 'Fam')
    await w.as(u).post(`/t/${tree.id}/plan/checkout`)

    // Not paid: pending, expired.
    expect(await (await hook(w, event('payment.pending', { status: 'pending', checkout_session_id: 'cs_1' }))).json()).toMatchObject({ ok: true, paid: false })
    expect(await (await hook(w, event('payment.expired', { status: 'expired', checkout_session_id: 'cs_1' }))).json()).toMatchObject({ ok: true, paid: false })
    expect(w.store.tree(tree.id)!.plan_paid_at).toBeNull()

    // A bad signature is refused and grants nothing.
    const forged = event('payment.confirmed', { status: 'confirmed', checkout_session_id: 'cs_1' })
    expect((await hook(w, forged, 'wrong')).status).toBe(401)
    expect(w.store.tree(tree.id)!.plan_paid_at).toBeNull()

    // A PayPal capture: payment.confirmed with status completed.
    const paypal = await hook(w, event('payment.confirmed', { status: 'completed', rail: 'paypal', checkout_session_id: 'cs_1', metadata: { tree_id: tree.id } }))
    expect(await paypal.json()).toMatchObject({ ok: true, paid: true, status: 'paid' })
    const paidAt = w.store.tree(tree.id)!.plan_paid_at
    expect(paidAt).toBeNumber()

    // Forwarded after confirmed, and a replay: still paid once, same time.
    expect(await (await hook(w, event('payment.forwarded', { status: 'forwarded', checkout_session_id: 'cs_1' }))).json()).toMatchObject({ paid: true, status: 'paid' })
    expect(await (await hook(w, event('payment.expired', { status: 'expired', checkout_session_id: 'cs_1' }))).json()).toMatchObject({ paid: true, status: 'paid' })
    expect(w.store.tree(tree.id)!.plan_paid_at).toBe(paidAt)
    expect(w.store.paymentsFor(tree.id)).toHaveLength(1)
  })

  test('forwarded alone counts as paid (a lost confirmed is recovered)', async () => {
    const w = world(env)
    const u = w.user('payer@example.com')
    const tree = w.store.createTree(u.id, 'Fam')
    await w.as(u).post(`/t/${tree.id}/plan/checkout`)
    expect(await (await hook(w, event('payment.forwarded', { status: 'forwarded', checkout_session_id: 'cs_1' }))).json()).toMatchObject({ paid: true })
    expect(w.store.tree(tree.id)!.plan_paid_at).toBeNumber()
  })

  test('a session we never started settles nothing, whatever its metadata says', async () => {
    const w = world(env)
    const u = w.user('payer@example.com')
    const other = w.store.createTree(u.id, 'Other')
    const res = await hook(w, event('payment.confirmed', { status: 'confirmed', checkout_session_id: 'cs_x', metadata: { tree_id: other.id, product: 'family_plan' } }))
    expect(await res.json()).toMatchObject({ ignored: 'unknown payment' })
    expect(w.store.tree(other.id)!.plan_paid_at).toBeNull()
  })

  test('older rows keyed by the CoinPay payment id still settle', async () => {
    const w = world(env)
    const u = w.user('payer@example.com')
    const tree = w.store.createTree(u.id, 'Fam')
    w.store.recordPayment({ ref: 'pay_old', tree_id: tree.id, user_id: u.id, amount_cents: 4900, currency: 'USD', chain: 'USDC_POL', raw: null })
    await hook(w, event('payment.confirmed', { payment_id: 'pay_old', status: 'confirmed' }))
    expect(w.store.tree(tree.id)!.plan_paid_at).toBeNumber()
  })

  test('signatures expire', () => {
    const body = '{}'
    expect(verifyWebhook('s', body, sign(body, 's'))).toBe(true)
    expect(verifyWebhook('s', body, sign(body, 's', Math.floor(Date.now() / 1000) - 3600))).toBe(false)
    expect(verifyWebhook('s', body, 't=1,v1=zz')).toBe(false)
  })
})

describe('paste a list, claim yourself', () => {
  test('pulls addresses and names out of whatever is pasted', () => {
    expect(parseInvitees('Karen Ettinger <Karen@Example.com>, "Doe, Jane" <jane@x.com>\nbob@y.org; bob@y.org\nnot an email\n\tLiz\tliz@z.net')).toEqual([
      { email: 'karen@example.com', name: 'Karen Ettinger' },
      { email: 'jane@x.com', name: 'Doe, Jane' },
      { email: 'bob@y.org', name: null },
      { email: 'liz@z.net', name: 'Liz' },
    ])
    expect(parseInvitees('a@x.com b@x.com c@x.com', 2)).toHaveLength(2)
  })

  test('a pasted name lands on that person; others pick themselves; claims need the invited address', async () => {
    const w = world()
    const owner = w.user('owner@example.com')
    const tree = w.store.createTree(owner.id, 'Fam')
    const karen = w.store.addPerson(tree.id, { given: 'Karen', surname: 'Ettinger', living: 1 })
    const res = await w.as(owner).post(`/t/${tree.id}/invites`, { emails: 'Karen Ettinger <karen@example.com>\ncousin@example.com' })
    expect(res.status).toBe(200)
    expect(w.mail.map((m) => m.to)).toEqual(['karen@example.com', 'cousin@example.com'])
    expect(w.mail[0]!.text).toContain('as Karen Ettinger')
    const link = (i: number) => w.mail[i]!.text.match(/(http:\/\/family\.test\/invite\/\S+)/)![1]!.replace(SITE, '')

    // Someone else opening Karen's link joins, but does not become Karen.
    const intruder = w.user('intruder@example.com')
    const joined = await w.as(intruder).post(link(0))
    expect(joined.headers.get('location')).toBe(`/t/${tree.id}/claim?mismatch=1`)
    expect(w.store.profilePerson(tree.id, intruder.id)).toBeNull()

    // The cousin was not tied to anyone: they get "which one is you?" and add themselves.
    const cousin = w.user('cousin@example.com')
    expect((await w.as(cousin).post(link(1))).headers.get('location')).toBe(`/t/${tree.id}/claim`)
    expect(await (await w.as(cousin).get(`/t/${tree.id}/claim`)).text()).toContain('Karen Ettinger')
    const added = await w.as(cousin).post(`/t/${tree.id}/claim`, { given: 'Cousin', surname: 'Doe' })
    const cousinPerson = w.store.profilePerson(tree.id, cousin.id)!
    expect(added.headers.get('location')).toContain(`/t/${tree.id}/p/${cousinPerson}?welcome=1`)
    expect(await (await w.as(cousin).get(`/t/${tree.id}/p/${cousinPerson}?welcome=1`)).text()).toContain('Add your photo')
    // One profile each.
    const again = await w.as(cousin).post(`/t/${tree.id}/claim`, { person_id: karen.id })
    expect(again.headers.get('location')).toContain('already')
  })

  test('the free plan caps a paste at 20; the Family plan at 500', async () => {
    const w = world()
    const owner = w.user('owner@example.com')
    const tree = w.store.createTree(owner.id, 'Fam')
    const list = Array.from({ length: 30 }, (_, i) => `p${i}@example.com`).join('\n')
    await w.as(owner).post(`/t/${tree.id}/invites`, { emails: list })
    expect(w.store.pendingInvites(tree.id)).toHaveLength(20)
    w.store.markPaid(tree.id)
    await w.as(owner).post(`/t/${tree.id}/invites`, { emails: list })
    expect(w.store.pendingInvites(tree.id)).toHaveLength(50)
  })
})
