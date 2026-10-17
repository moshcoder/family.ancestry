/**
 * Listed trees: a family can be found without being seen.
 *
 * An owner may list a tree in the public directory at /families. A listing shows
 * the tree's name and a few lines the owner writes for strangers, and nothing
 * from inside the tree: no people, no names, no counts, no members, not even who
 * owns it. The tree itself stays exactly as private as before (non-members get a 404).
 *
 * Anyone, signed in or not, can ask to be invited: a name, an email (theirs, or a
 * relative's they are asking for) and how they know the family. The request waits
 * on the tree's Members page; an owner or editor sends the ordinary invite or
 * declines. The visitor always gets the same answer, so a request never reveals
 * whether an address is already in the tree, or was declined.
 */
import type { Context, Hono } from 'hono'
import { canEdit, canManage, clean, grantable, inviteRole, newId, type InviteRole, type Role, type Store, type Tree, type User } from './db.js'
import * as html from './html.js'
import { csrfField, esc, layout, type Ctx } from './html.js'
import { validEmail, type Mail } from './auth.js'
import { asCircle, CIRCLES, type Circle, type Network } from './network.js'

export type JoinRequest = { id: string; tree_id: string; name: string; email: string; circle: Circle; note: string | null; created_at: number }
export type Listed = { id: string; name: string; listing: string | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL, circle TEXT NOT NULL DEFAULT 'family', note TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER, decision TEXT, decided_by TEXT
);
CREATE INDEX IF NOT EXISTS join_requests_tree ON join_requests(tree_id, decided_at, created_at);
`

const CIRCLE_WORDS: Record<Circle, string> = { family: 'Family', friends: 'A friend', neighbors: 'A neighbor', business: 'Business' }

export class Listings {
  constructor(
    readonly store: Store,
    private now = () => Date.now(),
  ) {
    store.db.exec(SCHEMA)
    // SQLite has no ADD COLUMN IF NOT EXISTS.
    const cols = store.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('trees')").all().map((c) => c.name)
    if (!cols.includes('listed')) store.db.run('ALTER TABLE trees ADD COLUMN listed INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('listing')) store.db.run('ALTER TABLE trees ADD COLUMN listing TEXT')
  }

  /** What strangers may see of a tree, or null when it is not listed. */
  listed(treeId: string): Listed | null {
    return this.store.db.query<Listed, [string]>('SELECT id, name, listing FROM trees WHERE id = ? AND listed = 1').get(treeId) ?? null
  }

  directory(q = '', limit = 200): Listed[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
    return this.store.db
      .query<Listed, []>('SELECT id, name, listing FROM trees WHERE listed = 1 ORDER BY lower(name)')
      .all()
      .filter((t) => words.every((w) => `${t.name} ${t.listing ?? ''}`.toLowerCase().includes(w)))
      .slice(0, limit)
  }

  setListing(treeId: string, listed: boolean, listing: string | null) {
    this.store.db.query('UPDATE trees SET listed = ?, listing = ? WHERE id = ?').run(listed ? 1 : 0, clean(listing, 1000), treeId)
  }

  settings(treeId: string): { listed: boolean; listing: string | null } {
    const r = this.store.db.query<{ listed: number; listing: string | null }, [string]>('SELECT listed, listing FROM trees WHERE id = ?').get(treeId)
    return { listed: Boolean(r?.listed), listing: r?.listing ?? null }
  }

  /**
   * File a request. Returns it when it is new and worth telling the family about;
   * null when this address already has one waiting, is a member, or is already invited.
   */
  request(treeId: string, input: Record<string, unknown>): JoinRequest | null {
    const email = validEmail(input.email)
    const name = clean(input.name, 120)
    if (!email || !name) throw new Error('give a name and an email')
    const user = this.store.userByEmail(email)
    if (user && this.store.role(treeId, user.id)) return null
    if (this.store.pendingInvites(treeId).some((i) => i.email === email)) return null
    if (this.store.db.query('SELECT 1 FROM join_requests WHERE tree_id = ? AND email = ? AND decided_at IS NULL').get(treeId, email)) return null
    const id = newId()
    this.store.db.query('INSERT INTO join_requests (id,tree_id,name,email,circle,note,created_at) VALUES (?,?,?,?,?,?,?)').run(id, treeId, name, email, asCircle(input.circle ?? 'family'), clean(input.note, 1000), this.now())
    return this.get(treeId, id)
  }

  get(treeId: string, id: string): JoinRequest | null {
    return this.store.db.query<JoinRequest, [string, string]>('SELECT id,tree_id,name,email,circle,note,created_at FROM join_requests WHERE tree_id = ? AND id = ? AND decided_at IS NULL').get(treeId, id) ?? null
  }

  waiting(treeId: string): JoinRequest[] {
    return this.store.db.query<JoinRequest, [string]>('SELECT id,tree_id,name,email,circle,note,created_at FROM join_requests WHERE tree_id = ? AND decided_at IS NULL ORDER BY created_at').all(treeId)
  }

  decide(treeId: string, id: string, decision: 'invited' | 'declined', by: string) {
    this.store.db.query('UPDATE join_requests SET decided_at = ?, decision = ?, decided_by = ? WHERE tree_id = ? AND id = ? AND decided_at IS NULL').run(this.now(), decision, by, treeId, id)
  }
}

// ---- pages -------------------------------------------------------------------

const SAME_ANSWER = 'Thanks. Your request is with the family. If they know you, an invite will arrive by email.'

export function directoryPage(ctx: Ctx, trees: Listed[], q: string, more = ''): string {
  return layout(
    ctx,
    'Find your family',
    `<h1>Find your family</h1>
