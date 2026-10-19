import { describe, expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Auth, type Mail } from '../src/auth.ts'
import { createApp } from '../src/server.ts'

const SITE = 'http://family.test'

/** One browser (its own cookie jar) against a shared app. */
function world() {
  const store = new Store(':memory:')
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const app = createApp({ store, auth, site: SITE })
  const browser = () => {
    const jar = new Map<string, string>()
    const req = async (path: string, init: RequestInit = {}) => {
      const res = await app.request(`${SITE}${path}`, { ...init, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(init.headers as Record<string, string>) } })
      for (const c of res.headers.getSetCookie()) {
        const [k, v] = c.split(';')[0]!.split('=')
        if (v) jar.set(k!, v)
        else jar.delete(k!)
      }
      return res
    }
    const post = async (path: string, fields: Record<string, string>) => {
      if (!jar.get('fa_csrf')) await req('/signin')
      return req(path, { method: 'POST', body: new URLSearchParams({ _csrf: jar.get('fa_csrf')!, ...fields }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    }
    const signIn = async (email: string) => {
      await post('/auth/link', { email })
      await req(`/auth/verify?token=${lastToken()}`)
      return store.userByEmail(email)!
    }
    return { req, post, signIn, jar }
  }
  const lastToken = () => mail.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!
  return { store, mail, browser, lastToken }
}

describe('sign-in emails', () => {
  test('Settings adds a second email by a confirm link; then either address signs in to one account', async () => {
    const w = world()
    const laptop = w.browser()
    const me = await laptop.signIn('anthony@work.example')
    const sent = await laptop.post('/settings/emails', { email: 'Anthony@Home.example' })
    expect(sent.headers.get('location')).toContain('settings?ok=')
    expect(w.mail.at(-1)!.to).toBe('anthony@home.example')
    expect(w.mail.at(-1)!.subject).toContain('Add this email')
    const confirmed = await laptop.req(`/auth/verify?token=${w.lastToken()}`)
    expect(decodeURIComponent(confirmed.headers.get('location')!)).toContain('anthony@home.example now signs in to this account')
    expect(w.store.linkedEmails(me.id)).toEqual(['anthony@home.example'])

    const phone = w.browser()
    expect((await phone.signIn('anthony@home.example')).id).toBe(me.id)
    expect(w.store.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 })
    expect(await (await laptop.req('/settings')).text()).toContain('anthony@home.example')
  })

  test('a confirm link opened in a browser not signed in to that account does nothing', async () => {
    const w = world()
    const mine = w.browser()
    const me = await mine.signIn('anthony@work.example')
    await mine.post('/settings/emails', { email: 'victim@example.com' })
    const token = w.lastToken()
    const elsewhere = w.browser()
    const res = await elsewhere.req(`/auth/verify?token=${token}`)
    expect(res.status).toBe(403)
    expect(elsewhere.jar.get('fa_session')).toBeUndefined()
    expect(w.store.linkedEmails(me.id)).toEqual([])
    expect(w.store.userByEmail('victim@example.com')).toBeNull()
  })

  test('signed in, a sign-in link for a new address asks instead of swapping you into an empty account', async () => {
    const w = world()
    const laptop = w.browser()
    const me = await laptop.signIn('anthony@work.example')
    await laptop.post('/auth/link', { email: 'anthony@gmail.example' })
    const token = w.lastToken()
    const asked = await laptop.req(`/auth/verify?token=${token}`)
    expect(asked.status).toBe(200)
    expect(await asked.text()).toContain('Add anthony@gmail.example to your account?')
    expect(w.store.userByEmail('anthony@gmail.example')).toBeNull()

    const added = await laptop.post('/auth/verify', { token, choice: 'add' })
    expect(added.headers.get('location')).toContain('/settings?ok=')
    expect(w.store.userByEmail('anthony@gmail.example')!.id).toBe(me.id)
    // The link is used up.
    expect((await laptop.post('/auth/verify', { token, choice: 'add' })).status).toBe(400)
  })

  test('on a shared device the other person can make their own account instead', async () => {
    const w = world()
    const laptop = w.browser()
    const me = await laptop.signIn('anthony@work.example')
    await laptop.post('/auth/link', { email: 'karen@example.com' })
    const token = w.lastToken()
    await laptop.req(`/auth/verify?token=${token}`)
    const res = await laptop.post('/auth/verify', { token, choice: 'new' })
    expect(res.headers.get('location')).toBe('/trees')
    const karen = w.store.userByEmail('karen@example.com')!
    expect(karen.id).not.toBe(me.id)
    expect(w.store.linkedEmails(me.id)).toEqual([])
  })

  test('an address that already has its own account is not taken over', async () => {
    const w = world()
    await w.browser().signIn('karen@example.com')
    const laptop = w.browser()
    const me = await laptop.signIn('anthony@work.example')
    await laptop.post('/settings/emails', { email: 'karen@example.com' })
    const res = await laptop.req(`/auth/verify?token=${w.lastToken()}`)
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('already signs in to another')
    expect(w.store.linkedEmails(me.id)).toEqual([])
  })

  test('a removed email stops signing in to the account', async () => {
    const w = world()
    const laptop = w.browser()
    const me = await laptop.signIn('anthony@work.example')
    w.store.linkEmail(me.id, 'old@example.com')
    await laptop.post('/settings/emails/remove', { email: 'old@example.com' })
    expect(w.store.linkedEmails(me.id)).toEqual([])
    expect(w.store.userByEmail('old@example.com')).toBeNull()
  })

  test('an account made by pit.world takes its first real email as its own', () => {
    const store = new Store(':memory:')
    const bridged = store.createBridgedUser('pitworld', 'did:key:z6MkTest', 'Anthony')
    expect(store.attachEmail(bridged.id, 'anthony@example.com')).toBe('added')
    expect(store.user(bridged.id)!.email).toBe('anthony@example.com')
    expect(store.attachEmail(bridged.id, 'second@example.com')).toBe('added')
    expect(store.linkedEmails(bridged.id)).toEqual(['second@example.com'])
  })
})
