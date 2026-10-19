/**
 * Your socials: the posts you made on Bluesky, Mastodon, LinkedIn, dev.to, your blog and
 * the rest, in one place, with how people answered them (likes, reposts, replies).
 *
 * Nothing here reaches out to a network. A poster (myna, a script, the CLI's
 * `ancestry social import`) sends what it posted through the API with your token; the
 * CLI also reads the counts from the networks' public APIs. These are posts you already
 * made in public, so the newest ones show on your public profile, account by account,
 * unless you hide an account. /socials is yours alone: every account, every post, totals.
 */
import type { Context, Hono } from 'hono'
import { clean, type Store, type User } from './db.js'
import { csrfField, esc, layout, type Ctx } from './html.js'

export type SocialPost = {
  url: string
  network: string
  account: string
  account_url: string | null
  text: string
  posted_at: number
  likes: number | null
  reposts: number | null
  replies: number | null
  counted_at: number | null
}

export type SocialAccount = {
  account: string
  network: string
  account_url: string | null
  posts: number
  /** null when the network keeps no public count (LinkedIn, blogs, forums). */
  likes: number | null
  reposts: number | null
  replies: number | null
  last_at: number
  hidden: boolean
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS social_posts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL, network TEXT NOT NULL, account TEXT NOT NULL, account_url TEXT,
  text TEXT NOT NULL, posted_at INTEGER NOT NULL,
  likes INTEGER, reposts INTEGER, replies INTEGER, counted_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, url)
);
CREATE INDEX IF NOT EXISTS social_posts_recent ON social_posts(user_id, posted_at);
CREATE TABLE IF NOT EXISTS social_hidden (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  PRIMARY KEY (user_id, account)
);
`

/** Bluesky, Mastodon, … for the network keys posters use. */
export const NETWORKS: Record<string, string> = {
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  linkedin: 'LinkedIn',
  devto: 'dev.to',
  x: 'X',
  threads: 'Threads',
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  reddit: 'Reddit',
  lemmy: 'Lemmy',
  tsbb: 'Forum',
  htmlblog: 'Blog',
  gitblog: 'Blog',
  bl0ggers: 'Blog',
  autoblog: 'Blog',
}
export const networkName = (n: string) => NETWORKS[n] ?? n.replace(/^./, (c) => c.toUpperCase())

/** An http(s) URL, or null. */
function webUrl(v: unknown): string | null {
  const s = clean(v, 2000)
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

function count(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 1e9) : null
}

function when(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : null
}

export const MAX_BATCH = 500

export class Socials {
  constructor(
    readonly store: Store,
    private now = () => Date.now(),
  ) {
    store.db.exec(SCHEMA)
  }

  /**
   * Add or update posts, keyed by their URL. Counts left out keep what was there, so a
   * poster that only knows the text never wipes the numbers the CLI read.
   */
  save(userId: string, input: unknown): { saved: number; skipped: number } {
    const list = Array.isArray(input) ? input.slice(0, MAX_BATCH) : []
    let saved = 0
    let skipped = 0
    const q = this.store.db.query(
      'INSERT INTO social_posts (user_id, url, network, account, account_url, text, posted_at, likes, reposts, replies, counted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, url) DO UPDATE SET network = excluded.network, account = excluded.account, account_url = COALESCE(excluded.account_url, social_posts.account_url), text = excluded.text, posted_at = excluded.posted_at, likes = COALESCE(excluded.likes, social_posts.likes), reposts = COALESCE(excluded.reposts, social_posts.reposts), replies = COALESCE(excluded.replies, social_posts.replies), counted_at = COALESCE(excluded.counted_at, social_posts.counted_at)',
    )
    const t = this.now()
    this.store.db.transaction(() => {
      for (const raw of list) {
        const p = (raw ?? {}) as Record<string, unknown>
        const url = webUrl(p.url)
        const network = clean(p.network, 40)?.toLowerCase() ?? null
        const account = clean(p.account, 200)
        const text = clean(p.text, 5000) ?? ''
        const at = when(p.posted_at ?? p.at)
        if (!url || !network || !account || !at) {
          skipped++
          continue
        }
        const likes = count(p.likes)
        const reposts = count(p.reposts)
        const replies = count(p.replies)
        const counted = likes !== null || reposts !== null || replies !== null ? t : null
        q.run(userId, url, network, account, webUrl(p.account_url), text, at, likes, reposts, replies, counted, t)
        saved++
      }
    })()
    return { saved, skipped }
  }

  posts(userId: string, opts: { limit?: number; account?: string | null; publicOnly?: boolean } = {}): SocialPost[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))
    const rows = this.store.db
      .query<SocialPost, [string, string, number, number]>(
        "SELECT url, network, account, account_url, text, posted_at, likes, reposts, replies, counted_at FROM social_posts WHERE user_id = ?1 AND (?2 = '' OR account = ?2) AND (?3 = 0 OR account NOT IN (SELECT account FROM social_hidden WHERE user_id = ?1)) ORDER BY posted_at DESC LIMIT ?4",
      )
      .all(userId, opts.account ?? '', opts.publicOnly ? 1 : 0, limit)
    return rows
  }

  accounts(userId: string): SocialAccount[] {
    return this.store.db
      .query<Omit<SocialAccount, 'hidden'> & { hidden: number }, [string]>(
        'SELECT account, network, MAX(account_url) AS account_url, COUNT(*) AS posts, SUM(likes) AS likes, SUM(reposts) AS reposts, SUM(replies) AS replies, MAX(posted_at) AS last_at, EXISTS (SELECT 1 FROM social_hidden h WHERE h.user_id = social_posts.user_id AND h.account = social_posts.account) AS hidden FROM social_posts WHERE user_id = ? GROUP BY account, network ORDER BY last_at DESC',
      )
      .all(userId)
      .map((a) => ({ ...a, hidden: Boolean(a.hidden) }))
  }

  hide(userId: string, account: string, hidden: boolean) {
    if (hidden) this.store.db.query('INSERT OR IGNORE INTO social_hidden (user_id, account) VALUES (?,?)').run(userId, account)
    else this.store.db.query('DELETE FROM social_hidden WHERE user_id = ? AND account = ?').run(userId, account)
  }

  /** Forget one post, or every post of one account. */
  remove(userId: string, what: { url?: string | null; account?: string | null }): number {
    if (what.url) return this.store.db.query('DELETE FROM social_posts WHERE user_id = ? AND url = ?').run(userId, what.url).changes
    if (what.account) {
      this.store.db.query('DELETE FROM social_hidden WHERE user_id = ? AND account = ?').run(userId, what.account)
      return this.store.db.query('DELETE FROM social_posts WHERE user_id = ? AND account = ?').run(userId, what.account).changes
    }
    return 0
  }
}

// ---- pages -------------------------------------------------------------------

const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)
/** "chovy@defcon.social" from "mastodon:chovy@defcon.social". */
export const handleOf = (account: string) => account.replace(/^[a-z0-9]+:/i, '')

function numbers(p: Pick<SocialPost, 'likes' | 'reposts' | 'replies'>): string {
  const say = (n: number | null, one: string, many: string) => (typeof n === 'number' ? `${n} ${n === 1 ? one : many}` : null)
  const bits = [say(p.likes, 'like', 'likes'), say(p.reposts, 'repost', 'reposts'), say(p.replies, 'reply', 'replies')].filter(Boolean)
  return bits.length ? `<span class="muted small">${bits.join(' · ')}</span>` : ''
}

function postItem(p: SocialPost): string {
  return `<li class="spost"><span class="tag">${esc(networkName(p.network))}</span> <span class="muted small">${esc(handleOf(p.account))} · ${day(p.posted_at)}</span><br><a href="${esc(p.url)}" rel="nofollow noopener" target="_blank">${esc(short(p.text.replace(/\s+/g, ' ').trim() || p.url, 280))}</a>${numbers(p) ? `<br>${numbers(p)}` : ''}</li>`
}

/** The section on a public profile: the newest posts from accounts not hidden. */
export function profileSection(name: string, posts: SocialPost[], accounts: SocialAccount[], mine: boolean): string {
  const shown = accounts.filter((a) => !a.hidden)
  if (!posts.length && !mine) return ''
  const links = shown.length
    ? `<p class="small">${shown.map((a) => (a.account_url ? `<a href="${esc(a.account_url)}" rel="me nofollow noopener">${esc(networkName(a.network))}: ${esc(handleOf(a.account))}</a>` : `${esc(networkName(a.network))}: ${esc(handleOf(a.account))}`)).join(' · ')}</p>`
    : ''
  return `<section class="panel" id="socials"><h2>On social media</h2>${links}${posts.length ? `<ul class="sposts">${posts.map(postItem).join('')}</ul>` : `<p class="muted small">Nothing yet. <a href="/socials">Connect your socials</a>.</p>`}${mine ? '<p class="small"><a href="/socials">All my socials and engagement</a></p>' : ''}</section>`
}

export function socialsPage(ctx: Ctx, accounts: SocialAccount[], posts: SocialPost[], filter: string | null, profileSlug: string | null): string {
  const csrf = csrfField(ctx)
  const total = accounts.reduce((s, a) => ({ posts: s.posts + a.posts, likes: s.likes + (a.likes ?? 0), reposts: s.reposts + (a.reposts ?? 0), replies: s.replies + (a.replies ?? 0) }), { posts: 0, likes: 0, reposts: 0, replies: 0 })
  const n = (x: number | null) => (x === null ? '<span class="muted" title="This network keeps no public count">–</span>' : String(x))
  const rows = accounts
    .map(
      (a) =>
        `<tr><td><span class="tag">${esc(networkName(a.network))}</span> ${a.account_url ? `<a href="${esc(a.account_url)}" rel="nofollow noopener">${esc(handleOf(a.account))}</a>` : esc(handleOf(a.account))}</td><td><a href="/socials?account=${encodeURIComponent(a.account)}">${a.posts}</a></td><td>${n(a.likes)}</td><td>${n(a.reposts)}</td><td>${n(a.replies)}</td><td class="muted small">${day(a.last_at)}</td><td><form method="post" action="/socials/hide" class="inline">${csrf}<input type="hidden" name="account" value="${esc(a.account)}"><input type="hidden" name="hidden" value="${a.hidden ? '0' : '1'}"><button class="btn small${a.hidden ? '' : ' on'}" title="Show this account's posts on your public profile">${a.hidden ? 'Hidden' : 'On profile'}</button></form></td></tr>`,
    )
    .join('')
  const table = accounts.length
    ? `<table class="stable"><thead><tr><th>Account</th><th>Posts</th><th>Likes</th><th>Reposts</th><th>Replies</th><th>Last post</th><th>Public profile</th></tr></thead><tbody>${rows}<tr><th>All</th><th>${total.posts}</th><th>${total.likes}</th><th>${total.reposts}</th><th>${total.replies}</th><th></th><th></th></tr></tbody></table>`
    : ''
  const how = `<details class="panel"${accounts.length ? '' : ' open'}><summary>Connect your socials</summary>
