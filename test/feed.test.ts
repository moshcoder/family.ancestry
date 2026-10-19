import { expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { Network } from '../src/network.ts'
import { Feed } from '../src/feed.ts'
import { createApp } from '../src/server.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

function world() {
  const store = new Store(':memory:')
  const auth = new Auth(store, async () => {}, SITE)
  const net = new Network(store)
  const feed = new Feed(store, net)
  const app = createApp({ store, auth, site: SITE, net })
  const user = (email: string, name: string) => {
    const u = store.findOrCreateUser(email)
    store.setUserName(u.id, name)
    return store.user(u.id)!
  }
  const as = (u: User) => {
    const cookie = `fa_session=${auth.createSession(u.id)}; fa_csrf=${CSRF}`
    return {
      get: (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } }),
      post: (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
    }
  }
  return { store, auth, net, feed, app, user, as }
}

test('posts reach the people who know you, and nobody else', () => {
  const { store, feed, user } = world()
  const anthony = user('a@example.com', 'Anthony')
  const karen = user('k@example.com', 'Karen')
  const kurt = user('kurt@example.com', 'Kurt')
  const stranger = user('s@example.com', 'Stranger')
  const ettinger = store.createTree(anthony.id, 'Ettinger')
  store.setMember(ettinger.id, karen.id, 'viewer')
  const rademacher = store.createTree(karen.id, 'Rademacher')
  store.setMember(rademacher.id, kurt.id, 'viewer')

  const hello = feed.post(anthony.id, { body: 'We made it to the lake' })
  const famOnly = feed.post(karen.id, { body: 'Rademacher reunion is Saturday', audience: rademacher.id })

  // Strangers can neither subscribe nor read.
  expect(() => feed.subscribe(stranger.id, anthony.id)).toThrow('connected with or share a tree')
  expect(feed.of(stranger.id, anthony.id)).toHaveLength(0)
  expect(feed.item(stranger.id, hello.id)).toBeNull()

  // Karen knows Anthony: subscribe, read, like, comment.
  feed.subscribe(karen.id, anthony.id)
  expect(feed.home(karen.id).map((p) => p.body)).toEqual(['Rademacher reunion is Saturday', 'We made it to the lake'])
  expect(feed.toggleLike(karen.id, hello.id)).toBe(true)
  feed.comment(karen.id, hello.id, 'Beautiful!')
  const seen = feed.item(anthony.id, hello.id)!
  expect(seen.likes).toBe(1)
  expect(seen.comments[0]!.body).toBe('Beautiful!')

  // A family-only post: Kurt (in Rademacher) sees it, Anthony (who knows Karen, but not in that tree) does not.
  feed.subscribe(anthony.id, karen.id)
  expect(feed.home(anthony.id).some((p) => p.id === famOnly.id)).toBe(false)
  expect(feed.of(kurt.id, karen.id).map((p) => p.id)).toEqual([famOnly.id])
  expect(() => feed.post(anthony.id, { body: 'x', audience: rademacher.id })).toThrow('a family you are in')

  // Only the author deletes a post; the post's author can delete comments on it.
  feed.deletePost(karen.id, hello.id)
  expect(feed.get(hello.id)).not.toBeNull()
  feed.deleteComment(anthony.id, seen.comments[0]!.id)
  expect(feed.item(anthony.id, hello.id)!.comments).toHaveLength(0)
})

test('a block hides posts both ways', () => {
  const { store, net, feed, user } = world()
  const a = user('a@example.com', 'A')
  const b = user('b@example.com', 'B')
  const tree = store.createTree(a.id, 'T')
  store.setMember(tree.id, b.id, 'viewer')
  feed.post(b.id, { body: 'hi' })
  feed.subscribe(a.id, b.id)
  expect(feed.home(a.id)).toHaveLength(1)
  net.block(a.id, b.id)
  expect(feed.home(a.id)).toHaveLength(0)
  expect(() => feed.subscribe(b.id, a.id)).toThrow()
})