<p class="muted">Families who chose to be found. Every tree here is private: you see its name and a note from the family, never the people in it. Ask, and the family decides whether to invite you.</p>
<form class="search" method="get" action="/families"><input name="q" value="${esc(q)}" placeholder="A surname, a town, a family name" aria-label="Search families"><button>Search</button></form>
${trees.length ? `<ul class="families">${trees.map((t) => `<li><a href="/families/${t.id}"><b>${esc(t.name)}</b></a>${t.listing ? `<br><span class="muted small">${esc(t.listing)}</span>` : ''}</li>`).join('')}</ul>` : `<p class="empty">${q ? 'No listed family matches that.' : 'No families listed yet.'}</p>`}${more}`,
    { crumbs: [['', 'Families']] },
  )
}

export function listingPage(ctx: Ctx, t: Listed, opts: { sent?: boolean; error?: string | null } = {}): string {
  const me = ctx.user
  return layout(
    ctx,
    t.name,
    `<h1>${esc(t.name)}</h1>
${t.listing ? `<div class="notes">${esc(t.listing).replace(/\n/g, '<br>')}</div>` : ''}
<p class="muted small">This family tree is private. Only the people the family invites can see it.</p>
${
  opts.sent
    ? `<div class="panel"><p>${SAME_ANSWER}</p></div>`
    : `<form method="post" action="/families/${t.id}/request" class="panel pform">${csrfField(ctx)}<h2>Ask for an invite</h2>
${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ''}
<div class="grid3"><label>Name<input name="name" maxlength="120" required value="${esc(me?.name ?? '')}"></label><label>Email <span class="muted small">yours, or a relative's</span><input name="email" type="email" required value="${esc(me?.email && !me.email.endsWith('@pit.invalid') ? me.email : '')}"></label><label>You are<select name="circle">${CIRCLES.map((c) => `<option value="${c}">${CIRCLE_WORDS[c]}</option>`).join('')}</select></label></div>
<label>How you know the family (optional)<input name="note" maxlength="1000" placeholder="Rose's grandson, from the Chicago side"></label>
<label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>
<p class="muted small">Only the family sees this. The invite, if they send one, goes to that email.</p><button>Ask for an invite</button></form>`
}`,
    { crumbs: [['/families', 'Families'], ['', t.name]] },
  )
}

/** On the Members page: the owner's listing switch, and requests waiting for an answer. */
export function listingPanel(ctx: Ctx, tree: Tree, role: Role, settings: { listed: boolean; listing: string | null }, waiting: JoinRequest[], site: string): string {
  const owner = canManage(role)
  const requests = canEdit(role) && waiting.length
    ? `<section class="panel"><h2>Asking to join</h2><ul>${waiting
        .map(
          (r) =>
            `<li><b>${esc(r.name)}</b> <span class="muted small">${esc(r.email)} · ${esc(CIRCLE_WORDS[r.circle])} · ${new Date(r.created_at).toISOString().slice(0, 10)}</span>${r.note ? `<br><span class="small">${esc(r.note)}</span>` : ''}
<form method="post" action="/t/${tree.id}/requests/${r.id}/invite" class="inline">${csrfField(ctx)}${grantable(role).length > 1 ? `<select name="role" aria-label="Role">${grantable(role).map((x) => `<option${x === 'viewer' ? ' selected' : ''}>${x}</option>`).join('')}</select> ` : ''}<button class="btn">Invite</button></form><form method="post" action="/t/${tree.id}/requests/${r.id}/decline" class="inline">${csrfField(ctx)}<button class="btn">Decline</button></form></li>`,
        )
        .join('')}</ul><p class="muted small">Declining sends nothing; they are never told.</p></section>`
    : ''
  const listing = owner
    ? `<form method="post" action="/t/${tree.id}/listing" class="panel pform">${csrfField(ctx)}<h2>Public listing</h2>
