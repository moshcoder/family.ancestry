/**
 * The family feed: a social network for the people you already know.
 *
 * Everyone has a feed they post to, and a home feed of the people they subscribe
 * to. The rules, in the code (the network's: humans, not influencers):
 *
 *   - you can subscribe only to someone you know: a connection, or someone you
 *     share a tree with. There are no public profiles and no follower counts;
 *   - a post goes to everyone who knows you, or to one family (the members of a
 *     tree you are in). Nobody else can read it, subscribed or not;
 *   - blocks hide posts both ways; comments are seen by whoever can see the post;
 *   - posting is limited (40 posts and 300 comments a day), like the inbox.
 */
import type { Context, Hono } from 'hono'
import { clean, newId, type Store, type Tree, type User } from './db.js'
import type { Network } from './network.js'
import * as html from './html.js'
import type { Ctx } from './html.js'
import { sniffImage } from './album.js'

export type Post = {
  id: string
  author_id: string
  body: string
  /** 'everyone' (all who know the author) or a tree id (that family only). */
  audience: string
  photo_mime: string | null
  created_at: number
}
export type Comment = { id: string; post_id: string; author_id: string; body: string; created_at: number }
export type FeedItem = Post & { author: User; family: string | null; likes: number; liked: boolean; comments: (Comment & { author: User })[] }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feed_posts (
  id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'everyone',
  photo BLOB, photo_mime TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_posts_author ON feed_posts(author_id, created_at);
CREATE TABLE IF NOT EXISTS feed_subscriptions (
  subscriber_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY (subscriber_id, author_id)
);
CREATE TABLE IF NOT EXISTS feed_comments (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_comments_post ON feed_comments(post_id, created_at);
CREATE TABLE IF NOT EXISTS feed_likes (
  post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (post_id, user_id)
);
`

export const POSTS_PER_DAY = 40
export const COMMENTS_PER_DAY = 300
export const MAX_PHOTO = 8 * 1024 * 1024

export class Feed {
  constructor(
    readonly store: Store,
    readonly net: Network,
    private now = () => Date.now(),
  ) {
    store.db.exec(SCHEMA)
  }

  /** You, or someone you know and have not blocked (either way). */
  knows(me: string, other: string): boolean {
    if (me === other) return true
    if (this.net.blockedEitherWay(me, other)) return false
    return this.net.connected(me, other) || this.store.sharesTree(me, other)
  }

  canSee(me: string, post: Pick<Post, 'author_id' | 'audience'>): boolean {
    if (post.author_id === me) return true
    if (!this.knows(me, post.author_id)) return false
    return post.audience === 'everyone' || (Boolean(this.store.role(post.audience, me)) && Boolean(this.store.role(post.audience, post.author_id)))
  }

  post(authorId: string, input: { body?: unknown; audience?: unknown; photo?: { data: Uint8Array } | null }): Post {
    const body = clean(input.body, 5000)
    if (!body && !input.photo) throw new Error('write something, or add a photo')
    const audience = String(input.audience ?? 'everyone')
    if (audience !== 'everyone' && !this.store.role(audience, authorId)) throw new Error('you can post to everyone who knows you, or to a family you are in')
    const since = this.now() - 86_400_000
    if ((this.store.db.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM feed_posts WHERE author_id = ? AND created_at > ?').get(authorId, since)?.n ?? 0) >= POSTS_PER_DAY) throw new Error(`that is ${POSTS_PER_DAY} posts today; more tomorrow`)
    let mime: string | null = null
    if (input.photo) {
      if (input.photo.data.byteLength > MAX_PHOTO) throw new Error('photos can be up to 8 MB')
      mime = sniffImage(input.photo.data)
      if (!mime) throw new Error('that file is not a photo (JPEG, PNG, GIF or WebP)')
    }
    const id = newId()
    this.store.db.query('INSERT INTO feed_posts (id,author_id,body,audience,photo,photo_mime,created_at) VALUES (?,?,?,?,?,?,?)').run(id, authorId, body ?? '', audience, input.photo?.data ?? null, mime, this.now())
    return this.get(id)!
  }

  get(id: string): Post | null {
    return this.store.db.query<Post, [string]>('SELECT id, author_id, body, audience, photo_mime, created_at FROM feed_posts WHERE id = ?').get(id) ?? null
  }

  photo(me: string, id: string): { data: Uint8Array; mime: string } | null {
    const p = this.get(id)
    if (!p || !p.photo_mime || !this.canSee(me, p)) return null
    const row = this.store.db.query<{ photo: Uint8Array }, [string]>('SELECT photo FROM feed_posts WHERE id = ?').get(id)
    return row?.photo ? { data: row.photo, mime: p.photo_mime } : null
  }

  deletePost(me: string, id: string) {
    this.store.db.query('DELETE FROM feed_posts WHERE id = ? AND author_id = ?').run(id, me)
  }

  subscribe(me: string, authorId: string) {
    if (me === authorId) throw new Error('your own posts are always in your feed')
    if (!this.store.user(authorId) || !this.knows(me, authorId)) throw new Error('you can subscribe to people you are connected with or share a tree with')
    this.store.db.query('INSERT OR IGNORE INTO feed_subscriptions (subscriber_id,author_id,created_at) VALUES (?,?,?)').run(me, authorId, this.now())
  }

  unsubscribe(me: string, authorId: string) {
    this.store.db.query('DELETE FROM feed_subscriptions WHERE subscriber_id = ? AND author_id = ?').run(me, authorId)
  }

  subscribed(me: string): Set<string> {
    return new Set(this.store.db.query<{ author_id: string }, [string]>('SELECT author_id FROM feed_subscriptions WHERE subscriber_id = ?').all(me).map((r) => r.author_id))
  }

  /** Everyone you know, and whether you are subscribed to them. */
  people(me: string): { user: User; subscribed: boolean }[] {
    const subs = this.subscribed(me)
    return this.net.reachable(me).map((user) => ({ user, subscribed: subs.has(user.id) }))
  }

  /** Subscribe to everyone you know, or everyone in one family. */
  subscribeAll(me: string, treeId: string | null = null): number {
    const subs = this.subscribed(me)
    const people = treeId ? (this.store.role(treeId, me) ? this.store.members(treeId).map((m) => m.user_id) : []) : this.net.reachable(me).map((u) => u.id)
    let n = 0
    for (const id of people) {
      if (id === me || subs.has(id) || !this.knows(me, id)) continue
      this.subscribe(me, id)
      n++
    }
    return n
  }

  /** Your home feed: your posts and those of the people you subscribe to, newest first. */
  home(me: string, opts: { before?: number; limit?: number } = {}): FeedItem[] {
    return this.items(me, [me, ...this.subscribed(me)], opts)
  }

  /** One person's posts, as far as you may see them. */
  of(me: string, authorId: string, opts: { before?: number; limit?: number } = {}): FeedItem[] {
    return this.knows(me, authorId) ? this.items(me, [authorId], opts) : []
  }

  private items(me: string, authors: string[], opts: { before?: number; limit?: number }): FeedItem[] {
    const limit = Math.min(100, opts.limit ?? 30)
    const before = opts.before ?? Number.MAX_SAFE_INTEGER
    const out: FeedItem[] = []
    // One query per author keeps the statement fixed; a family is tens of people, not thousands.
    const rows = authors.flatMap((a) => this.store.db.query<Post, [string, number, number]>('SELECT id, author_id, body, audience, photo_mime, created_at FROM feed_posts WHERE author_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?').all(a, before, limit * 3))
    for (const p of rows.sort((a, b) => b.created_at - a.created_at)) {
      if (out.length >= limit) break
      if (!this.canSee(me, p)) continue
      const author = this.store.user(p.author_id)
      if (author) out.push(this.decorate(me, p, author))
    }
    return out
  }

  item(me: string, id: string): FeedItem | null {
    const p = this.get(id)
    const author = p ? this.store.user(p.author_id) : null
    return p && author && this.canSee(me, p) ? this.decorate(me, p, author) : null
  }

  private decorate(me: string, p: Post, author: User): FeedItem {
    const likes = this.store.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM feed_likes WHERE post_id = ?').get(p.id)?.n ?? 0
    const liked = Boolean(this.store.db.query<{ n: number }, [string, string]>('SELECT 1 AS n FROM feed_likes WHERE post_id = ? AND user_id = ?').get(p.id, me))
    const comments = this.store.db
      .query<Comment, [string]>('SELECT * FROM feed_comments WHERE post_id = ? ORDER BY created_at')
      .all(p.id)
      .filter((c) => c.author_id === me || !this.net.blockedEitherWay(me, c.author_id))
      .flatMap((c) => {
        const u = this.store.user(c.author_id)
        return u ? [{ ...c, author: u }] : []
      })
    return { ...p, author, family: p.audience === 'everyone' ? null : (this.store.tree(p.audience)?.name ?? null), likes, liked, comments }
  }

  comment(me: string, postId: string, body: unknown): Comment {
    const p = this.get(postId)
    if (!p || !this.canSee(me, p)) throw new Error('no such post')
    const text = clean(body, 2000)
    if (!text) throw new Error('write a comment')
    if ((this.store.db.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM feed_comments WHERE author_id = ? AND created_at > ?').get(me, this.now() - 86_400_000)?.n ?? 0) >= COMMENTS_PER_DAY) throw new Error('that is a lot of comments today; more tomorrow')
    const id = newId()
    this.store.db.query('INSERT INTO feed_comments (id,post_id,author_id,body,created_at) VALUES (?,?,?,?,?)').run(id, postId, me, text, this.now())
    return this.store.db.query<Comment, [string]>('SELECT * FROM feed_comments WHERE id = ?').get(id)!
  }

  /** Your own comment, or any comment on your post. */
  deleteComment(me: string, id: string) {
    this.store.db.query('DELETE FROM feed_comments WHERE id = ? AND (author_id = ? OR post_id IN (SELECT id FROM feed_posts WHERE author_id = ?))').run(id, me, me)
  }

  /** Like, or unlike if you already did. Returns whether you like it now. */
  toggleLike(me: string, postId: string): boolean {
    const p = this.get(postId)
    if (!p || !this.canSee(me, p)) throw new Error('no such post')
    if (this.store.db.query('DELETE FROM feed_likes WHERE post_id = ? AND user_id = ?').run(postId, me).changes) return false
    this.store.db.query('INSERT INTO feed_likes (post_id,user_id) VALUES (?,?)').run(postId, me)
    return true
  }
}

// ---- pages and API ----------------------------------------------------------

export type FeedDeps = {
  feed: Feed
  ctx: (c: Context, extra?: Partial<Ctx>) => Ctx
  form: (c: Context) => Promise<Record<string, any>>
}

const who = (u: User) => u.name ?? u.email.split('@')[0]!
const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

function postHtml(ctx: Ctx, me: string, p: FeedItem): string {
  const esc = html.esc
  const csrf = `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`
  return `<article class="post panel" id="post-${p.id}">
<header class="post-head"><a href="/feed/u/${p.author.id}"><b>${esc(who(p.author))}</b></a> <span class="muted small">${esc(when(p.created_at))} · ${p.family ? `to ${esc(p.family)}` : 'to everyone who knows them'}</span>${p.author_id === me ? ` <form method="post" action="/feed/p/${p.id}/delete" class="inline" data-confirm="Delete this post?">${csrf}<button class="x" title="Delete post">×</button></form>` : ''}</header>
${p.body ? `<p class="post-body">${esc(p.body).replace(/\n/g, '<br>')}</p>` : ''}
${p.photo_mime ? `<img class="post-photo" src="/feed/p/${p.id}/photo" alt="Photo from ${esc(who(p.author))}" loading="lazy">` : ''}
<div class="post-actions"><form method="post" action="/feed/p/${p.id}/like" class="inline">${csrf}<button class="btn${p.liked ? ' on' : ''}">${p.liked ? '♥' : '♡'} ${p.likes || ''}</button></form></div>
${p.comments.length ? `<ul class="comments">${p.comments.map((c) => `<li><a href="/feed/u/${c.author.id}"><b>${esc(who(c.author))}</b></a> ${esc(c.body)} <span class="muted small">${esc(when(c.created_at))}</span>${c.author_id === me || p.author_id === me ? ` <form method="post" action="/feed/c/${c.id}/delete" class="inline">${csrf}<button class="x" title="Delete comment">×</button></form>` : ''}</li>`).join('')}</ul>` : ''}
<form method="post" action="/feed/p/${p.id}/comment" class="row">${csrf}<input name="body" maxlength="2000" placeholder="Write a comment" aria-label="Comment" required><button>Comment</button></form>
</article>`
}

const more = (path: string, items: FeedItem[]) => (items.length >= 30 ? `<p><a class="btn" href="${path}?before=${items.at(-1)!.created_at}">Older posts</a></p>` : '')

export function feedPage(ctx: Ctx, me: User, v: { items: FeedItem[]; families: Tree[]; people: { user: User; subscribed: boolean }[] }): string {
  const esc = html.esc
  const csrf = `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`
  const unsubscribed = v.people.filter((p) => !p.subscribed)
  return html.layout(
    ctx,
    'Feed',
    `<h1>Your family feed</h1>
<p class="muted">Posts from you and the people you subscribe to. Only people who know you can read what you post: no strangers, no public profiles, no follower counts.</p>
<form method="post" action="/feed" enctype="multipart/form-data" class="panel pform">${csrf}
  <label>Share something with your family<textarea name="body" rows="3" maxlength="5000" placeholder="News, a photo, a memory…"></textarea></label>
  <div class="grid2"><label>Who sees it<select name="audience"><option value="everyone">Everyone who knows me</option>${v.families.map((t) => `<option value="${esc(t.id)}">Only ${esc(t.name)}</option>`).join('')}</select></label><label>Photo (optional)<input type="file" name="photo" accept="image/*"></label></div>
  <button>Post</button>
</form>
${v.items.length ? v.items.map((p) => postHtml(ctx, me.id, p)).join('') : `<p class="empty">${v.people.length ? 'Nothing here yet. Subscribe to your family below, and post the first thing.' : 'Nothing here yet. Your feed fills up with the people in your trees and your network: invite your family.'}</p>`}
${more('/feed', v.items)}
<section class="panel"><h2>People you know</h2>
${unsubscribed.length ? `<form method="post" action="/feed/subscribe-all" class="inline">${csrf}<button class="btn">Subscribe to all (${unsubscribed.length})</button></form>` : ''}
${v.people.length ? `<ul class="plain">${v.people.map((p) => `<li><a href="/feed/u/${p.user.id}">${esc(who(p.user))}</a> <form method="post" action="/feed/u/${p.user.id}/${p.subscribed ? 'unsubscribe' : 'subscribe'}" class="inline">${csrf}<button class="btn${p.subscribed ? ' on' : ''}">${p.subscribed ? 'Subscribed' : 'Subscribe'}</button></form></li>`).join('')}</ul>` : '<p class="muted">Nobody yet. Everyone in your trees and everyone you connect with in your Network shows up here.</p>'}
</section>`,
  )
}

export function authorPage(ctx: Ctx, me: User, author: User, v: { items: FeedItem[]; subscribed: boolean }): string {
  const esc = html.esc
  const csrf = `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`
  return html.layout(
    ctx,
    who(author),
    `<div class="titlebar"><h1>${esc(who(author))}</h1>${author.id === me.id ? '' : `<div class="actions"><form method="post" action="/feed/u/${author.id}/${v.subscribed ? 'unsubscribe' : 'subscribe'}" class="inline">${csrf}<button class="btn${v.subscribed ? ' on' : ''}">${v.subscribed ? 'Subscribed' : 'Subscribe'}</button></form></div>`}</div>
${v.items.length ? v.items.map((p) => postHtml(ctx, me.id, p)).join('') : '<p class="empty">No posts you can see yet.</p>'}
${more(`/feed/u/${author.id}`, v.items)}`,
    { crumbs: [['/feed', 'Feed'], ['', who(author)]] },
  )
}

export function mountFeed(app: Hono<any>, api: Hono<any>, d: FeedDeps) {
  const { feed } = d
  const user = (c: Context) => c.get('user') as User | null
  const before = (c: Context) => Number(c.req.query('before')) || undefined
  const families = (me: string) => feed.store.treesFor(me).map((t) => feed.store.tree(t.id)!)
  const back = (c: Context, fallback = '/feed') => {
    const ref = c.req.header('referer') ?? ''
    try {
      const u = new URL(ref)
      return u.pathname.startsWith('/feed') ? u.pathname : fallback
    } catch {
      return fallback
    }
  }
  const flash = (path: string, note: string) => `${path}?ok=${encodeURIComponent(note)}`
  const signin = (c: Context) => c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`)

  app.get('/feed', (c) => {
    const u = user(c)
    if (!u) return signin(c)
    return c.html(feedPage(d.ctx(c), u, { items: feed.home(u.id, { before: before(c) }), families: families(u.id), people: feed.people(u.id) }))
  })
  app.post('/feed', async (c) => {
    const u = user(c)
    if (!u) return signin(c)
    const body = await d.form(c)
    try {
      const file = body.photo instanceof File && body.photo.size ? body.photo : null
      if (file && file.size > MAX_PHOTO) throw new Error('photos can be up to 8 MB')
      feed.post(u.id, { body: body.body, audience: body.audience, photo: file ? { data: new Uint8Array(await file.arrayBuffer()) } : null })
      return c.redirect(flash('/feed', 'Posted'))
    } catch (error) {
      return c.redirect(flash('/feed', (error as Error).message))
    }
  })
  app.get('/feed/u/:user', (c) => {
    const u = user(c)
    if (!u) return signin(c)
    const author = feed.store.user(c.req.param('user'))
    if (!author || !feed.knows(u.id, author.id)) return c.html(html.messagePage(d.ctx(c), 'Not found', 'Nobody by that id that you know.'), 404)
    return c.html(authorPage(d.ctx(c), u, author, { items: feed.of(u.id, author.id, { before: before(c) }), subscribed: feed.subscribed(u.id).has(author.id) }))
  })
  app.get('/feed/p/:post/photo', (c) => {
    const u = user(c)
    const photo = u ? feed.photo(u.id, c.req.param('post')) : null
    if (!photo) return c.text('Not found', 404)
    return c.body(photo.data as any, 200, { 'content-type': photo.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
  })
  const act = (path: string, run: (me: string, c: Context, body: Record<string, any>) => string) =>
    app.post(path, async (c) => {
      const u = user(c)
      if (!u) return signin(c)
      const body = await d.form(c)
      try {
        return c.redirect(flash(back(c), run(u.id, c, body)))
      } catch (error) {
        return c.redirect(flash(back(c), (error as Error).message))
      }
    })
  act('/feed/u/:user/subscribe', (me, c) => (feed.subscribe(me, c.req.param('user')!), 'Subscribed'))
  act('/feed/u/:user/unsubscribe', (me, c) => (feed.unsubscribe(me, c.req.param('user')!), 'Unsubscribed'))
  act('/feed/subscribe-all', (me, _c, body) => {
    const n = feed.subscribeAll(me, body.tree ? String(body.tree) : null)
    return `Subscribed to ${n} ${n === 1 ? 'person' : 'people'}`
  })
  act('/feed/p/:post/like', (me, c) => (feed.toggleLike(me, c.req.param('post')!) ? 'Liked' : 'Unliked'))
  act('/feed/p/:post/comment', (me, c, body) => (feed.comment(me, c.req.param('post')!, body.body), 'Commented'))
  act('/feed/p/:post/delete', (me, c) => (feed.deletePost(me, c.req.param('post')!), 'Post deleted'))
  act('/feed/c/:comment/delete', (me, c) => (feed.deleteComment(me, c.req.param('comment')!), 'Comment deleted'))

  // ---- API: the same, by token ----
  const out = (p: FeedItem) => ({
    id: p.id,
    author: { id: p.author.id, name: who(p.author) },
    body: p.body,
    audience: p.audience,
    family: p.family,
    photo_url: p.photo_mime ? `/feed/p/${p.id}/photo` : null,
    created_at: p.created_at,
    likes: p.likes,
    liked: p.liked,
    comments: p.comments.map((x) => ({ id: x.id, author: { id: x.author.id, name: who(x.author) }, body: x.body, created_at: x.created_at })),
  })
  const bad = (c: Context, error: unknown, status = 400) => c.json({ error: error instanceof Error ? error.message : String(error) }, status as any)
  const json = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
  api.get('/feed', (c) => c.json({ posts: feed.home(user(c)!.id, { before: before(c), limit: Number(c.req.query('limit')) || 30 }).map(out) }))
  api.post('/feed', async (c) => {
    try {
      const b = await json(c)
      const p = feed.post(user(c)!.id, { body: b.body, audience: b.audience ?? b.family ?? 'everyone' })
      return c.json({ post: out(feed.item(user(c)!.id, p.id)!) }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.get('/feed/people', (c) => c.json({ people: feed.people(user(c)!.id).map((p) => ({ id: p.user.id, name: who(p.user), subscribed: p.subscribed })) }))
  api.get('/feed/u/:user', (c) => (feed.knows(user(c)!.id, c.req.param('user')) && feed.store.user(c.req.param('user')) ? c.json({ posts: feed.of(user(c)!.id, c.req.param('user'), { before: before(c) }).map(out) }) : bad(c, 'nobody by that id that you know', 404)))
  api.post('/feed/u/:user/subscribe', (c) => {
    try {
      feed.subscribe(user(c)!.id, c.req.param('user'))
      return c.json({ ok: true })
    } catch (error) {
      return bad(c, error)
    }
  })
  api.post('/feed/u/:user/unsubscribe', (c) => {
    feed.unsubscribe(user(c)!.id, c.req.param('user'))
    return c.json({ ok: true })
  })
  api.post('/feed/subscribe-all', async (c) => {
    const b = await json(c)
    return c.json({ subscribed: feed.subscribeAll(user(c)!.id, b.tree ? String(b.tree) : null) })
  })
  api.post('/feed/p/:post/comment', async (c) => {
    try {
      const b = await json(c)
      return c.json({ comment: feed.comment(user(c)!.id, c.req.param('post'), b.body) }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.post('/feed/p/:post/like', (c) => {
    try {
      return c.json({ liked: feed.toggleLike(user(c)!.id, c.req.param('post')) })
    } catch (error) {
      return bad(c, error)
    }
  })
  api.delete('/feed/p/:post', (c) => {
    feed.deletePost(user(c)!.id, c.req.param('post'))
    return c.json({ ok: true })
  })
  api.delete('/feed/c/:comment', (c) => {
    feed.deleteComment(user(c)!.id, c.req.param('comment'))
    return c.json({ ok: true })
  })
}
