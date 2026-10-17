import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { Store } from '../src/db.ts'
import { Auth, type Mail } from '../src/auth.ts'
import { createApp } from '../src/server.ts'
import { SAMPLE_GED } from './fixtures.ts'

const SITE = 'http://family.test'

function harness() {
  const store = new Store(':memory:')
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const app = createApp({ store, auth, site: SITE })
  const jar = new Map<string, string>()
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [k, v] = pair!.split('=')
      if (v) jar.set(k!, v)
      else jar.delete(k!)
    }
    return res
  }
  const req = async (path: string, init: RequestInit = {}) => keep(await app.request(`${SITE}${path}`, { ...init, headers: { cookie: cookie(), ...(init.headers as Record<string, string>) } }))
  const formPost = (path: string, fields: Record<string, string>) => req(path, { method: 'POST', body: new URLSearchParams({ _csrf: jar.get('fa_csrf') ?? '', ...fields }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  const signIn = async (email: string) => {
    await req('/signin')
    await formPost('/auth/link', { email })
    const token = mail.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]
    const res = await req(`/auth/verify?token=${token}`)
    expect(res.status).toBe(302)
    return store.userByEmail(email)!
  }
  return { store, auth, app, mail, req, formPost, signIn, jar }
}

describe('server', () => {
  test('health and home', async () => {
    const h = harness()
    expect(await (await h.req('/health')).json()).toMatchObject({ ok: true })
    const home = await h.req('/')
    expect(home.status).toBe(200)
    expect(home.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await home.text()).toContain('Email me a link')
  })

  test('magic link signs in, makes the account, and works once', async () => {
    const h = harness()
    await h.req('/signin')
    const res = await h.formPost('/auth/link', { email: 'New@Example.com', next: '/trees' })
    expect(await res.text()).toContain('If that address can receive mail')
    expect(h.mail).toHaveLength(1)
    const token = h.mail[0]!.text.match(/token=([A-Za-z0-9_-]+)/)![1]
    const ok = await h.req(`/auth/verify?token=${token}`)
    expect(ok.headers.get('location')).toBe('/trees')
    expect(h.store.userByEmail('new@example.com')).not.toBeNull()
    expect((await h.req('/trees')).status).toBe(200)
    expect((await h.req(`/auth/verify?token=${token}`)).status).toBe(400)
  })

  test('a link never redirects off-site', async () => {
    const h = harness()
    await h.req('/signin')
    await h.formPost('/auth/link', { email: 'a@example.com', next: '//evil.example' })
    const token = h.mail[0]!.text.match(/token=([A-Za-z0-9_-]+)/)![1]
    expect((await h.req(`/auth/verify?token=${token}`)).headers.get('location')).toBe('/trees')
  })

  test('forms without the CSRF token, or from another site, are refused', async () => {
    const h = harness()
    await h.signIn('a@example.com')
    const noToken = await h.req('/trees', { method: 'POST', body: new URLSearchParams({ name: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(noToken.status).toBe(403)
    const crossSite = await h.req('/trees', { method: 'POST', body: new URLSearchParams({ name: 'x', _csrf: h.jar.get('fa_csrf')! }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' } })
    expect(crossSite.status).toBe(403)
    expect(h.store.treesFor(h.store.userByEmail('a@example.com')!.id)).toHaveLength(0)
  })

  test('build a tree in the browser, and strangers cannot see it', async () => {
    const h = harness()
    const owner = await h.signIn('owner@example.com')
    const made = await h.formPost('/trees', { name: 'Ettinger family' })
    const treeUrl = made.headers.get('location')!
    const treeId = treeUrl.split('/').pop()!
    const add = await h.formPost(`${treeUrl}/people`, { given: 'Johann', surname: 'Ettinger', sex: 'M', birth_date: '1871' })
    const personUrl = add.headers.get('location')!.split('?')[0]!
    expect(personUrl).toMatch(/\/p\//)
    await h.formPost(`${personUrl}/relative`, { as: 'child', given: 'Karl', surname: 'Ettinger', relation: 'birth' })
    const page = await (await h.req(personUrl)).text()
    expect(page).toContain('Karl Ettinger')
    expect((await h.req(`/t/${treeId}/pedigree/${personUrl.split('/').pop()}`)).status).toBe(200)
    expect(await (await h.req(`/t/${treeId}/export.ged`)).text()).toContain('1 NAME Johann /Ettinger/')

    const s = harness()
    // Same store, different browser.
    const other = { ...s, store: h.store }
    const app2 = createApp({ store: h.store, auth: new Auth(h.store, async (m) => void s.mail.push(m), SITE), site: SITE })
    const stranger = h.store.findOrCreateUser('stranger@example.com')
    const auth2 = new Auth(h.store, async () => {}, SITE)
    const session = auth2.createSession(stranger.id)
    const res = await app2.request(`${SITE}/t/${treeId}`, { headers: { cookie: `fa_session=${session}` } })
    expect(res.status).toBe(404)
    expect(other.store.role(treeId, owner.id)).toBe('owner')
  })

  test('invite link lets family in as a viewer, who cannot edit', async () => {
    const h = harness()
    await h.signIn('owner@example.com')
    const treeId = (await h.formPost('/trees', { name: 'Fam' })).headers.get('location')!.split('/').pop()!
    const invitePage = await (await h.formPost(`/t/${treeId}/invites`, { role: 'viewer', email: 'cousin@example.com' })).text()
    const inviteUrl = invitePage.match(/value="(http:\/\/family\.test\/invite\/[^"]+)"/)![1]!
    expect(h.mail.at(-1)!.to).toBe('cousin@example.com')

    const c = harness()
    const cousinStore = h.store
    const cousin = cousinStore.findOrCreateUser('cousin@example.com')
    const session = new Auth(cousinStore, async () => {}, SITE).createSession(cousin.id)
    const app = createApp({ store: cousinStore, auth: new Auth(cousinStore, async () => {}, SITE), site: SITE })
    const get = await app.request(inviteUrl, { headers: { cookie: `fa_session=${session}` } })
    const csrf = get.headers.getSetCookie().find((x) => x.startsWith('fa_csrf='))!.split(';')[0]!.split('=')[1]!
    const join = await app.request(inviteUrl, { method: 'POST', headers: { cookie: `fa_session=${session}; fa_csrf=${csrf}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf }) })
    expect(join.status).toBe(302)
    expect(cousinStore.role(treeId, cousin.id)).toBe('viewer')
    const edit = await app.request(`${SITE}/t/${treeId}/people`, { method: 'POST', headers: { cookie: `fa_session=${session}; fa_csrf=${csrf}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, given: 'X' }) })
    expect(edit.status).toBe(403)
    void c
  })

  test('CLI sign-in: authorization code + PKCE, then the API works with the token', async () => {
    const h = harness()
    await h.signIn('cli@example.com')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const redirect = 'http://127.0.0.1:54321/callback'
    expect((await h.req(`/cli/authorize?code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirect)}&state=s1`)).status).toBe(200)
    expect((await h.req(`/cli/authorize?code_challenge=${challenge}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`)).status).toBe(400)
    const allowed = await h.formPost('/cli/authorize', { code_challenge: challenge, redirect_uri: redirect, state: 's1', label: 'test' })
    const loc = new URL(allowed.headers.get('location')!)
    expect(loc.origin).toBe('http://127.0.0.1:54321')
    expect(loc.searchParams.get('state')).toBe('s1')
    const code = loc.searchParams.get('code')!
    const wrong = await h.app.request(`${SITE}/api/v1/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: 'nope'.repeat(12), redirect_uri: redirect }) })
    expect(wrong.status).toBe(400)
    // The code was burned by the failed attempt: a stolen code cannot be retried.
    const allowed2 = await h.formPost('/cli/authorize', { code_challenge: challenge, redirect_uri: redirect, state: 's2' })
    const code2 = new URL(allowed2.headers.get('location')!).searchParams.get('code')!
    const ok = await h.app.request(`${SITE}/api/v1/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code2, code_verifier: verifier, redirect_uri: redirect }) })
    const { access_token } = (await ok.json()) as any
    expect(access_token).toMatch(/^fa_/)

    const api = (path: string, init: RequestInit = {}) => h.app.request(`${SITE}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } })
    const tree = ((await (await api('/trees', { method: 'POST', body: JSON.stringify({ name: 'API tree' }) })).json()) as any).tree
    const imported = ((await (await api(`/trees/${tree.id}/import`, { method: 'POST', body: SAMPLE_GED, headers: { 'content-type': 'text/plain' } })).json()) as any).imported
    expect(imported.people).toBe(6)
    const people = ((await (await api(`/trees/${tree.id}/people?q=robert`)).json()) as any).people
    expect(people).toHaveLength(1)
    const ped = ((await (await api(`/trees/${tree.id}/pedigree/${people[0].id}?generations=3`)).json()) as any).ancestors
    expect(ped.find((a: any) => a.n === 4).name).toBe('Johann Ettinger')
    const johann = ped.find((a: any) => a.n === 4)
    const rel = (await (await api(`/trees/${tree.id}/relate?a=${people[0].id}&b=${johann.id}`)).json()) as any
    expect(rel.relationship).toBe('grandfather')
    const child = ((await (await api(`/trees/${tree.id}/people`, { method: 'POST', body: JSON.stringify({ given: 'Newborn', relative_of: people[0].id, as: 'child', living: true }) })).json()) as any).person
    expect(child.parents[0].parents[0].name).toBe('Robert Ettinger')
    expect((await h.app.request(`${SITE}/api/v1/trees`)).status).toBe(401)
  })

  test('photo upload accepts images only', async () => {
    const h = harness()
    await h.signIn('p@example.com')
    const treeUrl = (await h.formPost('/trees', { name: 'Pics' })).headers.get('location')!
    const personUrl = (await h.formPost(`${treeUrl}/people`, { given: 'Pic' })).headers.get('location')!.split('?')[0]!
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const fd = new FormData()
    fd.set('_csrf', h.jar.get('fa_csrf')!)
    fd.set('file', new File([png], 'p.png', { type: 'image/png' }))
    await h.req(`${personUrl}/media`, { method: 'POST', body: fd })
    const treeId = treeUrl.split('/').pop()!
    const person = h.store.people(treeId)[0]!
    expect(person.photo_id).not.toBeNull()
    const img = await h.req(`/t/${treeId}/media/${person.photo_id}`)
    expect(img.headers.get('content-type')).toBe('image/png')
    const bad = new FormData()
    bad.set('_csrf', h.jar.get('fa_csrf')!)
    bad.set('file', new File(['<script>'], 'x.html', { type: 'text/html' }))
    await h.req(`${personUrl}/media`, { method: 'POST', body: bad })
    expect(h.store.mediaFor(treeId, person.id)).toHaveLength(1)
  })
})

describe('pit.world verification', () => {
  test('PIT_VERIFY puts the meta tag on the homepage only, and only hex', async () => {
    const before = process.env.PIT_VERIFY
    process.env.PIT_VERIFY = 'c1fa41c17a1de9fb50b21164203d6df3'
    try {
      const h = harness()
      expect(await (await h.req('/')).text()).toContain('<meta name="pit-verify" content="c1fa41c17a1de9fb50b21164203d6df3">')
      expect(await (await h.req('/about')).text()).not.toContain('pit-verify')
      process.env.PIT_VERIFY = '"><script>'
      expect(await (await h.req('/')).text()).not.toContain('pit-verify')
    } finally {
      if (before === undefined) delete process.env.PIT_VERIFY
      else process.env.PIT_VERIFY = before
    }
  })
})
