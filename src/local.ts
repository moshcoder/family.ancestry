/**
 * Local: businesses recommended by people you know.
 *
 * Ask "who's a good plumber?" and the answer comes from your family, your
 * neighbors and your friends, not from strangers and not from whoever paid for
 * the top spot. The rules, in the code:
 *
 *   - a recommendation is seen only by people who know the recommender (a
 *     connection, or someone they share a tree with), and by them;
 *   - no stars, no reviews from strangers, no public directory;
 *   - ranking is how many people you know vouch for a place, weighted by how
 *     close they are to you: family and neighbors count most.
 *
 * A pick snapshots the business (name, category, town, phone, site) at the moment
 * you share it, because your contacts themselves stay private. (Passing one
 * contact to one person is the network's recommend; this is the shared list.)
 */
import type { Context, Hono } from 'hono'
import { clean, newId, type Store, type User } from './db.js'
import type { Network } from './network.js'
import * as html from './html.js'
import type { Ctx } from './html.js'
import { contactName } from './network.js'

export type LocalPick = {
  id: string
  owner_id: string
  contact_id: string | null
  name: string
  category: string
  town: string | null
  phone: string | null
  website: string | null
  note: string | null
  key: string
  created_at: number
  updated_at: number
}

export type Ranked = {
  key: string
  name: string
  category: string
  town: string | null
  phone: string | null
  website: string | null
  score: number
  by: { user: User; circle: string; note: string | null; mine: boolean; id: string }[]
}

/** What people ask for; the field is free text, these are suggestions. */
export const CATEGORIES = ['Plumber', 'Electrician', 'Handyman', 'Roofer', 'HVAC', 'Landscaper', 'House cleaner', 'Mechanic', 'Dentist', 'Doctor', 'Pediatrician', 'Vet', 'Groomer', 'Babysitter', 'Tutor', 'Restaurant', 'Bakery', 'Hair salon', 'Barber', 'Accountant', 'Lawyer', 'Realtor', 'Contractor', 'Painter', 'Movers', 'Pest control', 'Locksmith', 'Photographer', 'Florist', 'Daycare']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_recommendations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT, name TEXT NOT NULL, category TEXT NOT NULL, town TEXT, phone TEXT, website TEXT, note TEXT,
  key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, key)
);
CREATE INDEX IF NOT EXISTS local_recommendations_key ON local_recommendations(key);
`

/** How close a recommender is to you. */
export const WEIGHTS: Record<string, number> = { family: 3, neighbors: 3, friends: 2, tree: 2, business: 1, connection: 1 }

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())

/** The same place recommended by two people: same phone, else same website, else same name in the same town. */
export function businessKey(r: { name: string; town?: string | null; phone?: string | null; website?: string | null }): string {
  const digits = (r.phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  if (digits.length >= 7) return `tel:${digits}`
  const host = (() => {
    try {
      return r.website ? new URL(/^https?:/i.test(r.website) ? r.website : `https://${r.website}`).hostname.replace(/^www\./, '').toLowerCase() : ''
    } catch {
      return ''
    }
  })()
  if (host) return `web:${host}`
  const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return `name:${norm(r.name)}|${norm(r.town)}`
}

export class Local {
  constructor(
    readonly store: Store,
    readonly net: Network,
    private now = () => Date.now(),
  ) {
    store.db.exec(SCHEMA)
  }