test('subscribe to everyone you know, and photos only for those who may see the post', () => {
  const { store, feed, user } = world()
  const a = user('a@example.com', 'A')
  const b = user('b@example.com', 'B')
  const c = user('c@example.com', 'C')
  const stranger = user('s@example.com', 'S')
  const tree = store.createTree(a.id, 'T')
  store.setMember(tree.id, b.id, 'viewer')
  store.setMember(tree.id, c.id, 'editor')
  expect(feed.subscribeAll(a.id)).toBe(2)
  expect(feed.subscribeAll(a.id)).toBe(0)
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
  const p = feed.post(b.id, { body: '', photo: { data: png } })
  expect(feed.photo(a.id, p.id)?.mime).toBe('image/png')
  expect(feed.photo(stranger.id, p.id)).toBeNull()
  expect(() => feed.post(b.id, { body: '', photo: { data: new Uint8Array([1, 2, 3]) } })).toThrow('not a photo')
  expect(() => feed.post(b.id, {})).toThrow('write something')
})

test('the feed page: post, subscribe, comment, like over the web; strangers get 404s', async () => {
  const { store, user, as } = world()
  const a = user('a@example.com', 'Anthony')
  const b = user('b@example.com', 'Bobbi')
  const s = user('s@example.com', 'Stranger')
  const tree = store.createTree(a.id, 'Ettinger')
  store.setMember(tree.id, b.id, 'viewer')

  const page = await (await as(a).get('/feed')).text()
  expect(page).toContain('Your family feed')
  expect(page).toContain('Only Ettinger')
  expect(page).toContain('Bobbi')

  expect(decodeURIComponent((await as(b).post('/feed', { body: 'Hello family', audience: tree.id })).headers.get('location')!)).toContain('Posted')
  await as(a).post(`/feed/u/${b.id}/subscribe`)
  const home = await (await as(a).get('/feed')).text()
  expect(home).toContain('Hello family')
  expect(home).toContain('to Ettinger')
  const postId = home.match(/id="post-([^"]+)"/)![1]!
  await as(a).post(`/feed/p/${postId}/comment`, { body: 'Hi Bobbi' })
  await as(a).post(`/feed/p/${postId}/like`)
  const after = await (await as(b).get(`/feed/u/${b.id}`)).text()
  expect(after).toContain('Hi Bobbi')
  expect(after).toContain('♡ 1')

  expect((await as(s).get(`/feed/u/${b.id}`)).status).toBe(404)
  expect((await as(s).get(`/feed/p/${postId}/photo`)).status).toBe(404)
  expect(decodeURIComponent((await as(s).post(`/feed/u/${b.id}/subscribe`)).headers.get('location')!)).toContain('connected with or share a tree')
  expect((await as(a).get('/trees')).status).toBe(200)
  expect(await (await as(a).get('/trees')).text()).toContain('<a href="/feed">Feed</a>')
})

test('the API: post, read, subscribe by token', async () => {
  const { store, auth, app, user } = world()
  const a = user('a@example.com', 'A')
  const b = user('b@example.com', 'B')
  const tree = store.createTree(a.id, 'T')
  store.setMember(tree.id, b.id, 'viewer')
  const token = (u: User) => auth.createToken(u.id, 'test')
  const call = (u: User, method: string, path: string, body?: unknown) => app.request(`${SITE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token(u)}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const posted = await (await call(b, 'POST', '/feed', { body: 'From the CLI' })).json()
  expect(posted.post.body).toBe('From the CLI')
  expect((await (await call(a, 'GET', '/feed/people')).json()).people).toEqual([{ id: b.id, name: 'B', subscribed: false }])
  await call(a, 'POST', `/feed/u/${b.id}/subscribe`)
  const feed = await (await call(a, 'GET', '/feed')).json()
  expect(feed.posts.map((p: any) => p.body)).toEqual(['From the CLI'])
})
