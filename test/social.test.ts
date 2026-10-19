import { describe, expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'
import { Network } from '../src/network.ts'
import { accountUrl, fillCounts, fromMyna } from '../src/social-import.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

function world() {
  const store = new Store(':memory:')
  const auth = new Auth(store, async () => {}, SITE)
  const app = createApp({ store, auth, site: SITE, net: new Network(store) })
  const browser = (cookie: string) => ({
    get: (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } }),
    post: (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
  })
  const as = (user: User) => browser(`fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`)
  const stranger = () => browser(`fa_csrf=${CSRF}`)
  const user = (email: string, name: string) => {
    const u = store.findOrCreateUser(email)
    store.setUserName(u.id, name)
    return store.user(u.id)!
  }
  const bearer = (user: User) => {
    const token = auth.createToken(user.id, 'test')
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    return {
      get: (path: string) => app.request(`${SITE}/api/v1${path}`, { headers: h }),
      post: (path: string, body: unknown) => app.request(`${SITE}/api/v1${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) }),
    }
  }
  return { store, app, as, stranger, user, bearer }
}

const HISTORY = {
  entries: [
    { at: '2026-10-18T10:00:00.000Z', accountId: 'bluesky:tony.bsky.social', network: 'bluesky', text: 'Hello from Bluesky', ok: true, postId: 'at://did:plc:x/app.bsky.feed.post/aaa|cid1', url: 'https://bsky.app/profile/tony.bsky.social/post/aaa' },
    { at: '2026-10-19T10:00:00.000Z', accountId: 'mastodon:tony@defcon.social', network: 'mastodon', text: 'Toot toot', ok: true, postId: '1170', url: 'https://defcon.social/@tony/1170' },
    { at: '2026-10-19T11:00:00.000Z', accountId: 'linkedin:Tony E', network: 'linkedin', text: 'A LinkedIn post', ok: true, postId: 'urn:li:share:1', url: 'https://www.linkedin.com/feed/update/urn:li:share:1' },
    { at: '2026-10-19T12:00:00.000Z', accountId: 'devto:tony', network: 'devto', text: 'body', title: 'My article', ok: true, postId: '4614195', url: 'https://dev.to/tony/my-article-1gok' },
    { at: '2026-10-19T13:00:00.000Z', accountId: 'devto:tony', network: 'devto', text: 'failed one', ok: false },
    { at: '2026-10-19T14:00:00.000Z', accountId: 'titled-test:member', network: 'titled-test', text: 'test', ok: true, postId: '1', url: 'https://example.com/t/1' },
  ],
}

describe('socials', () => {
  test('myna history: sent posts with a real URL, account pages worked out', () => {
    const posts = fromMyna(HISTORY)
    expect(posts.map((p) => p.account)).toEqual(['devto:tony', 'linkedin:Tony E', 'mastodon:tony@defcon.social', 'bluesky:tony.bsky.social'])
    expect(posts[0]!.text).toBe('My article\n\nbody')
    expect(accountUrl('mastodon:tony@defcon.social', 'https://defcon.social/@tony/1')).toBe('https://defcon.social/@tony')
    expect(accountUrl('bluesky:tony.bsky.social', 'https://bsky.app/x')).toBe('https://bsky.app/profile/tony.bsky.social')
    expect(accountUrl('htmlblog:dev.example.org/~a/blog', 'https://dev.example.org/~a/blog/1.html')).toBe('https://dev.example.org/~a/blog/')
    expect(accountUrl('tsbb:member@bbs.hqtui.com', 'https://bbs.hqtui.com/t/x-91')).toBe('https://bbs.hqtui.com/')
    expect(accountUrl('linkedin:Tony E', 'https://www.linkedin.com/feed/update/1')).toBeNull()
    expect(fromMyna(HISTORY, { skip: ['linkedin:Tony E'] }).length).toBe(3)
  })

  test('counts come from each network public API', async () => {
    const posts = fromMyna(HISTORY)
    const seen: string[] = []
    const fake = (async (url: string) => {
      seen.push(url)
      if (url.startsWith('https://public.api.bsky.app/')) return Response.json({ posts: [{ uri: 'at://did:plc:x/app.bsky.feed.post/aaa', likeCount: 5, repostCount: 2, quoteCount: 1, replyCount: 3 }] })
      if (url.startsWith('https://defcon.social/api/v1/statuses/1170')) return Response.json({ favourites_count: 4, reblogs_count: 1, replies_count: 0 })
      if (url === 'https://dev.to/api/articles/4614195') return Response.json({ public_reactions_count: 7, comments_count: 2 })
      return new Response('no', { status: 404 })
    }) as unknown as typeof fetch
    expect(await fillCounts(posts, { fetchImpl: fake })).toBe(3)
    const by = Object.fromEntries(posts.map((p) => [p.network, p]))
    expect([by.bluesky!.likes, by.bluesky!.reposts, by.bluesky!.replies]).toEqual([5, 3, 3])
    expect([by.mastodon!.likes, by.mastodon!.reposts]).toEqual([4, 1])
    expect([by.devto!.likes, by.devto!.replies]).toEqual([7, 2])
    expect(by.linkedin!.likes).toBeUndefined()
    expect(seen.some((u) => u.includes('linkedin'))).toBe(false)
  })

  test('API saves posts, keeps counts it is not given, and the public profile shows them', async () => {
    const w = world()
    const tony = w.user('tony@example.com', 'Anthony Ettinger')
    const api = w.bearer(tony)
    await api.post('/profile', { slug: 'anthony.ettinger', name: 'Anthony Ettinger', published: true })
    const posts = fromMyna(HISTORY).map(({ postId: _p, ...p }) => p)
    posts[3] = { ...posts[3]!, likes: 5, reposts: 2, replies: 1 }
    let r = await (await api.post('/social/posts', { posts })).json()
    expect(r).toEqual({ saved: 4, skipped: 0 })
    // A second send without numbers keeps them.
    r = await (await api.post('/social/posts', { posts: [{ ...posts[3], likes: undefined, reposts: undefined, replies: undefined, text: 'Hello again' }, { url: 'javascript:alert(1)', network: 'x', account: 'x:y', text: 'bad', posted_at: '2026-10-19' }] })).json()
    expect(r).toEqual({ saved: 1, skipped: 1 })
    const mine = await (await api.get('/social')).json()
    expect(mine.accounts.length).toBe(4)
    const sky = mine.posts.find((p: any) => p.network === 'bluesky')
    expect([sky.text, sky.likes, sky.reposts, sky.replies]).toEqual(['Hello again', 5, 2, 1])

    // Anyone, signed in or not, sees them on the public profile.
    const page = await (await w.stranger().get('/profile/anthony.ettinger')).text()
    expect(page).toContain('On their socials')
    expect(page).toContain('Toot toot')
    expect(page).toContain('href="https://defcon.social/@tony"')
    expect(page).toContain('5 likes · 2 reposts · 1 reply')

    // Hiding an account takes it off the profile, not off /socials.
    await api.post('/social/accounts/hide', { account: 'mastodon:tony@defcon.social' })
    const after = await (await w.stranger().get('/profile/anthony.ettinger')).text()
    expect(after).not.toContain('Toot toot')
    const dash = await (await w.as(tony).get('/socials')).text()
    expect(dash).toContain('Toot toot')
    expect(dash).toContain('Hidden')

    const removed = await (await api.post('/social/posts/remove', { account: 'linkedin:Tony E' })).json()
    expect(removed.removed).toBe(1)
  })

  test('/socials is yours alone; an unpublished profile shows nothing', async () => {
    const w = world()
    const tony = w.user('tony@example.com', 'Anthony Ettinger')
    const other = w.user('sam@example.com', 'Sam Smith')
    await w.bearer(tony).post('/social/posts', { posts: [{ url: 'https://bsky.app/profile/t/post/1', network: 'bluesky', account: 'bluesky:t', text: 'only mine', posted_at: '2026-10-19T00:00:00Z' }] })
    expect((await w.stranger().get('/socials')).status).toBe(302)
    expect(await (await w.as(other).get('/socials')).text()).not.toContain('only mine')
    expect((await (await w.bearer(other).get('/social')).json()).posts).toEqual([])
    await w.bearer(tony).post('/profile', { slug: 'tony.e', name: 'Anthony Ettinger', published: false })
    expect((await w.stranger().get('/profile/tony.e')).status).toBe(404)
  })
})
