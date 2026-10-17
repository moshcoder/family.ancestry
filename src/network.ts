/**
 * Network: the people in your life, kept the way an address book keeps them, plus
 * a private inbox between people who actually know each other.
 *
 * It is an add-on (its own tables, its own routes, mounted next to the trees) that
 * every account gets, free. It is built for family and friends, not for reach:
 *
 *   - contacts are private to whoever saved them; nobody browses anyone's list,
 *   - there are no public profiles, follower counts or "people you may know",
 *   - you can message someone only after you both said yes (a connection) or
 *     you share a family tree, and only one person at a time: no broadcasts,
 *   - anyone can block anyone, and a block ends the conversation both ways,
 *   - invitations and messages are rate-limited per sender.
 *
 * Circles are family, neighbors, friends and business: the same human network, sorted.
 */
import type { Database } from 'bun:sqlite'
import { clean, newId, sha256, type Store, type User } from './db.js'

export type Circle = 'family' | 'neighbors' | 'friends' | 'business'
export const CIRCLES: Circle[] = ['family', 'neighbors', 'friends', 'business']
export const asCircle = (value: unknown): Circle => (CIRCLES.includes(String(value) as Circle) ? (String(value) as Circle) : 'friends')

export type Labeled = { label: string | null; value: string }
export type Address = { label: string | null; lines: string }

export type Contact = {
  id: string
  owner_id: string
  circle: Circle
  name: string
  nickname: string | null
  relationship: string | null
  company: string | null
  title: string | null
  birthday: string | null
  anniversary: string | null
  emails: Labeled[]
  phones: Labeled[]
  addresses: Address[]
  links: Labeled[]
  notes: string | null
  linked_user_id: string | null
  tree_id: string | null
  person_id: string | null
  created_at: number
  updated_at: number
}

export const CONTACT_FIELDS = ['circle', 'name', 'nickname', 'relationship', 'company', 'title', 'birthday', 'anniversary', 'emails', 'phones', 'addresses', 'links', 'notes'] as const

