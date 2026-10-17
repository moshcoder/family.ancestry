import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { createBridgeHost } from '@profullstack/bridges'
import { Store } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'

const SITE = 'https://family.ancestry'
const PUBLIC = 'https://family.ancestry.pit.world'
const HOST = 'family.ancestry.pit.world'
const CSRF = 'testcsrftoken0123456789'
const secret = createHmac('sha256', 'pit-bridge-key-for-tests-0123456789').update(HOST).digest('base64url')

/** family.ancestry with pit.world's bridge host in-process; `who` is whoever is signed in on pit.world. */
function world() {
  const store = new Store(':memory:')
  const mail: { to: string; text: string }[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  let who: { sub: string; name: string } | null = null
  const pit = createBridgeHost({ clients: { [HOST]: { secret, redirectUris: [`${PUBLIC}/auth/bridge/callback`] } }, getUser: async () => who, loginUrl: (r) => `https://pit.world/signin?next=${encodeURIComponent(r)}` })
  const pitFetch = ((input: any, init: any) => pit.token(new Request(String(input), init))) as typeof fetch
  const app = createApp({ store, auth, site: SITE, publicSite: PUBLIC, pitWorld: { secret, fetch: pitFetch } })
  /** One trip: our /auth/pitworld, pit.world's authorize, our callback. Returns the session cookie set, if any. */
  const signInViaPit = async (cookie = '', next = '/trees') => {
    const start = await app.request(`${SITE}/auth/pitworld?next=${encodeURIComponent(next)}`, { headers: { cookie, 'x-forwarded-host': HOST } })
    const state = /fa_pw_state=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')![1]!
    const answered = await pit.authorize(new Request(start.headers.get('location')!))
    const callback = new URL(answered.headers.get('location')!)
    const done = await app.request(`${SITE}${callback.pathname}${callback.search}`, { headers: { cookie: `${cookie}; fa_pw_state=${state}` } })
    const set = done.headers.getSetCookie().join('\n')
    const session = /fa_session=([^;]+)/.exec(set)?.[1]
    const pending = /fa_pw_pending=([^;]+)/.exec(set)?.[1]
    return { done, cookie: session ? `fa_session=${session}; fa_csrf=${CSRF}` : cookie, pending: pending ? `fa_pw_pending=${pending}; fa_csrf=${CSRF}` : null }
  }
  return { store, auth, app, mail, signInViaPit, as: (u: { sub: string; name: string } | null) => (who = u) }
}

describe('sign in with pit.world', () => {
  test('a pit.world account gets its own family.ancestry account, linked by its DID, once', async () => {
    const w = world()
    w.as({ sub: 'did:key:z6MkKurt', name: 'Kurt' })
    const asked = await w.signInViaPit()
    // Not linked: ask, never make an account on our own.
    expect(await asked.done.text()).toContain('Already have an account here?')
    expect(w.store.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
    const made = await w.app.request(`${SITE}/auth/pitworld/new`, { method: 'POST', headers: { cookie: asked.pending!, 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, body: new URLSearchParams({ _csrf: CSRF }) })
    expect(made.headers.get('location')).toBe('/trees')
    const first = { cookie: `fa_session=${/fa_session=([^;]+)/.exec(made.headers.getSetCookie().join('\n'))![1]}; fa_csrf=${CSRF}` }
    const user = w.store.userByIdentity('pitworld', 'did:key:z6MkKurt')!
    expect(user).toMatchObject({ name: 'Kurt' })
    expect(user.email).toEndWith('@pit.invalid')
    await w.signInViaPit()
    expect(w.store.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 })
    const settings = await (await w.app.request(`${SITE}/settings`, { headers: { cookie: first.cookie } })).text()
    expect(settings).toContain('Linked: you can sign in here with pit.world')
    expect(settings).not.toContain('@pit.invalid')
  })

  test('signed in already: pit.world links to this account, never by email', async () => {
    const w = world()
    const karen = w.store.findOrCreateUser('karen@example.com')
    const cookie = `fa_session=${w.auth.createSession(karen.id)}; fa_csrf=${CSRF}`
    w.as({ sub: 'did:key:z6MkKaren', name: 'Karen' })
    const linked = await w.signInViaPit(cookie)
    expect(linked.done.headers.get('location')).toBe('/settings?ok=pit.world%20linked')
    expect(w.store.userByIdentity('pitworld', 'did:key:z6MkKaren')?.id).toBe(karen.id)
    // The same DID, later, signed out: lands in Karen's account.
    const again = await w.signInViaPit()
    expect(again.cookie).toContain('fa_session=')
    expect(w.store.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 })
    // Someone else's pit.world account cannot take over hers.
    const other = w.store.findOrCreateUser('other@example.com')
    const otherCookie = `fa_session=${w.auth.createSession(other.id)}; fa_csrf=${CSRF}`
    const refused = await w.signInViaPit(otherCookie)
    expect(decodeURIComponent(refused.done.headers.get('location')!)).toContain('already linked to another')
  })

  test('an existing email account signs in once by email and pit.world links to it: no empty duplicate', async () => {
    const w = world()
    const anthony = w.store.findOrCreateUser('anthony@example.com')
    const tree = w.store.createTree(anthony.id, 'The Ettinger Family')
    w.as({ sub: 'did:key:z6MkAnthony', name: 'Anthony Ettinger' })
    const asked = await w.signInViaPit()
    expect(await asked.done.text()).toContain('Already have an account here?')
    // He signs in with his email link in the same browser.
    const link = await w.app.request(`${SITE}/auth/link`, { method: 'POST', headers: { cookie: asked.pending!, 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, body: new URLSearchParams({ _csrf: CSRF, email: 'anthony@example.com' }) })
    expect(link.status).toBe(200)
    const raw = w.mail.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!
    const verified = await w.app.request(`${SITE}/auth/verify?token=${raw}`, { headers: { cookie: asked.pending! } })
    expect(verified.headers.getSetCookie().join('\n')).toContain('fa_session=')
    expect(w.store.userByIdentity('pitworld', 'did:key:z6MkAnthony')?.id).toBe(anthony.id)
    expect(w.store.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 })
    // Next time pit.world goes straight to his trees.
    const again = await w.signInViaPit()
    expect(again.done.headers.get('location')).toBe('/trees')
    expect(w.store.treesFor(anthony.id).map((t) => t.id)).toEqual([tree.id])
  })

  test('Moshpit visitors are sent to the relay host first, and a bad callback signs nobody in', async () => {
    const w = world()
    const native = await w.app.request(`${SITE}/auth/pitworld?next=/trees`)
    expect(native.headers.get('location')).toBe(`${PUBLIC}/auth/pitworld?next=%2Ftrees`)
    const forged = await w.app.request(`${SITE}/auth/bridge/callback?code=x&state=y`, { headers: { cookie: 'fa_pw_state=nope' } })
    expect(forged.status).toBe(400)
    expect(forged.headers.get('set-cookie') ?? '').not.toContain('fa_session=')
    expect(await (await w.app.request(`${SITE}/signin`)).text()).toContain('Sign in with pit.world')
  })
})
