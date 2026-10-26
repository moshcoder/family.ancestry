import { describe, expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Auth, type Mail } from '../src/auth.ts'
import { createApp } from '../src/server.ts'

/**
 * The shared @profullstack/profile fields: asked for on /signup only, carried on
 * the magic link (the account exists only once it is spent), saved on verify, and
 * served at /api/v1/me/profile and on Settings.
 */
const SITE = 'http://family.test'

function world() {
  const store = new Store(':memory:')
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const app = createApp({ store, auth, site: SITE })
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
  const lastToken = () => mail.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!
  return { store, mail, req, post, lastToken }
}

describe('signup profile', () => {
  test('/signup asks for the fields, /signin does not', async () => {
    const w = world()
    const signup = await (await w.req('/signup')).text()
    for (const name of ['first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url']) expect(signup).toContain(`name="${name}"`)
    expect(signup.match(/name="email"/g)?.length).toBe(1)
    expect(await (await w.req('/signin')).text()).not.toContain('name="first_name"')
    expect((await w.req('/vendor-profile.js')).headers.get('content-type')).toContain('javascript')
  })

  test('a signup with the fields stores them once the link is spent', async () => {
    const w = world()
    const bad = await w.post('/auth/link', { mode: 'signup', email: 'ada@acme.example', first_name: 'Ada' })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('value="Ada"')
    expect(w.mail).toHaveLength(0)

    await w.post('/auth/link', { mode: 'signup', email: 'Ada@Acme.example', first_name: 'Ada', last_name: 'Lovelace', company_domain: 'https://www.acme.example/about', job_title: 'CTO', linkedin_url: 'in/ada-lovelace' })
    expect(w.store.userByEmail('ada@acme.example')).toBeNull()
    await w.req(`/auth/verify?token=${w.lastToken()}`)
    expect(w.store.userByEmail('ada@acme.example')).not.toBeNull()
    const res = await w.req('/api/v1/me/profile')
    expect(res.status).toBe(200)
    expect((await res.json()).profile).toMatchObject({ email: 'ada@acme.example', first_name: 'Ada', last_name: 'Lovelace', company_domain: 'acme.example', job_title: 'CTO', linkedin_url: 'https://www.linkedin.com/in/ada-lovelace' })

    // Settings edits the same row.
    const saved = await w.post('/settings/details', { first_name: 'Ada', last_name: 'King', job_title: 'Countess' })
    expect(saved.headers.get('location')).toBe('/settings?ok=Details%20saved#details')
    expect(await (await w.req('/settings')).text()).toContain('value="King"')
  })

  test('plain sign-in stores nothing and the API needs a session', async () => {
    const w = world()
    expect((await w.req('/api/v1/me/profile')).status).toBe(401)
    await w.post('/auth/link', { email: 'plain@example.com' })
    await w.req(`/auth/verify?token=${w.lastToken()}`)
    expect((await (await w.req('/api/v1/me/profile')).json()).profile?.first_name ?? null).toBeNull()
  })
})