export type Message = { id: string; sender_id: string; recipient_id: string; body: string; created_at: number }
export type Thread = { other: User; last: Message; unread: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  circle TEXT NOT NULL DEFAULT 'friends', name TEXT NOT NULL, nickname TEXT, relationship TEXT,
  company TEXT, title TEXT, birthday TEXT, anniversary TEXT,
  emails TEXT NOT NULL DEFAULT '[]', phones TEXT NOT NULL DEFAULT '[]', addresses TEXT NOT NULL DEFAULT '[]', links TEXT NOT NULL DEFAULT '[]',
  notes TEXT, linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  tree_id TEXT, person_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_owner ON contacts(owner_id, circle, name);
CREATE TABLE IF NOT EXISTS connect_requests (
  token_hash TEXT PRIMARY KEY, from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT, email TEXT NOT NULL, circle TEXT NOT NULL, note TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT
);
CREATE TABLE IF NOT EXISTS connections (
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY (user_a, user_b)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS messages_unread ON messages(recipient_id, read_at);
CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY (user_id, blocked_id)
);
`

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

const parseJson = <T>(text: unknown): T[] => {
  try {
    const v = JSON.parse(String(text ?? '[]'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/**
 * "home: jane@example.com" per line, or a JSON array of {label, value}. The label
 * is optional; a value with no colon-prefixed word is just a value.
 */
export function parseLabeled(input: unknown, max = 20, valueMax = 300): Labeled[] {
  const rows: Labeled[] = Array.isArray(input)
    ? input.map((v: any) => (typeof v === 'string' ? splitLabel(v) : { label: clean(v?.label, 40), value: String(v?.value ?? '') }))
    : String(input ?? '').split(/\r?\n/).map(splitLabel)
  return rows.map((r) => ({ label: clean(r.label, 40), value: clean(r.value, valueMax) ?? '' })).filter((r) => r.value).slice(0, max)
}

function splitLabel(line: string): Labeled {
  // A label is one or two short words before a colon; "https://..." and "+1 (555): x" are not labels.
  const m = line.match(/^\s*([A-Za-z][A-Za-z ]{0,24}):\s*(.+)$/)
  if (m && !/^(https?|mailto|tel)$/i.test(m[1]!.trim())) return { label: m[1]!.trim().toLowerCase(), value: m[2]!.trim() }
  return { label: null, value: line.trim() }
}

/** Addresses: blank-line separated blocks, each optionally starting "home:" on its first line. */
export function parseAddresses(input: unknown, max = 10): Address[] {
  const blocks: Address[] = Array.isArray(input)
    ? input.map((v: any) => ({ label: clean(v?.label, 40), lines: String(v?.lines ?? v?.value ?? '') }))
    : String(input ?? '')
        .split(/\r?\n\s*\r?\n/)
        .map((block) => {
          const first = splitLabel(block.split(/\r?\n/)[0] ?? '')
          const rest = block.split(/\r?\n/).slice(1)
          return { label: first.label, lines: [first.value, ...rest].join('\n') }
        })
  return blocks
    .map((b) => ({ label: clean(b.label, 40), lines: b.lines.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n').slice(0, 600) }))
    .filter((b) => b.lines)
    .slice(0, max)
}

export const formatLabeled = (rows: Labeled[]) => rows.map((r) => (r.label ? `${r.label}: ${r.value}` : r.value)).join('\n')
export const formatAddresses = (rows: Address[]) => rows.map((r) => (r.label ? `${r.label}: ${r.lines}` : r.lines)).join('\n\n')

export function normalizeContact(input: Record<string, unknown>): Partial<Contact> {
  const out: Partial<Contact> = {}
  if ('circle' in input) out.circle = asCircle(input.circle)
  if ('name' in input) out.name = clean(input.name, 200) ?? ''
  for (const key of ['nickname', 'relationship', 'company', 'title', 'birthday', 'anniversary'] as const) if (key in input) out[key] = clean(input[key], 200)
  if ('notes' in input) out.notes = clean(input.notes, 20_000)
  if ('emails' in input) out.emails = parseLabeled(input.emails).map((e) => ({ ...e, value: e.value.toLowerCase() }))
  if ('phones' in input) out.phones = parseLabeled(input.phones, 20, 60)
  if ('links' in input) out.links = parseLabeled(input.links, 20, 2000).filter((l) => /^https?:\/\//i.test(l.value))
  if ('addresses' in input) out.addresses = parseAddresses(input.addresses)
  return out
}

/** A contact's display name: the name, else the first email. */
export const contactName = (c: Pick<Contact, 'name' | 'emails'>) => c.name || c.emails[0]?.value || 'Unnamed'

export class Network {
  readonly db: Database

  constructor(
    readonly store: Store,
    private now = () => Date.now(),
  ) {
    this.db = store.db
    this.db.exec(SCHEMA)
  }

  // ---- contacts ----------------------------------------------------------

  private row(r: any): Contact {
    return { ...r, emails: parseJson(r.emails), phones: parseJson(r.phones), addresses: parseJson(r.addresses), links: parseJson(r.links) }
  }

  contacts(ownerId: string, opts: { circle?: Circle | null; q?: string; limit?: number } = {}): Contact[] {
    const rows = this.db.query<any, [string]>('SELECT * FROM contacts WHERE owner_id = ? ORDER BY lower(name)').all(ownerId).map((r) => this.row(r))
    const words = (opts.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
    const hay = (c: Contact) => [c.name, c.nickname, c.relationship, c.company, c.title, c.notes, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value), ...c.addresses.map((a) => a.lines)].filter(Boolean).join(' ').toLowerCase()
    return rows.filter((c) => (!opts.circle || c.circle === opts.circle) && words.every((w) => hay(c).includes(w))).slice(0, opts.limit ?? 5000)
  }

  contact(ownerId: string, id: string): Contact | null {
    const r = this.db.query<any, [string, string]>('SELECT * FROM contacts WHERE owner_id = ? AND id = ?').get(ownerId, id)
    return r ? this.row(r) : null
  }

  contactByEmail(ownerId: string, email: string): Contact | null {
    const want = email.trim().toLowerCase()
    return this.contacts(ownerId).find((c) => c.emails.some((e) => e.value === want)) ?? null
  }

  circleCounts(ownerId: string): Record<Circle, number> {
    const out: Record<Circle, number> = { family: 0, neighbors: 0, friends: 0, business: 0 }
    for (const r of this.db.query<{ circle: Circle; n: number }, [string]>('SELECT circle, COUNT(*) AS n FROM contacts WHERE owner_id = ? GROUP BY circle').all(ownerId)) if (r.circle in out) out[r.circle] = r.n
    return out
  }

  addContact(ownerId: string, input: Record<string, unknown>, link: { tree_id?: string | null; person_id?: string | null; linked_user_id?: string | null } = {}): Contact {
    const c = normalizeContact(input)
    const id = newId()
    const now = this.now()
    this.db
      .query(
        `INSERT INTO contacts (id,owner_id,circle,name,nickname,relationship,company,title,birthday,anniversary,emails,phones,addresses,links,notes,linked_user_id,tree_id,person_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, ownerId, c.circle ?? 'friends', c.name ?? '', c.nickname ?? null, c.relationship ?? null, c.company ?? null, c.title ?? null, c.birthday ?? null, c.anniversary ?? null, JSON.stringify(c.emails ?? []), JSON.stringify(c.phones ?? []), JSON.stringify(c.addresses ?? []), JSON.stringify(c.links ?? []), c.notes ?? null, link.linked_user_id ?? null, link.tree_id ?? null, link.person_id ?? null, now, now)
    return this.contact(ownerId, id)!
  }

  updateContact(ownerId: string, id: string, input: Record<string, unknown>): Contact | null {
    const current = this.contact(ownerId, id)
    if (!current) return null
    const c = { ...current, ...normalizeContact(input) }
    this.db
      .query('UPDATE contacts SET circle=?, name=?, nickname=?, relationship=?, company=?, title=?, birthday=?, anniversary=?, emails=?, phones=?, addresses=?, links=?, notes=?, updated_at=? WHERE owner_id = ? AND id = ?')
      .run(c.circle, c.name, c.nickname, c.relationship, c.company, c.title, c.birthday, c.anniversary, JSON.stringify(c.emails), JSON.stringify(c.phones), JSON.stringify(c.addresses), JSON.stringify(c.links), c.notes, this.now(), ownerId, id)
    return this.contact(ownerId, id)
  }

  linkContact(ownerId: string, id: string, link: { tree_id?: string | null; person_id?: string | null; linked_user_id?: string | null }) {
    if (link.tree_id !== undefined) this.db.query('UPDATE contacts SET tree_id = ? WHERE owner_id = ? AND id = ?').run(link.tree_id, ownerId, id)
    if (link.person_id !== undefined) this.db.query('UPDATE contacts SET person_id = ? WHERE owner_id = ? AND id = ?').run(link.person_id, ownerId, id)
    if (link.linked_user_id !== undefined) this.db.query('UPDATE contacts SET linked_user_id = ? WHERE owner_id = ? AND id = ?').run(link.linked_user_id, ownerId, id)
  }

  deleteContact(ownerId: string, id: string) {
    this.db.query('DELETE FROM contacts WHERE owner_id = ? AND id = ?').run(ownerId, id)
  }

  /** Find by email or make one: used when you invite someone, so they land in your network too. */
  ensureContact(ownerId: string, email: string, fields: Record<string, unknown>, link: { tree_id?: string | null; person_id?: string | null; linked_user_id?: string | null } = {}): Contact {
    const existing = this.contactByEmail(ownerId, email)
    if (existing) {
      const keep = Object.fromEntries(Object.entries(link).filter(([k, v]) => v && !(existing as any)[k]))
      if (Object.keys(keep).length) this.linkContact(ownerId, existing.id, keep)
      return this.contact(ownerId, existing.id)!
    }
    return this.addContact(ownerId, { ...fields, emails: [{ label: null, value: email }] }, link)
  }

  // ---- connections -------------------------------------------------------

  createConnectRequest(fromUser: string, email: string, circle: Circle, contactId: string | null, note: string | null = null, days = 30): string {
    const token = newId(18)
    this.db.query('INSERT INTO connect_requests (token_hash,from_user,contact_id,email,circle,note,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').run(sha256(token), fromUser, contactId, email.trim().toLowerCase(), circle, clean(note, 1000), this.now(), this.now() + days * 86_400_000)
    return token
  }

  connectRequest(token: string): { from_user: string; contact_id: string | null; email: string; circle: Circle; note: string | null } | null {
    const r = this.db.query<any, [string]>('SELECT * FROM connect_requests WHERE token_hash = ?').get(sha256(token))
    return r && r.expires_at > this.now() && !r.used_by ? r : null
  }

  /** Both sides say yes: each ends up with the other in their network, linked to the account. */
  acceptConnectRequest(token: string, user: User): User | null {
    const req = this.connectRequest(token)
    if (!req || req.from_user === user.id) return null
    const from = this.store.user(req.from_user)
    if (!from) return null
    this.store.tx(() => {
      this.connect(from.id, user.id)
      const theirs = req.contact_id ? this.contact(from.id, req.contact_id) : null
      if (theirs) this.linkContact(from.id, theirs.id, { linked_user_id: user.id })
      else this.ensureContact(from.id, user.email, { name: user.name ?? '', circle: req.circle }, { linked_user_id: user.id })
      const mine = this.contactByEmail(user.id, from.email)
      if (mine) this.linkContact(user.id, mine.id, { linked_user_id: from.id })
      else this.addContact(user.id, { name: from.name ?? '', circle: req.circle, emails: [{ label: null, value: from.email }] }, { linked_user_id: from.id })
      this.db.query('UPDATE connect_requests SET used_by = ? WHERE token_hash = ?').run(user.id, sha256(token))
    })
    return from
  }

  connect(a: string, b: string) {
    if (a === b) return
    const [x, y] = pair(a, b)
    this.db.query('INSERT OR IGNORE INTO connections (user_a,user_b,created_at) VALUES (?,?,?)').run(x, y, this.now())
  }

  disconnect(a: string, b: string) {
    const [x, y] = pair(a, b)
    this.db.query('DELETE FROM connections WHERE user_a = ? AND user_b = ?').run(x, y)
  }

  connected(a: string, b: string): boolean {
    const [x, y] = pair(a, b)
    return Boolean(this.db.query<{ n: number }, [string, string]>('SELECT 1 AS n FROM connections WHERE user_a = ? AND user_b = ?').get(x, y))
  }

  // ---- blocks ------------------------------------------------------------

  block(userId: string, blockedId: string) {
    if (userId === blockedId) return
    this.db.query('INSERT OR IGNORE INTO blocks (user_id,blocked_id,created_at) VALUES (?,?,?)').run(userId, blockedId, this.now())
  }

  unblock(userId: string, blockedId: string) {
    this.db.query('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(userId, blockedId)
  }

  blocked(userId: string, otherId: string): boolean {
    return Boolean(this.db.query<{ n: number }, [string, string]>('SELECT 1 AS n FROM blocks WHERE user_id = ? AND blocked_id = ?').get(userId, otherId))
  }

  /** Either side blocked the other. */
  blockedEitherWay(a: string, b: string) {
    return this.blocked(a, b) || this.blocked(b, a)
  }

  // ---- inbox -------------------------------------------------------------

  /** People who know each other: connected, or in a tree together; and neither has blocked the other. */
  canMessage(from: string, to: string): boolean {
    if (from === to || !this.store.user(to)) return false
    if (this.blockedEitherWay(from, to)) return false
    return this.connected(from, to) || this.store.sharesTree(from, to)
  }

  send(from: string, to: string, body: string): Message {
    const text = clean(body, 5000)
    if (!text) throw new Error('write something first')
    if (!this.canMessage(from, to)) throw new Error('you can message people you are connected with or share a tree with')
    const id = newId()
    this.db.query('INSERT INTO messages (id,sender_id,recipient_id,body,created_at) VALUES (?,?,?,?,?)').run(id, from, to, text, this.now())
    return this.db.query<Message, [string]>('SELECT id,sender_id,recipient_id,body,created_at FROM messages WHERE id = ?').get(id)!
  }

  /** The conversation between two people, oldest first. Reading it marks it read for `me`. */
  conversation(me: string, other: string, limit = 500): Message[] {
    this.db.query('UPDATE messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL').run(this.now(), me, other)
    return this.db
      .query<Message, [string, string, string, string, number]>('SELECT id,sender_id,recipient_id,body,created_at FROM messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(me, other, other, me, limit)
      .reverse()
  }

  threads(me: string): Thread[] {
    const rows = this.db
      .query<Message & { other_id: string }, [string, string, string]>(
        `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.created_at,
                CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END AS other_id
         FROM messages m WHERE m.sender_id = ? OR m.recipient_id = ? ORDER BY m.created_at DESC, m.rowid DESC`,
      )
      .all(me, me, me)
    const seen = new Map<string, Thread>()
    for (const { other_id, ...m } of rows) {
      if (seen.has(other_id) || this.blocked(me, other_id)) continue
      const other = this.store.user(other_id)
      if (other) seen.set(other_id, { other, last: m, unread: 0 })
    }
    for (const r of this.db.query<{ sender_id: string; n: number }, [string]>('SELECT sender_id, COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL GROUP BY sender_id').all(me)) {
      const t = seen.get(r.sender_id)
      if (t) t.unread = r.n
    }
    return [...seen.values()]
  }

  unreadCount(me: string): number {
    return this.db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM messages m WHERE recipient_id = ? AND read_at IS NULL AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = ? AND b.blocked_id = m.sender_id)').get(me, me)?.n ?? 0
  }

  /** Unread messages from `from` to `to` sent before the newest one: 0 means this is the first unread, worth an email. */
  unreadBefore(from: string, to: string): number {
    return (this.db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL').get(from, to)?.n ?? 1) - 1
  }

  /** Everyone you could start a conversation with right now. */
  reachable(me: string): User[] {
    const ids = new Set<string>()
    for (const r of this.db.query<{ a: string; b: string }, [string, string]>('SELECT user_a AS a, user_b AS b FROM connections WHERE user_a = ? OR user_b = ?').all(me, me)) ids.add(r.a === me ? r.b : r.a)
    for (const r of this.db.query<{ id: string }, [string, string]>('SELECT DISTINCT y.user_id AS id FROM members x JOIN members y ON y.tree_id = x.tree_id WHERE x.user_id = ? AND y.user_id != ?').all(me, me)) ids.add(r.id)
    return [...ids].filter((id) => !this.blockedEitherWay(me, id)).map((id) => this.store.user(id)!).filter(Boolean).sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email))
  }
}

