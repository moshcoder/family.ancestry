import { describe, expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Auth, type Mail } from '../src/auth.ts'
import { createApp } from '../src/server.ts'
import { hasPlan, planFromEnv } from '../src/plan.ts'
import { INVITE_BONUS_DAYS, Rewards } from '../src/rewards.ts'

const SITE = 'http://family.test'
const DAY = 86_400_000

/** One app, many browsers: each has its own cookie jar. */
function world() {
  const store = new Store(':memory:')
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const plan = planFromEnv({ ADMIN_EMAILS: 'boss@example.com' })
  const app = createApp({ store, auth, site: SITE, plan })
  // A second handle on the same tables, the way the redeem-credits CLI mints on the server.
  const admin = new Rewards(store, plan)
  const browser = () => {
    const jar = new Map<string, string>()
    const keep = (res: Response) => {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';')
        const [k, v] = pair!.split('=')
        if (v) jar.set(k!, v)
        else jar.delete(k!)
      }
      return res
    }
    const req = async (path: string, init: RequestInit = {}) => keep(await app.request(`${SITE}${path}`, { ...init, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(init.headers as Record<string, string>) } }))
    const post = async (path: string, fields: Record<string, string> = {}) => {
      if (!jar.has('fa_csrf')) await req('/signin')
      return req(path, { method: 'POST', body: new URLSearchParams({ _csrf: jar.get('fa_csrf') ?? '', ...fields }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    }
    const signIn = async (email: string) => {
      await post('/auth/link', { email })
      const token = mail.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]
      expect((await req(`/auth/verify?token=${token}`)).status).toBe(302)
      return store.userByEmail(email)!
    }
    const flash = (res: Response) => {
      const url = new URL(res.headers.get('location') ?? '/', SITE)
      return { ok: url.searchParams.get('ok'), error: url.searchParams.get('error'), path: url.pathname }
    }
    return { jar, req, post, signIn, flash }
  }
  return { store, app, plan, admin, browser, mail }
}

const mint = (w: ReturnType<typeof world>, amount = 30, max = 1) => w.admin.credits.mint({ grant: { unit: 'plan_days', amount }, maxRedemptions: max, label: 'test' }).then((m) => m.code)