  recommend(ownerId: string, input: Record<string, unknown>): LocalPick {
    const name = clean(input.name, 200)
    const category = clean(input.category, 60)
    if (!name) throw new Error('give the business a name')
    if (!category) throw new Error('say what they do (plumber, dentist…)')
    const website = clean(input.website, 500)
    const r = { name, category: titleCase(category), town: clean(input.town, 120), phone: clean(input.phone, 60), website: website && /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}/i.test(website) ? (/^https?:/i.test(website) ? website : `https://${website}`) : null, note: clean(input.note, 1000) }
    const key = businessKey(r)
    const now = this.now()
    this.store.db
      .query(
        `INSERT INTO local_recommendations (id,owner_id,contact_id,name,category,town,phone,website,note,key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(owner_id,key) DO UPDATE SET name=excluded.name, category=excluded.category, town=excluded.town, phone=excluded.phone, website=excluded.website, note=excluded.note, updated_at=excluded.updated_at`,
      )
      .run(newId(), ownerId, clean(input.contact_id, 40), r.name, r.category, r.town, r.phone, r.website, r.note, key, now, now)
    return this.store.db.query<LocalPick, [string, string]>('SELECT * FROM local_recommendations WHERE owner_id = ? AND key = ?').get(ownerId, key)!
  }

  /** Recommend one of your own business contacts: its details are copied in. */
  recommendContact(ownerId: string, contactId: string, input: Record<string, unknown>): LocalPick {
    const c = this.net.contact(ownerId, contactId)
    if (!c) throw new Error('no such contact')
    const town = c.addresses[0]?.lines.split('\n').at(-1) ?? null
    return this.recommend(ownerId, { name: c.company || contactName(c), phone: c.phones[0]?.value, website: c.links[0]?.value, town, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')), contact_id: c.id })
  }

  remove(ownerId: string, id: string) {
    this.store.db.query('DELETE FROM local_recommendations WHERE owner_id = ? AND id = ?').run(ownerId, id)
  }

  mine(ownerId: string): LocalPick[] {
    return this.store.db.query<LocalPick, [string]>('SELECT * FROM local_recommendations WHERE owner_id = ? ORDER BY category, name').all(ownerId)
  }

  /** How each person you know relates to you, for weighting: your own contact circle for them wins. */
  private closeness(me: string): Map<string, string> {
    const out = new Map<string, string>()
    for (const u of this.net.reachable(me)) out.set(u.id, this.store.sharesTree(me, u.id) ? 'tree' : 'connection')
    for (const c of this.net.contacts(me)) if (c.linked_user_id && out.has(c.linked_user_id)) out.set(c.linked_user_id, c.circle)
    return out
  }

  /** Businesses vouched for by you and the people you know, best first. */
  search(me: string, opts: { q?: string; category?: string; limit?: number } = {}): Ranked[] {
    const close = this.closeness(me)
    const owners = [me, ...close.keys()]
    const rows = owners.flatMap((id) => this.store.db.query<LocalPick, [string]>('SELECT * FROM local_recommendations WHERE owner_id = ?').all(id))
    const words = (opts.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
    const category = (opts.category ?? '').toLowerCase()
    const groups = new Map<string, Ranked>()
    for (const r of rows) {
      const hay = [r.name, r.category, r.town, r.note].filter(Boolean).join(' ').toLowerCase()
      if (category && r.category.toLowerCase() !== category) continue
      if (!words.every((w) => hay.includes(w))) continue
      const user = this.store.user(r.owner_id)
      if (!user) continue
      const circle = r.owner_id === me ? 'you' : (close.get(r.owner_id) ?? 'connection')
      const g = groups.get(r.key) ?? { key: r.key, name: r.name, category: r.category, town: r.town, phone: r.phone, website: r.website, score: 0, by: [] }
      g.by.push({ user, circle, note: r.note, mine: r.owner_id === me, id: r.id })
      // Your own recommendation counts like family's: you trust yourself.
      g.score += r.owner_id === me ? 3 : (WEIGHTS[circle] ?? 1)
      for (const k of ['town', 'phone', 'website'] as const) g[k] ??= r[k]
      groups.set(r.key, g)
    }
    const order = ['you', 'family', 'neighbors', 'friends', 'tree', 'connection', 'business']
    for (const g of groups.values()) g.by.sort((a, b) => order.indexOf(a.circle) - order.indexOf(b.circle))
    return [...groups.values()].sort((a, b) => b.score - a.score || b.by.length - a.by.length || a.name.localeCompare(b.name)).slice(0, opts.limit ?? 200)
  }

  /** Categories with something in them, for the people you know. */
  categories(me: string): { category: string; n: number }[] {
    const counts = new Map<string, number>()
    for (const r of this.search(me, { limit: 10_000 })) counts.set(r.category, (counts.get(r.category) ?? 0) + 1)
    return [...counts].map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n || a.category.localeCompare(b.category))
  }
}

// ---- pages and API ----------------------------------------------------------

export type LocalDeps = {
  local: Local
  ctx: (c: Context, extra?: Partial<Ctx>) => Ctx
  form: (c: Context) => Promise<Record<string, any>>
}

const CIRCLE_WORD: Record<string, string> = { you: 'you', family: 'family', neighbors: 'neighbor', friends: 'friend', tree: 'in your tree', connection: 'connection', business: 'business contact' }

export function localPage(ctx: Ctx, v: { results: Ranked[]; categories: { category: string; n: number }[]; q: string; category: string; contacts: { id: string; name: string }[] }): string {
  const esc = html.esc
  const csrf = `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`
  const result = (r: Ranked) => `<li class="union"><div class="line"><b>${esc(r.name)}</b> <span class="tag">${esc(r.category)}</span>${r.town ? ` <span class="muted small">${esc(r.town)}</span>` : ''}</div>
<p class="small">${[r.phone ? `<a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : '', r.website ? `<a href="${esc(r.website)}" rel="noopener noreferrer nofollow" target="_blank">${esc(r.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : ''].filter(Boolean).join(' · ')}</p>
<p class="small">Recommended by ${r.by.map((b) => `${esc(b.mine ? 'you' : (b.user.name ?? b.user.email.split('@')[0]!))}${b.mine ? '' : ` <span class="muted">(${esc(CIRCLE_WORD[b.circle] ?? b.circle)})</span>`}${b.note ? `: <i>${esc(b.note)}</i>` : ''}${b.mine ? ` <form method="post" action="/local/r/${b.id}/delete" class="inline">${csrf}<button class="x" title="Take back your recommendation">×</button></form>` : ''}`).join('; ')}</p></li>`
  return html.layout(
    ctx,
    'Local',
    `<h1>Local businesses, from people you know</h1>
<p class="muted">Who your family, neighbors and friends actually use. Only people who know each other see these: no strangers' reviews, nothing paid to the top.</p>
<form class="search" method="get" action="/local"><input name="q" value="${esc(v.q)}" placeholder="plumber, dentist, a town…" aria-label="Search recommendations"><button>Search</button></form>
${v.categories.length ? `<p class="surnames">${v.categories.slice(0, 30).map((c) => `<a href="/local?category=${encodeURIComponent(c.category)}"${c.category.toLowerCase() === v.category.toLowerCase() ? ' aria-current="true"' : ''}>${esc(c.category)} <span>${c.n}</span></a>`).join('')}${v.category ? ' <a href="/local">all</a>' : ''}</p>` : ''}
${v.results.length ? `<ul class="plain">${v.results.map(result).join('')}</ul>` : `<p class="empty">${v.q || v.category ? 'Nobody you know has recommended one yet. Ask in the Inbox, then add the answer here.' : 'No recommendations yet. Add the plumber you trust, and invite your family and neighbors to add theirs.'}</p>`}
<details class="panel"${v.results.length ? '' : ' open'}><summary>Recommend a business</summary>
<form method="post" action="/local" class="pform">${csrf}
  ${v.contacts.length ? `<label>From your business contacts<select name="contact_id"><option value="">— or fill in below —</option>${v.contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>` : ''}
  <div class="grid2"><label>Business<input name="name" maxlength="200" placeholder="Joe's Plumbing"></label><label>What they do<input name="category" maxlength="60" list="local-categories" required placeholder="Plumber"></label></div>
  <div class="grid3"><label>Town<input name="town" maxlength="120" placeholder="Sacramento"></label><label>Phone<input name="phone" maxlength="60"></label><label>Website<input name="website" maxlength="500" placeholder="joesplumbing.com"></label></div>
  <label>Why you'd send your family there<input name="note" maxlength="1000" placeholder="Came out on a Sunday, fair price, cleaned up after"></label>
  <datalist id="local-categories">${CATEGORIES.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
  <button>Recommend</button>
</form></details>`,
  )
}

export function mountLocal(app: Hono<any>, api: Hono<any>, d: LocalDeps) {
  const { local } = d
  const user = (c: Context) => c.get('user') as User | null
  const view = (c: Context) => {
    const u = user(c)!
    const q = c.req.query('q') ?? ''
    const category = c.req.query('category') ?? ''
    return c.html(localPage(d.ctx(c), { results: local.search(u.id, { q, category }), categories: local.categories(u.id), q, category, contacts: local.net.contacts(u.id, { circle: 'business' }).map((x) => ({ id: x.id, name: x.company || contactName(x) })) }))
  }
  app.get('/local', (c) => (user(c) ? view(c) : c.redirect('/signin?next=/local')))
  app.post('/local', async (c) => {
    const u = user(c)
    if (!u) return c.redirect('/signin?next=/local')
    const body = await d.form(c)
    try {
      const r = body.contact_id ? local.recommendContact(u.id, String(body.contact_id), body) : local.recommend(u.id, body)
      return c.redirect(`/local?ok=${encodeURIComponent(`Recommended ${r.name}. Everyone who knows you can see it.`)}`)
    } catch (error) {
      return c.redirect(`/local?ok=${encodeURIComponent((error as Error).message)}`)
    }
  })
  app.post('/local/r/:id/delete', (c) => {
    const u = user(c)
    if (!u) return c.redirect('/signin?next=/local')
    local.remove(u.id, c.req.param('id'))
    return c.redirect('/local?ok=Taken%20back')
  })

  api.get('/local', (c) => c.json({ results: local.search(user(c)!.id, { q: c.req.query('q') ?? '', category: c.req.query('category') ?? '', limit: Math.min(500, Number(c.req.query('limit')) || 100) }).map((r) => ({ ...r, by: r.by.map((b) => ({ id: b.id, user_id: b.user.id, name: b.user.name, circle: b.circle, note: b.note, mine: b.mine })) })) }))
  api.get('/local/mine', (c) => c.json({ recommendations: local.mine(user(c)!.id) }))
  /** {name, category, town?, phone?, website?, note?} or {contact_id, category?, note?}. */
  api.post('/local', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    try {
      return c.json({ recommendation: body.contact_id ? local.recommendContact(user(c)!.id, String(body.contact_id), body) : local.recommend(user(c)!.id, body) }, 201)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }
  })
  api.delete('/local/:id', (c) => {
    local.remove(user(c)!.id, c.req.param('id'))
    return c.json({ ok: true })
  })
}
