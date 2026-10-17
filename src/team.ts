/**
 * A business's team: the people who work there, with accounts of their own.
 *
 * A business lives inside a family tree, and its founders and owners are people
 * in that tree. Employees are usually not family. They get their own way in: an
 * invite to the business, not to the tree. A team member sees the business page
 * at /w/:business (what it is, where, its website, and the team) and nothing of
 * the tree: no people, no family notes, no roles held by relatives.
 *
 * Tree editors and up run the team from the business page: invite by email with a
 * role and title, remove people. A business can also be listed at /families with
 * a public note, and anyone can ask to join the team with a name and an email;
 * the answer is always the same, and the family decides.
 */
import type { Context, Hono } from 'hono'
import { BUSINESS_ROLES, businessRole, canEdit, canManage, clean, newId, sha256, type Business, type Role, type Store, type Tree, type User } from './db.js'
import * as html from './html.js'
import { csrfField, esc, layout, signInForm, type Ctx } from './html.js'
import { validEmail, type Mail } from './auth.js'
import type { Network } from './network.js'

export type TeamMember = { user_id: string; name: string | null; email: string; role: string; title: string | null; created_at: number }
export type TeamInvite = { business_id: string; tree_id: string; email: string; role: string; title: string | null; note: string | null; created_by: string; expires_at: number }
export type ListedBusiness = { id: string; name: string; category: string | null; place: string | null; listing: string | null }
export type TeamRequest = { id: string; business_id: string; name: string; email: string; role: string; note: string | null; created_at: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS business_members (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'employee', title TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX IF NOT EXISTS business_members_user ON business_members(user_id);
CREATE TABLE IF NOT EXISTS business_invites (
  token_hash TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  tree_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, title TEXT, note TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT
);
CREATE TABLE IF NOT EXISTS business_requests (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'employee', note TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER, decision TEXT, decided_by TEXT
);
`

const roleWord = (role: string) => (BUSINESS_ROLES[role] ?? 'Employee').toLowerCase()
const anA = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`)
/** "an employee (Operations)" */
const asWhat = (role: string, title: string | null) => `${anA(roleWord(role))}${title ? ` (${title})` : ''}`
/** What someone can join a team as. Founder and investor are history, recorded in the tree. */
export const TEAM_ROLES = ['employee', 'manager', 'officer', 'partner', 'owner', 'apprentice', 'other'] as const
const teamRole = (value: unknown) => {
  const r = businessRole(value ?? 'employee')
  return r && (TEAM_ROLES as readonly string[]).includes(r) ? r : 'employee'
}

export class Teams {
  constructor(
    readonly store: Store,
    private now = () => Date.now(),
  ) {
    store.db.exec(SCHEMA)
    const cols = store.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('businesses')").all().map((c) => c.name)
    if (!cols.includes('listed')) store.db.run('ALTER TABLE businesses ADD COLUMN listed INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('listing')) store.db.run('ALTER TABLE businesses ADD COLUMN listing TEXT')
  }

  /** A business by id alone, for pages outside its tree. */
  business(id: string): Business | null {
    return this.store.db.query<Business, [string]>('SELECT * FROM businesses WHERE id = ?').get(id) ?? null
  }

  members(businessId: string): TeamMember[] {
    return this.store.db
      .query<TeamMember, [string]>('SELECT m.user_id, u.name, u.email, m.role, m.title, m.created_at FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = ? ORDER BY m.created_at')
      .all(businessId)
  }

  /**
   * Who runs it, as a team member sees them: people in the tree with a current
   * leading role (owner, founder, partner, officer, manager) who have an account.
   * Their account name only; relatives without accounts, investors and the rest stay in the tree.
   */
  leaders(businessId: string): TeamMember[] {
    const rows = this.store.db
      .query<TeamMember, [string]>(
        `SELECT u.id AS user_id, u.name, u.email, r.role, r.title, r.created_at FROM business_roles r
         JOIN profiles p ON p.tree_id = r.tree_id AND p.person_id = r.person_id JOIN users u ON u.id = p.user_id
         WHERE r.business_id = ? AND r.end_date IS NULL AND r.role IN ('owner','founder','partner','officer','manager') ORDER BY r.created_at`,
      )
      .all(businessId)
    const seen = new Set<string>()
    return rows.filter((r) => !seen.has(r.user_id) && seen.add(r.user_id))
  }

  /** Leaders first, then the team; one line per person. */
  everyone(businessId: string): TeamMember[] {
    const leaders = this.leaders(businessId)
    return [...leaders, ...this.members(businessId).filter((m) => !leaders.some((l) => l.user_id === m.user_id))]
  }

  member(businessId: string, userId: string): TeamMember | null {
    return this.members(businessId).find((m) => m.user_id === userId) ?? null
  }

  /** Businesses this user is on the team of. */
  workplaces(userId: string): (Business & { role: string; title: string | null })[] {
    return this.store.db.query<Business & { role: string; title: string | null }, [string]>('SELECT b.*, m.role, m.title FROM business_members m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = ? ORDER BY lower(b.name)').all(userId)
  }

  addMember(businessId: string, userId: string, role: string, title: string | null) {
    this.store.db.query('INSERT INTO business_members (business_id,user_id,role,title,created_at) VALUES (?,?,?,?,?) ON CONFLICT(business_id,user_id) DO UPDATE SET role = excluded.role, title = COALESCE(excluded.title, business_members.title)').run(businessId, userId, teamRole(role), clean(title, 200), this.now())
  }

  removeMember(businessId: string, userId: string) {
    this.store.db.query('DELETE FROM business_members WHERE business_id = ? AND user_id = ?').run(businessId, userId)
  }

  createInvite(b: Business, from: string, email: string, role: unknown, title: unknown, note: unknown, days = 14): string {
    const token = newId(18)
    this.store.db
      .query('INSERT INTO business_invites (token_hash,business_id,tree_id,email,role,title,note,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(sha256(token), b.id, b.tree_id, email.trim().toLowerCase(), teamRole(role), clean(title, 200), clean(note, 1000), from, this.now(), this.now() + days * 86_400_000)
    return token
  }

  invite(token: string): TeamInvite | null {
    const r = this.store.db.query<TeamInvite & { used_by: string | null }, [string, number]>('SELECT * FROM business_invites WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?').get(sha256(token), this.now())
    return r ?? null
  }

  pendingInvites(businessId: string): TeamInvite[] {
    return this.store.db.query<TeamInvite, [string, number]>('SELECT * FROM business_invites WHERE business_id = ? AND used_by IS NULL AND expires_at > ? ORDER BY created_at').all(businessId, this.now())
  }

  accept(token: string, user: User): TeamInvite | null {
    const inv = this.invite(token)
    if (!inv || !this.business(inv.business_id)) return null
    this.store.tx(() => {
      this.addMember(inv.business_id, user.id, inv.role, inv.title)
      this.store.db.query('UPDATE business_invites SET used_by = ? WHERE token_hash = ?').run(user.id, sha256(token))
    })
    return inv
  }

  // ---- listing -------------------------------------------------------------

  setListing(businessId: string, listed: boolean, listing: string | null) {
    this.store.db.query('UPDATE businesses SET listed = ?, listing = ? WHERE id = ?').run(listed ? 1 : 0, clean(listing, 1000), businessId)
  }

  settings(businessId: string): { listed: boolean; listing: string | null } {
    const r = this.store.db.query<{ listed: number; listing: string | null }, [string]>('SELECT listed, listing FROM businesses WHERE id = ?').get(businessId)
    return { listed: Boolean(r?.listed), listing: r?.listing ?? null }
  }

  listed(businessId: string): ListedBusiness | null {
    return this.store.db.query<ListedBusiness, [string]>('SELECT id, name, category, place, listing FROM businesses WHERE id = ? AND listed = 1').get(businessId) ?? null
  }

  directory(q = '', limit = 200): ListedBusiness[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
    return this.store.db
      .query<ListedBusiness, []>('SELECT id, name, category, place, listing FROM businesses WHERE listed = 1 ORDER BY lower(name)')
      .all()
      .filter((b) => words.every((w) => [b.name, b.category, b.place, b.listing].filter(Boolean).join(' ').toLowerCase().includes(w)))
      .slice(0, limit)
  }

  /** A new request worth telling the family about, or null (already on the team, invited, or asked). */
  request(businessId: string, input: Record<string, unknown>): TeamRequest | null {
    const email = validEmail(input.email)
    const name = clean(input.name, 120)
    if (!email || !name) throw new Error('give a name and an email')
    const user = this.store.userByEmail(email)
    if (user && this.member(businessId, user.id)) return null
    if (this.pendingInvites(businessId).some((i) => i.email === email)) return null
    if (this.store.db.query('SELECT 1 FROM business_requests WHERE business_id = ? AND email = ? AND decided_at IS NULL').get(businessId, email)) return null
    const id = newId()
    this.store.db.query('INSERT INTO business_requests (id,business_id,name,email,role,note,created_at) VALUES (?,?,?,?,?,?,?)').run(id, businessId, name, email, teamRole(input.role), clean(input.note, 1000), this.now())
    return this.requestById(businessId, id)
  }

  requestById(businessId: string, id: string): TeamRequest | null {
    return this.store.db.query<TeamRequest, [string, string]>('SELECT id,business_id,name,email,role,note,created_at FROM business_requests WHERE business_id = ? AND id = ? AND decided_at IS NULL').get(businessId, id) ?? null
  }

  waiting(businessId: string): TeamRequest[] {
    return this.store.db.query<TeamRequest, [string]>('SELECT id,business_id,name,email,role,note,created_at FROM business_requests WHERE business_id = ? AND decided_at IS NULL ORDER BY created_at').all(businessId)
  }

  decide(businessId: string, id: string, decision: 'invited' | 'declined', by: string) {
    this.store.db.query('UPDATE business_requests SET decided_at = ?, decision = ?, decided_by = ? WHERE business_id = ? AND id = ? AND decided_at IS NULL').run(this.now(), decision, by, businessId, id)
  }
}

// ---- pages -------------------------------------------------------------------

const SAME_ANSWER = 'Thanks. Your request is with the business. If they know you, an invite will arrive by email.'
const roleOptions = (current = 'employee') => TEAM_ROLES.map((r) => `<option value="${r}"${r === current ? ' selected' : ''}>${BUSINESS_ROLES[r]}</option>`).join('')
const memberLine = (m: Pick<TeamMember, 'name' | 'email' | 'role' | 'title'>, showEmail: boolean) =>
  `<b>${esc(m.name ?? (showEmail ? m.email : 'A member'))}</b> <span class="muted small">${esc([m.title, BUSINESS_ROLES[m.role] ?? m.role].filter(Boolean).join(' · '))}${showEmail && m.name ? ` · ${esc(m.email)}` : ''}</span>`

/** On the business page inside the tree: the team, invites, requests and the listing switch. */
export function teamPanel(ctx: Ctx, tree: Tree, role: Role, b: Business, data: { members: TeamMember[]; pending: TeamInvite[]; waiting: TeamRequest[]; settings: { listed: boolean; listing: string | null } }): string {
  const edit = canEdit(role)
  const base = `/t/${tree.id}/b/${b.id}/team`
  const list = data.members.length
    ? `<ul>${data.members.map((m) => `<li>${memberLine(m, edit)}${edit ? ` <form method="post" action="${base}/${m.user_id}/remove" class="inline" data-confirm="Remove ${esc(m.name ?? m.email)} from the team?">${csrfField(ctx)}<button class="x" title="Remove">×</button></form>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">Nobody on the team yet.</p>'
  const pending = edit && data.pending.length ? `<p class="muted small">Invited: ${data.pending.map((i) => `${esc(i.email)} (${esc(roleWord(i.role))})`).join(', ')}</p>` : ''
  const invite = edit
    ? `<details class="mini"><summary>Invite someone to the team</summary><form method="post" action="${base}/invite" class="pform">${csrfField(ctx)}
<div class="grid3"><label>Their email<input name="email" type="email" required></label><label>As<select name="role">${roleOptions()}</select></label><label>Title <span class="muted small">optional</span><input name="title" maxlength="200" placeholder="Operations"></label></div>
<label>A line from you (optional)<input name="note" maxlength="1000"></label>
<p class="muted small">They join ${esc(b.name)}, not the family tree: they see this business and its team, nothing else.</p><button>Email an invite</button></form></details>`
    : ''
  const requests = edit && data.waiting.length
    ? `<h3>Asking to join</h3><ul>${data.waiting.map((r) => `<li><b>${esc(r.name)}</b> <span class="muted small">${esc(r.email)} · ${esc(BUSINESS_ROLES[r.role] ?? r.role)}</span>${r.note ? `<br><span class="small">${esc(r.note)}</span>` : ''}<form method="post" action="${base}/requests/${r.id}/invite" class="inline">${csrfField(ctx)}<button class="btn">Invite</button></form><form method="post" action="${base}/requests/${r.id}/decline" class="inline">${csrfField(ctx)}<button class="btn">Decline</button></form></li>`).join('')}</ul>`
    : ''
  const listing = canManage(role)
    ? `<details class="mini"><summary>Public listing${data.settings.listed ? ' · listed' : ''}</summary><form method="post" action="${base}/listing" class="pform">${csrfField(ctx)}
<p class="muted small">Listed businesses appear at <a href="/families">/families</a> with the name, what it does, the place and your note. Anyone can ask to join the team; you decide.</p>
<label class="check"><input type="checkbox" name="listed" value="1"${data.settings.listed ? ' checked' : ''}> List ${esc(b.name)} publicly</label>
<label>A note for people looking for you<textarea name="listing" rows="2" maxlength="1000">${esc(data.settings.listing ?? '')}</textarea></label>${data.settings.listed ? `<p class="small"><a href="/families/b/${b.id}">Public page</a></p>` : ''}<button>Save</button></form></details>`
    : ''
  return `<section class="panel"><h2>Team</h2>${list}${pending}${invite}${requests}${listing}</section>`
}

/** What a team member sees: the business and its team. Nothing from the tree. */
export function workplacePage(ctx: Ctx, b: Business, members: TeamMember[], me: TeamMember): string {
  const facts = [
    ['What', b.category],
    ['Where', b.place],
    ['Founded', b.founded],
  ].filter(([, v]) => v)
  return layout(
    ctx,
    b.name,
    `<h1>${esc(b.name)}</h1><p class="muted">You are ${esc(asWhat(me.role, me.title))} here.</p>
${facts.map(([k, v]) => `<p><b>${k}</b> ${esc(v)}</p>`).join('')}${b.website ? `<p><a href="${esc(b.website)}" rel="noopener noreferrer" target="_blank">${esc(b.website.replace(/^https?:\/\//, ''))}</a></p>` : ''}
<section><h2>The team</h2><ul>${members.map((m) => `<li>${memberLine(m, false)}</li>`).join('')}</ul></section>
<p class="muted small">Message a teammate from your <a href="/inbox">Inbox</a> once you are connected.</p>`,
    { crumbs: [['/work', 'Work'], ['', b.name]] },
  )
}

export function workPage(ctx: Ctx, places: (Business & { role: string; title: string | null })[]): string {
  return layout(
    ctx,
    'Work',
    `<h1>Where you work</h1>${places.length ? `<ul class="families">${places.map((b) => `<li><a href="/w/${b.id}"><b>${esc(b.name)}</b></a> <span class="muted small">${esc([b.title, BUSINESS_ROLES[b.role]].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>` : '<p class="empty">No business has added you to its team yet.</p>'}`,
    { crumbs: [['', 'Work']] },
  )
}

export function teamInvitePage(ctx: Ctx, b: Business, inv: TeamInvite, from: User | null, token: string): string {
  const who = from ? esc(from.name ?? from.email) : 'Someone'
  const as = asWhat(inv.role, inv.title)
  return layout(
    ctx,
    `Join ${b.name}`,
    `<h1>Join ${esc(b.name)}</h1><p>${who} invited you to the team at <b>${esc(b.name)}</b>, as ${esc(as)}.</p>${inv.note ? `<blockquote class="notes">${esc(inv.note)}</blockquote>` : ''}
${ctx.user ? `<form method="post" action="/team/invite/${esc(token)}">${csrfField(ctx)}<button>Join as ${esc(ctx.user.email)}</button></form>` : `<p>Sign in or sign up first; you'll come straight back here.</p>${signInForm(ctx, `/team/invite/${token}`)}`}`,
  )
}

export function businessListingPage(ctx: Ctx, b: ListedBusiness, opts: { sent?: boolean; error?: string | null } = {}): string {
  const me = ctx.user
  return layout(
    ctx,
    b.name,
    `<h1>${esc(b.name)}</h1><p class="muted">${esc([b.category, b.place].filter(Boolean).join(' · '))}</p>
${b.listing ? `<div class="notes">${esc(b.listing).replace(/\n/g, '<br>')}</div>` : ''}
${
  opts.sent
    ? `<div class="panel"><p>${SAME_ANSWER}</p></div>`
    : `<form method="post" action="/families/b/${b.id}/request" class="panel pform">${csrfField(ctx)}<h2>Ask to join the team</h2>${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ''}
<div class="grid3"><label>Name<input name="name" maxlength="120" required value="${esc(me?.name ?? '')}"></label><label>Email<input name="email" type="email" required value="${esc(me?.email && !me.email.endsWith('@pit.invalid') ? me.email : '')}"></label><label>As<select name="role">${roleOptions()}</select></label></div>
<label>Who you are (optional)<input name="note" maxlength="1000" placeholder="I started in support in May"></label>
<label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>
<button>Ask to join</button></form>`
}`,
    { crumbs: [['/families', 'Families'], ['', b.name]] },
  )
}

/** The businesses half of /families. */
export function businessDirectory(list: ListedBusiness[]): string {
  return list.length ? `<h2>Businesses</h2><ul class="families">${list.map((b) => `<li><a href="/families/b/${b.id}"><b>${esc(b.name)}</b></a> <span class="muted small">${esc([b.category, b.place].filter(Boolean).join(' · '))}</span>${b.listing ? `<br><span class="muted small">${esc(b.listing)}</span>` : ''}</li>`).join('')}</ul>` : ''
}

// ---- routes ------------------------------------------------------------------

export type TeamDeps = {
  store: Store
  teams: Teams
  net: Network
  site: string
  ctx: (c: Context, extra?: Partial<Ctx>) => Ctx
  form: (c: Context) => Promise<Record<string, any>>
  treeFor: (c: Context, need?: 'view' | 'edit' | 'owner' | 'manage') => { error: Response } | { error?: undefined; tree: Tree; role: Role; user: User }
  mail: (m: Mail) => Promise<void>
  ip: (c: Context) => string
  /** Invitations per sender (the same daily allowance as tree invites). */
  inviteLimit: (key: string) => boolean
  /** Requests per key: an address, a business, an email. */
  askLimit: (key: string) => boolean
}

export function mountTeams(app: Hono<any>, api: Hono<any>, d: TeamDeps) {
  const { store, teams, net, site } = d
  const user = (c: Context) => c.get('user') as User | null
  const flash = (path: string, message: string) => `${path}?ok=${encodeURIComponent(message)}`
  const who = (u: Pick<User, 'name' | 'email'>) => u.name ?? u.email

  /** The business in this tree, for a member of the tree with at least `need`. */
  const bizFor = (c: Context, need: 'view' | 'edit' | 'manage' = 'view') => {
    const t = d.treeFor(c, need === 'view' ? 'view' : need === 'edit' ? 'edit' : 'manage')
    if (t.error) return { error: t.error }
    const b = store.business(t.tree.id, c.req.param('biz')!)
    if (!b) return { error: c.req.path.startsWith('/api/') ? c.json({ error: 'no such business' }, 404) : c.html(html.messagePage(d.ctx(c), 'Not found', 'No business by that id in this tree.'), 404) }
    return { ...t, b }
  }

  async function inviteToTeam(from: User, b: Business, email: string, role: unknown, title: unknown, note: unknown): Promise<string> {
    if (!d.inviteLimit(`invite:${from.id}`) || !d.inviteLimit(`to:${email}`)) return 'That is a lot of invitations for one day. Try again tomorrow.'
    const token = teams.createInvite(b, from.id, email, role, title, note)
    const inv = teams.invite(token)!
    const url = `${site}/team/invite/${token}`
    const as = asWhat(inv.role, inv.title)
    net.ensureContact(from.id, email, { name: '', circle: 'business', company: b.name, title: inv.title })
    try {
      await d.mail({
        to: email,
        subject: `${who(from)} invited you to join ${b.name}`,
        text: `${who(from)} invited you to the team at ${b.name} on family.ancestry, as ${as}.${inv.note ? `\n\n"${inv.note}"` : ''}\n\nJoin: ${url}\n\nThe link works once and expires in 14 days.`,
        html: `<p><b>${esc(who(from))}</b> invited you to the team at <b>${esc(b.name)}</b> on family.ancestry, as ${esc(as)}.</p>${inv.note ? `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#444">${esc(inv.note)}</blockquote>` : ''}<p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;background:#3d6b4f;color:#fff;border-radius:6px;text-decoration:none">Join ${esc(b.name)}</a></p><p style="color:#666;font-size:13px">${esc(url)}<br>The link works once and expires in 14 days.</p>`,
      })
    } catch (error) {
      console.error(`[team] invite mail failed: ${(error as Error).message}`)
    }
    return `Invite emailed to ${email}.`
  }

  async function ask(c: Context, b: ListedBusiness, body: Record<string, any>) {
    if (String(body.website ?? '').trim()) return
    const email = validEmail(body.email)
    if (!d.askLimit(`ip:${d.ip(c)}`) || !d.askLimit(`tree:b:${b.id}`) || (email && !d.askLimit(`email:${email}`))) return
    const req = teams.request(b.id, body)
    const full = teams.business(b.id)
    const tree = full ? store.tree(full.tree_id) : null
    const owner = tree ? store.user(tree.owner_id) : null
    if (!req || !tree || !owner) return
    const url = `${site}/t/${tree.id}/b/${b.id}`
    d.mail({
      to: owner.email,
      subject: `${req.name} asked to join ${b.name}`,
      text: `${req.name} (${req.email}) asked to join the team at ${b.name}, as ${anA(roleWord(req.role))}.${req.note ? `\n\n"${req.note}"` : ''}\n\nInvite or decline: ${url}\n\nDeclining sends them nothing.`,
      html: `<p><b>${esc(req.name)}</b> (${esc(req.email)}) asked to join the team at ${esc(b.name)}, as ${esc(anA(roleWord(req.role)))}.</p>${req.note ? `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#444">${esc(req.note)}</blockquote>` : ''}<p><a href="${esc(url)}">Invite or decline</a></p>`,
    }).catch((error) => console.error(`[team] request notify failed: ${(error as Error).message}`))
  }

  async function answer(u: User, b: Business, id: string, decision: 'invite' | 'decline'): Promise<string | null> {
    const req = teams.requestById(b.id, id)
    if (!req) return null
    if (decision === 'decline') {
      teams.decide(b.id, id, 'declined', u.id)
      return 'Declined. They are not told.'
    }
    const result = await inviteToTeam(u, b, req.email, req.role, null, null)
    teams.decide(b.id, id, 'invited', u.id)
    return result
  }

  // ---- pages: inside the tree ------------------------------------------------

  app.post('/t/:tree/b/:biz/team/invite', async (c) => {
    const t = bizFor(c, 'edit')
    if (t.error) return t.error
    const body = await d.form(c)
    const email = validEmail(body.email)
    const back = `/t/${t.tree!.id}/b/${t.b!.id}`
    if (!email) return c.redirect(flash(back, 'That does not look like an email address.'))
    return c.redirect(flash(back, await inviteToTeam(t.user!, t.b!, email, body.role, body.title, body.note)))
  })
  app.post('/t/:tree/b/:biz/team/:user/remove', (c) => {
    const t = bizFor(c, 'edit')
    if (t.error) return t.error
    teams.removeMember(t.b!.id, c.req.param('user')!)
    return c.redirect(flash(`/t/${t.tree!.id}/b/${t.b!.id}`, 'Removed from the team'))
  })
  app.post('/t/:tree/b/:biz/team/listing', async (c) => {
    const t = bizFor(c, 'manage')
    if (t.error) return t.error
    const body = await d.form(c)
    teams.setListing(t.b!.id, body.listed === '1', body.listing ? String(body.listing) : null)
    return c.redirect(flash(`/t/${t.tree!.id}/b/${t.b!.id}`, body.listed === '1' ? 'Listed at /families.' : 'Not listed.'))
  })
  for (const decision of ['invite', 'decline'] as const)
    app.post(`/t/:tree/b/:biz/team/requests/:id/${decision}`, async (c) => {
      const t = bizFor(c, 'edit')
      if (t.error) return t.error
      const result = await answer(t.user!, t.b!, c.req.param('id')!, decision)
      return c.redirect(flash(`/t/${t.tree!.id}/b/${t.b!.id}`, result ?? 'That request was already answered.'))
    })

  // ---- pages: the team member's side -----------------------------------------

  app.get('/team/invite/:token', (c) => {
    const inv = teams.invite(c.req.param('token'))
    const b = inv ? teams.business(inv.business_id) : null
    if (!inv || !b) return c.html(html.messagePage(d.ctx(c), 'Invite expired', 'This invite was already used or has expired. Ask for a new one.'), 404)
    return c.html(teamInvitePage(d.ctx(c), b, inv, store.user(inv.created_by), c.req.param('token')))
  })
  app.post('/team/invite/:token', (c) => {
    const u = user(c)
    if (!u) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`)
    const inv = teams.accept(c.req.param('token'), u)
    if (!inv) return c.html(html.messagePage(d.ctx(c), 'Invite expired', 'This invite was already used or has expired. Ask for a new one.'), 404)
    // The person who invited them is someone they know now: connected, filed under business.
    const from = store.user(inv.created_by)
    const b = teams.business(inv.business_id)!
    if (from && from.id !== u.id) {
      net.connect(from.id, u.id)
      net.ensureContact(from.id, u.email, { name: u.name ?? '', circle: 'business', company: b.name }, { linked_user_id: u.id })
      net.ensureContact(u.id, from.email, { name: from.name ?? '', circle: 'business', company: b.name }, { linked_user_id: from.id })
    }
    return c.redirect(flash(`/w/${inv.business_id}`, `Welcome to ${b.name}.`))
  })
  app.get('/work', (c) => {
    const u = user(c)
    if (!u) return c.redirect('/signin?next=/work')
    return c.html(workPage(d.ctx(c), teams.workplaces(u.id)))
  })
  app.get('/w/:biz', (c) => {
    const u = user(c)
    if (!u) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`)
    const b = teams.business(c.req.param('biz'))
    // Family members go to the full page in the tree; teammates get the business only; anyone else, nothing.
    if (b && store.role(b.tree_id, u.id)) return c.redirect(`/t/${b.tree_id}/b/${b.id}`)
    const me = b ? teams.member(b.id, u.id) : null
    if (!b || !me) return c.html(html.messagePage(d.ctx(c), 'Not found', 'No business here.'), 404)
    return c.html(workplacePage(d.ctx(c), b, teams.everyone(b.id), me))
  })

  // ---- pages: public ---------------------------------------------------------

  app.get('/families/b/:biz', (c) => {
    const b = teams.listed(c.req.param('biz'))
    return b ? c.html(businessListingPage(d.ctx(c), b, { sent: c.req.query('sent') === '1' })) : c.html(html.messagePage(d.ctx(c), 'Not found', 'No listed business by that id.'), 404)
  })
  app.post('/families/b/:biz/request', async (c) => {
    const b = teams.listed(c.req.param('biz'))
    if (!b) return c.html(html.messagePage(d.ctx(c), 'Not found', 'No listed business by that id.'), 404)
    const body = await d.form(c)
    if (!String(body.website ?? '').trim() && (!validEmail(body.email) || !clean(body.name, 120))) return c.html(businessListingPage(d.ctx(c), b, { error: 'Give a name and an email.' }), 400)
    await ask(c, b, body)
    return c.redirect(`/families/b/${b.id}?sent=1`)
  })

  // ---- /api/v1 ---------------------------------------------------------------

  const json = async (c: Context): Promise<Record<string, any>> => ((await c.req.json().catch(() => ({}))) as Record<string, any>) ?? {}
  const teamOut = (b: Business, edit: boolean) => ({
    members: teams.members(b.id).map((m) => (edit ? m : { ...m, email: undefined })),
    ...(edit ? { invites: teams.pendingInvites(b.id).map((i) => ({ email: i.email, role: i.role, title: i.title, expires_at: i.expires_at })), requests: teams.waiting(b.id), ...teams.settings(b.id) } : {}),
  })

  api.get('/work', (c) => c.json({ businesses: teams.workplaces(user(c)!.id).map((b) => ({ id: b.id, name: b.name, category: b.category, role: b.role, title: b.title, url: `${site}/w/${b.id}` })) }))
  api.get('/work/:biz', (c) => {
    const b = teams.business(c.req.param('biz')!)
    const me = b ? teams.member(b.id, user(c)!.id) : null
    if (!b || (!me && !store.role(b.tree_id, user(c)!.id))) return c.json({ error: 'no such business' }, 404)
    return c.json({ business: { id: b.id, name: b.name, category: b.category, place: b.place, founded: b.founded, website: b.website }, team: teams.everyone(b.id).map(({ email: _email, ...m }) => m) })
  })
  api.get('/trees/:tree/businesses/:biz/team', (c) => {
    const t = bizFor(c)
    if (t.error) return t.error
    return c.json(teamOut(t.b!, canEdit(t.role)))
  })
  api.post('/trees/:tree/businesses/:biz/team', async (c) => {
    const t = bizFor(c, 'edit')
    if (t.error) return t.error
    const body = await json(c)
    const email = validEmail(body.email)
    if (!email) return c.json({ error: 'give an email' }, 400)
    return c.json({ result: await inviteToTeam(t.user!, t.b!, email, body.role, body.title, body.note) }, 201)
  })
  api.delete('/trees/:tree/businesses/:biz/team/:user', (c) => {
    const t = bizFor(c, 'edit')
    if (t.error) return t.error
    teams.removeMember(t.b!.id, c.req.param('user')!)
    return c.json({ ok: true })
  })
  api.post('/trees/:tree/businesses/:biz/listing', async (c) => {
    const t = bizFor(c, 'manage')
    if (t.error) return t.error
    const body = await json(c)
    const now = teams.settings(t.b!.id)
    teams.setListing(t.b!.id, body.listed === undefined ? now.listed : Boolean(body.listed), body.listing === undefined ? now.listing : body.listing ? String(body.listing) : null)
    return c.json({ ...teams.settings(t.b!.id), url: `${site}/families/b/${t.b!.id}` })
  })
  api.post('/trees/:tree/businesses/:biz/requests/:id/:answer', async (c) => {
    const t = bizFor(c, 'edit')
    if (t.error) return t.error
    const a = c.req.param('answer')
    if (a !== 'invite' && a !== 'decline') return c.json({ error: 'invite or decline' }, 400)
    const result = await answer(t.user!, t.b!, c.req.param('id')!, a)
    return result ? c.json({ result }) : c.json({ error: 'no such request waiting' }, 404)
  })
  api.get('/families/businesses', (c) => c.json({ businesses: teams.directory(c.req.query('q') ?? '') }))
  api.post('/families/b/:biz/request', async (c) => {
    const b = teams.listed(c.req.param('biz')!)
    if (!b) return c.json({ error: 'no listed business by that id' }, 404)
    const body = await json(c)
    if (!validEmail(body.email) || !clean(body.name, 120)) return c.json({ error: 'give a name and an email' }, 400)
    await ask(c, b, body)
    return c.json({ result: SAME_ANSWER }, 202)
  })
}