<p class="small">Posts come in through the API with a token from <a href="/settings">Settings</a>. From the terminal, after <code>ancestry login</code>:</p>
<pre>ancestry social import            # reads myna's ~/.config/myna/history.json, with likes, reposts and replies
ancestry social import posts.json # or a JSON list of {url, network, account, text, posted_at}</pre>
<p class="small">Or POST that list to <code>/api/v1/social/posts</code> as <code>{"posts": [...]}</code>. Run it on a timer to keep the counts fresh.</p></details>`
  return layout(
    ctx,
    'Your socials',
    `<h1>Your socials</h1>
<p class="muted">Everything you posted on your other networks, and how people answered, in one place. Only you see this page.${profileSlug ? ` Accounts marked "On profile" show their newest posts on <a href="/profile/${esc(profileSlug)}#socials">your public profile</a>.` : ' Make a <a href="/settings/profile">public profile</a> to show them there.'}</p>
${table}
${filter ? `<p class="chips"><a class="chip" href="/socials">${esc(handleOf(filter))} ×</a></p>` : ''}
${posts.length ? `<ul class="sposts">${posts.map(postItem).join('')}</ul>` : accounts.length ? '<p class="empty">No posts.</p>' : '<p class="empty">No socials connected yet.</p>'}
${how}`,
    { crumbs: [['/settings', 'Settings'], ['', 'Socials']] },
  )
}

export const postOut = (p: SocialPost) => ({ ...p, posted_at: new Date(p.posted_at).toISOString(), counted_at: p.counted_at ? new Date(p.counted_at).toISOString() : null })

// ---- routes ------------------------------------------------------------------

export function mountSocials(app: Hono<any>, api: Hono<any>, d: { socials: Socials; ctx: (c: Context, extra?: Partial<Ctx>) => Ctx; form: (c: Context) => Promise<Record<string, any>>; profileSlug: (userId: string) => string | null }) {
  const { socials } = d
  const me = (c: Context): User | null => c.get('user') ?? null

  app.get('/socials', (c) => {
    const u = me(c)
    if (!u) return c.redirect(`/signin?next=${encodeURIComponent('/socials')}`)
    const account = clean(c.req.query('account'), 200)
    return c.html(socialsPage(d.ctx(c), socials.accounts(u.id), socials.posts(u.id, { account, limit: 100 }), account, d.profileSlug(u.id)))
  })
  app.post('/socials/hide', async (c) => {
    const u = me(c)
    if (!u) return c.redirect('/signin?next=%2Fsocials')
    const body = await d.form(c)
    const account = clean(body.account, 200)
    if (account) socials.hide(u.id, account, body.hidden === '1')
    return c.redirect('/socials')
  })

  api.get('/social', (c) => {
    const u = me(c)!
    const account = clean(c.req.query('account'), 200)
    return c.json({ accounts: socials.accounts(u.id).map((a) => ({ ...a, last_at: new Date(a.last_at).toISOString() })), posts: socials.posts(u.id, { account, limit: Number(c.req.query('limit')) || 50 }).map(postOut) })
  })
  api.post('/social/posts', async (c) => {
    const body = ((await c.req.json().catch(() => null)) as Record<string, unknown> | unknown[] | null) ?? {}
    const list = Array.isArray(body) ? body : (body as Record<string, unknown>).posts
    if (!Array.isArray(list)) return c.json({ error: `send {"posts": [{url, network, account, text, posted_at}, ...]}, up to ${MAX_BATCH} at a time` }, 400)
    if (list.length > MAX_BATCH) return c.json({ error: `up to ${MAX_BATCH} posts at a time` }, 400)
    return c.json(socials.save(me(c)!.id, list))
  })
  api.post('/social/accounts/hide', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) ?? {}
    const account = clean(body.account, 200)
    if (!account) return c.json({ error: 'give the account, like "bluesky:you.bsky.social"' }, 400)
    socials.hide(me(c)!.id, account, body.hidden !== false)
    return c.json({ ok: true })
  })
  api.post('/social/posts/remove', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) ?? {}
    return c.json({ removed: socials.remove(me(c)!.id, { url: clean(body.url, 2000), account: clean(body.account, 200) }) })
  })
}