// ---- vCard (what every phone and mail app imports and exports) --------------

const vEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')
const vUnesc = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
const fold = (line: string) => (line.length <= 75 ? line : line.match(/.{1,74}/g)!.join('\r\n '))

export function toVcard(contacts: Contact[]): string {
  return contacts
    .map((c) => {
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vEsc(contactName(c))}`, `N:${vEsc(c.name.split(' ').slice(-1)[0] ?? '')};${vEsc(c.name.split(' ').slice(0, -1).join(' '))};;;`]
      if (c.nickname) lines.push(`NICKNAME:${vEsc(c.nickname)}`)
      for (const e of c.emails) lines.push(`EMAIL${e.label ? `;TYPE=${e.label.toUpperCase().replace(/\W+/g, '')}` : ''}:${vEsc(e.value)}`)
      for (const p of c.phones) lines.push(`TEL${p.label ? `;TYPE=${p.label.toUpperCase().replace(/\W+/g, '')}` : ''}:${vEsc(p.value)}`)
      for (const a of c.addresses) lines.push(`ADR${a.label ? `;TYPE=${a.label.toUpperCase().replace(/\W+/g, '')}` : ''}:;;${vEsc(a.lines)};;;;`)
      for (const l of c.links) lines.push(`URL:${vEsc(l.value)}`)
      if (c.company) lines.push(`ORG:${vEsc(c.company)}`)
      if (c.title) lines.push(`TITLE:${vEsc(c.title)}`)
      if (c.birthday) lines.push(`BDAY:${vEsc(c.birthday)}`)
      if (c.anniversary) lines.push(`ANNIVERSARY:${vEsc(c.anniversary)}`)
      if (c.notes) lines.push(`NOTE:${vEsc(c.notes)}`)
      lines.push(`CATEGORIES:${c.circle}`, 'END:VCARD')
      return lines.map(fold).join('\r\n')
    })
    .join('\r\n')
    .concat('\r\n')
}

/** vCard 2.1/3.0/4.0 into contact inputs. Unknown properties are ignored; nothing here throws on a bad card. */
export function parseVcards(text: string, defaultCircle: Circle = 'friends'): Record<string, unknown>[] {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
  const out: Record<string, unknown>[] = []
  for (const card of unfolded.split(/^BEGIN:VCARD\s*$/im).slice(1)) {
    const c: any = { circle: defaultCircle, emails: [], phones: [], addresses: [], links: [] }
    let n = ''
    for (const raw of card.split('\n')) {
      const m = raw.match(/^(?:item\d+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/)
      if (!m) continue
      const prop = m[1]!.toUpperCase()
      // TYPE=a,b or TYPE=a;TYPE=b (3.0), or bare ;HOME;CELL (2.1). INTERNET/PREF/VOICE say nothing a person cares about.
      const types = [...m[2]!.matchAll(/TYPE=([^;:]+)/gi)].flatMap((t) => t[1]!.split(',')).concat([...m[2]!.matchAll(/;(HOME|WORK|CELL|MOBILE|FAX)\b/gi)].map((t) => t[1]!))
      const type = types.find((t) => !/^(INTERNET|PREF|VOICE|X400)$/i.test(t))?.toLowerCase() ?? null
      const value = vUnesc(m[3]!.trim())
      if (!value) continue
      if (prop === 'FN') c.name = value
      else if (prop === 'N') n = value.split(';').slice(0, 2).reverse().join(' ').trim()
      else if (prop === 'NICKNAME') c.nickname = value
      else if (prop === 'EMAIL') c.emails.push({ label: type, value })
      else if (prop === 'TEL') c.phones.push({ label: type, value })
      else if (prop === 'ADR') c.addresses.push({ label: type, lines: value.split(';').map((s) => s.trim()).filter(Boolean).join('\n') })
      else if (prop === 'URL') c.links.push({ label: null, value })
      else if (prop === 'ORG') c.company = value.split(';')[0]
      else if (prop === 'TITLE') c.title = value
      else if (prop === 'BDAY') c.birthday = value
      else if (prop === 'ANNIVERSARY') c.anniversary = value
      else if (prop === 'NOTE') c.notes = value
      else if (prop === 'CATEGORIES') {
        const cat = value.toLowerCase().split(',').map((s) => s.trim()).find((s) => CIRCLES.includes(s as Circle) || s === 'friend')
        if (cat) c.circle = cat === 'friend' ? 'friends' : cat
      }
    }
    c.name ||= n
    if (c.name || c.emails.length || c.phones.length) out.push(c)
  }
  return out
}