<p class="muted small">Listed families appear at <a href="/families">/families</a> with this tree's name and the note below, nothing else: no people, no names, no members. Anyone can ask for an invite; you decide. The tree stays private either way.</p>
<label class="check"><input type="checkbox" name="listed" value="1"${settings.listed ? ' checked' : ''}> List ${esc(tree.name)} publicly</label>
<label>A note for people looking for you <span class="muted small">public; no names you would not put on a mailbox</span><textarea name="listing" rows="2" maxlength="1000" placeholder="The Ettingers of Chicago and Sacramento. Family, ask and we'll add you.">${esc(settings.listing ?? '')}</textarea></label>
${settings.listed ? `<p class="small">Public page: <a href="/families/${tree.id}">${esc(site)}/families/${tree.id}</a></p>` : ''}<button>Save</button></form>`
    : ''
  return requests + listing
}

// ---- routes ------------------------------------------------------------------

export type ListingDeps = {
  store: Store
  listings: Listings
  net: Network
  site: string
  ctx: (c: Context, extra?: Partial<Ctx>) => Ctx
  form: (c: Context) => Promise<Record<string, any>>
  treeFor: (c: Context, need?: 'view' | 'edit' | 'manage' | 'owner') => { error: Response } | { error?: undefined; tree: Tree; role: Role; user: User }
  mail: (m: Mail) => Promise<void>
  /** More of the directory under the families (listed businesses, src/team.ts). */
  more?: (q: string) => string
  /** The caller's address, for the request limits. */
  ip: (c: Context) => string
  /** Requests per key: an address, a tree, an email. */
  limit: (key: string) => boolean
  inviteToTree: (from: User, treeId: string, email: string, role: InviteRole, opts?: { personId?: string | null; note?: string | null; name?: string | null }) => Promise<{ url: string; mailed: boolean }>
}

export function mountListings(app: Hono<any>, api: Hono<any>, d: ListingDeps) {
  const { store, listings, net, site } = d
  const notFound = (c: Context) => c.html(html.messagePage(d.ctx(c), 'Not found', 'No listed family by that id.'), 404)

  /** File it and tell the owner. Spam, repeats and members all get the same quiet answer. */
  async function ask(c: Context, treeId: string, body: Record<string, any>): Promise<void> {
    if (String(body.website ?? '').trim()) return // the field people never see
    const email = validEmail(body.email)
    if (!d.limit(`ip:${d.ip(c)}`) || !d.limit(`tree:${treeId}`) || (email && !d.limit(`email:${email}`))) return
    const req = listings.request(treeId, body)
    const tree = store.tree(treeId)
    const owner = tree ? store.user(tree.owner_id) : null
    if (!req || !tree || !owner) return
    const url = `${site}/t/${tree.id}/members`
    d.mail({
      to: owner.email,
      subject: `${req.name} asked to join ${tree.name}`,
      text: `${req.name} (${req.email}) asked for an invite to ${tree.name}, as ${CIRCLE_WORDS[req.circle].toLowerCase()}.${req.note ? `\n\n"${req.note}"` : ''}\n\nInvite or decline: ${url}\n\nDeclining sends them nothing.`,
      html: `<p><b>${esc(req.name)}</b> (${esc(req.email)}) asked for an invite to ${esc(tree.name)}, as ${esc(CIRCLE_WORDS[req.circle].toLowerCase())}.</p>${req.note ? `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#444">${esc(req.note)}</blockquote>` : ''}<p><a href="${esc(url)}">Invite or decline</a></p><p style="color:#666;font-size:13px">Declining sends them nothing.</p>`,
    }).catch((error) => console.error(`[listing] notify failed: ${(error as Error).message}`))
  }

  /** The ordinary invite, as a viewer, and they land in the inviter's network in the circle they gave. */
  async function invite(u: User, tree: Tree, id: string, role: InviteRole = 'viewer'): Promise<string> {
    const req = listings.get(tree.id, id)
    if (!req) return 'That request was already answered.'
    const r = await d.inviteToTree(u, tree.id, req.email, role, { name: req.name })
    listings.decide(tree.id, id, 'invited', u.id)
    const contact = net.contactByEmail(u.id, req.email)
    if (contact && contact.circle !== req.circle) net.updateContact(u.id, contact.id, { circle: req.circle })
    return r.mailed ? `Invite emailed to ${req.email}.` : 'That is a day of invitations; try again tomorrow.'
  }

  app.get('/families', (c) => {
    const q = (c.req.query('q') ?? '').slice(0, 200)
    return c.html(directoryPage(d.ctx(c), listings.directory(q), q, d.more?.(q) ?? ''))
  })
  app.get('/families/:tree', (c) => {
    const t = listings.listed(c.req.param('tree'))
    return t ? c.html(listingPage(d.ctx(c), t, { sent: c.req.query('sent') === '1' })) : notFound(c)
  })
  app.post('/families/:tree/request', async (c) => {
    const t = listings.listed(c.req.param('tree'))
    if (!t) return notFound(c)
    const body = await d.form(c)
    if (!String(body.website ?? '').trim() && (!validEmail(body.email) || !clean(body.name, 120))) return c.html(listingPage(d.ctx(c), t, { error: 'Give a name and an email.' }), 400)
    await ask(c, t.id, body)
    return c.redirect(`/families/${t.id}?sent=1`)
  })
  app.post('/t/:tree/listing', async (c) => {
    const t = d.treeFor(c, 'manage')
    if (t.error) return t.error
    const body = await d.form(c)
    listings.setListing(t.tree.id, body.listed === '1', body.listing ? String(body.listing) : null)
    return c.redirect(`/t/${t.tree.id}/members?ok=${encodeURIComponent(body.listed === '1' ? 'Listed. Strangers see the name and your note, nothing else.' : 'Not listed.')}`)
  })
  app.post('/t/:tree/requests/:id/invite', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await d.form(c)
    return c.redirect(`/t/${t.tree.id}/members?ok=${encodeURIComponent(await invite(t.user, t.tree, c.req.param('id')!, inviteRole(t.role, body.role)))}`)
  })
  app.post('/t/:tree/requests/:id/decline', (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    listings.decide(t.tree.id, c.req.param('id')!, 'declined', t.user.id)
    return c.redirect(`/t/${t.tree.id}/members?ok=Declined`)
  })

  // ---- /api/v1 ---------------------------------------------------------------

  const json = async (c: Context): Promise<Record<string, any>> => ((await c.req.json().catch(() => ({}))) as Record<string, any>) ?? {}

  api.get('/families', (c) => c.json({ families: listings.directory(c.req.query('q') ?? '') }))
  api.post('/families/:tree/request', async (c) => {
    const t = listings.listed(c.req.param('tree')!)
    if (!t) return c.json({ error: 'no listed family by that id' }, 404)
    const body = await json(c)
    if (!validEmail(body.email) || !clean(body.name, 120)) return c.json({ error: 'give a name and an email' }, 400)
    await ask(c, t.id, body)
    return c.json({ result: SAME_ANSWER }, 202)
  })
  api.get('/trees/:tree/listing', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    return c.json({ ...listings.settings(t.tree.id), url: `${site}/families/${t.tree.id}` })
  })
  api.post('/trees/:tree/listing', async (c) => {
    const t = d.treeFor(c, 'manage')
    if (t.error) return t.error
    const body = await json(c)
    const now = listings.settings(t.tree.id)
    listings.setListing(t.tree.id, body.listed === undefined ? now.listed : Boolean(body.listed), body.listing === undefined ? now.listing : body.listing ? String(body.listing) : null)
    return c.json({ ...listings.settings(t.tree.id), url: `${site}/families/${t.tree.id}` })
  })
  api.get('/trees/:tree/requests', (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    return c.json({ requests: listings.waiting(t.tree.id) })
  })
  api.post('/trees/:tree/requests/:id/invite', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    if (!listings.get(t.tree.id, c.req.param('id')!)) return c.json({ error: 'no such request waiting' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { role?: string }
    return c.json({ result: await invite(t.user, t.tree, c.req.param('id')!, inviteRole(t.role, body.role)) })
  })
  api.post('/trees/:tree/requests/:id/decline', (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    listings.decide(t.tree.id, c.req.param('id')!, 'declined', t.user.id)
    return c.json({ ok: true })
  })
}