describe('credit codes: Family plan days', () => {
  test('a good code puts the days on your family (the same plan the payment unlocks)', async () => {
    const w = world()
    const b = w.browser()
    const me = await b.signIn('ann@example.com')
    const tree = w.store.createTree(me.id, 'The Ann Family')
    expect(hasPlan(w.plan, w.store, tree)).toBe(false)
    const code = await mint(w, 30)
    const before = Date.now()
    const res = await b.post('/settings/redeem', { code: code.toLowerCase().replace(/-/g, ' '), back: '/settings' })
    const f = b.flash(res)
    expect(f.path).toBe('/settings')
    expect(f.ok).toContain('Added 30 Family plan days.')
    expect(f.ok).toContain('The Ann Family is on the Family plan until')
    const after = w.store.tree(tree.id)!
    expect(after.plan_paid_at).toBeNull()
    expect(after.plan_until!).toBeGreaterThanOrEqual(before + 30 * DAY)
    expect(after.plan_until!).toBeLessThan(before + 31 * DAY)
    expect(hasPlan(w.plan, w.store, after)).toBe(true)
    expect(hasPlan(w.plan, w.store, after, after.plan_until! + 1)).toBe(false)
    expect(w.store.inPaidTree(me.id)).toBe(true)
    expect(await w.admin.days(me.id)).toBe(0)
    // The plan page says until when, and still offers to pay for good.
    const page = await (await b.req(`/t/${tree.id}/plan`)).text()
    expect(page).toContain('On plan days until')
    expect(page).toContain('Have a code?')
    // A second code adds to the end.
    const until = after.plan_until!
    await b.post('/settings/redeem', { code: await mint(w, 10), back: `/t/${tree.id}/plan` })
    expect(w.store.tree(tree.id)!.plan_until).toBe(until + 10 * DAY)
  })

  test('already redeemed, used up, invalid: friendly errors, nothing granted', async () => {
    const w = world()
    const a = w.browser()
    const ann = await a.signIn('ann@example.com')
    w.store.createTree(ann.id, 'Ann')
    const code = await mint(w, 5, 1)
    expect(a.flash(await a.post('/settings/redeem', { code })).ok).toContain('Added 5')
    expect(a.flash(await a.post('/settings/redeem', { code })).error).toBe('You already redeemed that code.')
    const b = w.browser()
    const bob = await b.signIn('bob@example.com')
    expect(b.flash(await b.post('/settings/redeem', { code })).error).toBe('That code has been used.')
    expect(b.flash(await b.post('/settings/redeem', { code: 'CR-0000-0000-0000-0000' })).error).toBe('That code is not valid.')
    expect(await w.admin.days(bob.id)).toBe(0)
  })

  test('with no family yet the days wait, and the first tree takes them', async () => {
    const w = world()
    const b = w.browser()
    const me = await b.signIn('new@example.com')
    expect(b.flash(await b.post('/settings/redeem', { code: await mint(w, 14) })).ok).toContain('Put them on one of your families')
    expect(await w.admin.days(me.id)).toBe(14)
    expect(await (await b.req('/settings')).text()).toContain('<b>14</b> Family plan days waiting')
    const res = await b.post('/trees', { name: 'Mine' })
    const treeId = new URL(res.headers.get('location')!, SITE).pathname.split('/')[2]!
    expect(w.store.tree(treeId)!.plan_until).toBeGreaterThan(Date.now() + 13 * DAY)
    expect(await w.admin.days(me.id)).toBe(0)
  })

  test('two families: you pick; a family paid for good is not offered', async () => {
    const w = world()
    const b = w.browser()
    const me = await b.signIn('two@example.com')
    const one = w.store.createTree(me.id, 'One')
    const two = w.store.createTree(me.id, 'Two')
    const paid = w.store.createTree(me.id, 'Paid')
    w.store.markPaid(paid.id)
    await b.post('/settings/redeem', { code: await mint(w, 7) })
    expect(await w.admin.days(me.id)).toBe(7)
    expect(b.flash(await b.post('/settings/plan-days', { tree: paid.id })).error).toBe('That family is on the Family plan for good already.')
    expect(b.flash(await b.post('/settings/plan-days', { tree: two.id })).ok).toContain('Two is on the Family plan until')
    expect(w.store.tree(one.id)!.plan_until ?? null).toBeNull()
    expect(w.store.tree(two.id)!.plan_until).toBeGreaterThan(Date.now())
  })

  test('the API redeems too', async () => {
    const w = world()
    const b = w.browser()
    const me = await b.signIn('api@example.com')
    const tree = w.store.createTree(me.id, 'Api')
    const token = new Auth(w.store, async () => {}, SITE).createToken(me.id, 'test')
    const call = (path: string, body: unknown) => w.app.request(`${SITE}/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const ok = await call('/redeem', { code: await mint(w, 3), tree: tree.id })
    expect(ok.status).toBe(200)
    expect((await ok.json()).applied.tree_id).toBe(tree.id)
    const bad = await call('/redeem', { code: 'nope' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('That code is not valid.')
    const info = await (await w.app.request(`${SITE}/api/v1/trees/${tree.id}/plan`, { headers: { authorization: `Bearer ${token}` } })).json()
    expect(info.active).toBe(true)
    expect(info.until).toBeNumber()
  })
})

describe('invites and affiliate links', () => {
  test('an invite works once; both people get plan days', async () => {
    const w = world()
    const host = w.browser()
    const inviter = await host.signIn('inviter@example.com')
    const tree = w.store.createTree(inviter.id, 'Inviter family')
    const page = await (await host.post('/invites', { note: 'for Carol' })).text()
    const link = page.match(/value="(http[^"]+\/i\/[^"]+)"/)![1]!
    const code = link.split('/i/')[1]!
    expect(page).toContain('<b>2</b> of 3 invite links left')

    const carol = w.browser()
    expect((await carol.req(`/i/${code}`)).status).toBe(200)
    const newbie = await carol.signIn('carol@example.com')
    expect(await w.admin.days(newbie.id)).toBe(INVITE_BONUS_DAYS)
    // The inviter has one family, so their days went straight onto it.
    expect(w.store.tree(tree.id)!.plan_until).toBeGreaterThan(Date.now() + (INVITE_BONUS_DAYS - 1) * DAY)
    expect(await w.admin.affiliates.invitedBy(newbie.id)).toBe(inviter.id)

    // The same link again: no second bonus for anyone.
    const dave = w.browser()
    await dave.req(`/i/${code}`)
    const d = await dave.signIn('dave@example.com')
    expect(await w.admin.days(d.id)).toBe(0)
    expect(await w.admin.affiliates.invitedBy(d.id)).toBeNull()
    expect(w.store.tree(tree.id)!.plan_until).toBeLessThan(Date.now() + (INVITE_BONUS_DAYS + 1) * DAY)
  })

  test('an existing account signing in through an invite does not spend it', async () => {
    const w = world()
    const host = w.browser()
    const inviter = await host.signIn('inviter@example.com')
    const { code } = await w.admin.affiliates.createInvite(inviter.id)
    const old = w.browser()
    const known = await old.signIn('known@example.com')
    await old.post('/auth/signout')
    await old.req(`/i/${code}`)
    await old.signIn('known@example.com')
    expect(await w.admin.days(known.id)).toBe(0)
    expect((await w.admin.affiliates.invites(inviter.id))[0]!.usedBy).toBeNull()
  })

  test('?ref= records who brought a new account, first touch, new accounts only', async () => {
    const w = world()
    const amy = await w.browser().signIn('amy@example.com')
    const ben = await w.browser().signIn('ben@example.com')
    const amyCode = await w.admin.affiliates.affiliateCode(amy.id)
    const benCode = await w.admin.affiliates.affiliateCode(ben.id)
    const v = w.browser()
    await v.req(`/?ref=${amyCode}`)
    await v.req(`/about?ref=${benCode}`)
    const visitor = await v.signIn('visitor@example.com')
    expect(await w.admin.affiliates.affiliateOf(visitor.id)).toBe(amy.id)
    // An existing account arriving through a link is not counted.
    const again = w.browser()
    await again.req(`/?ref=${benCode}`)
    await again.signIn('amy@example.com')
    expect(await w.admin.affiliates.affiliateOf(amy.id)).toBeNull()
    // The invites page shows each person their own link.
    const page = await (await again.req('/invites')).text()
    expect(page).toContain(`/?ref=${amyCode}`)
  })

  test('the API lists and makes invite links, three each', async () => {
    const w = world()
    const b = w.browser()
    const me = await b.signIn('api@example.com')
    const token = new Auth(w.store, async () => {}, SITE).createToken(me.id, 'test')
    const call = (method: string, body?: unknown) => w.app.request(`${SITE}/api/v1/invites`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    for (let i = 0; i < 3; i++) expect((await call('POST', { note: `n${i}` })).status).toBe(201)
    const over = await call('POST', {})
    expect(over.status).toBe(400)
    expect((await over.json()).error).toBe('You have used all your invite links.')
    const list = await (await call('GET')).json()
    expect(list.quota).toEqual({ total: 3, used: 3, left: 0 })
    expect(list.affiliate_link).toContain('/?ref=')
  })
})
