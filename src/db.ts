/**
 * Everything family.ancestry stores, in one SQLite file.
 *
 * The model is GEDCOM's, because that is what every other genealogy program
 * reads and writes: a person is an individual, and a family is a couple (one or
 * two partners) plus the children born or adopted into it. Parents, spouses,
 * siblings and grandparents are all answered by walking families, so there is
 * no separate "relationship" table to drift out of step with them.
 *
 * Every row hangs off a tree, and every query takes the tree id, so a member of
 * one tree can never read another by guessing an id.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url')
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export type Role = 'owner' | 'editor' | 'viewer'
export const ROLES: Role[] = ['owner', 'editor', 'viewer']
export const canEdit = (role: Role | null | undefined) => role === 'owner' || role === 'editor'

export type User = { id: string; email: string; name: string | null; created_at: number }
export type Tree = { id: string; name: string; description: string | null; owner_id: string; home_person_id: string | null; created_at: number }
export type Sex = 'M' | 'F' | 'X' | 'U'
export type Person = {
  id: string
  tree_id: string
  given: string
  surname: string
  sex: Sex
  birth_date: string | null
  birth_place: string | null
  death_date: string | null
  death_place: string | null
  living: number
  notes: string | null
  photo_id: string | null
  created_at: number
  updated_at: number
}
export type Family = {
  id: string
  tree_id: string
  partner1_id: string | null
  partner2_id: string | null
  kind: string
  start_date: string | null
  start_place: string | null
  end_date: string | null
  created_at: number
}
export type Event = { id: string; tree_id: string; person_id: string; type: string; date: string | null; place: string | null; description: string | null; created_at: number }
export type Source = { id: string; tree_id: string; title: string; author: string | null; url: string | null; citation: string | null; created_at: number }
export type Media = { id: string; tree_id: string; person_id: string | null; filename: string; mime: string; size: number; caption: string | null; created_at: number }
export type Invite = { id: string; tree_id: string; role: 'editor' | 'viewer'; email: string | null; person_id: string | null; note: string | null; created_by: string; created_at: number; expires_at: number; used_by: string | null }
export type Descendant = { person: Person; unions: { partner: Person | null; children: Descendant[] }[] }

export const PERSON_FIELDS = ['given', 'surname', 'sex', 'birth_date', 'birth_place', 'death_date', 'death_place', 'living', 'notes'] as const
export type PersonInput = Partial<Pick<Person, (typeof PERSON_FIELDS)[number]>>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, next TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
  label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS cli_codes (
  code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, label TEXT, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trees (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id), home_person_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')), created_at INTEGER NOT NULL,
  PRIMARY KEY (tree_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor','viewer')), email TEXT, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT
);
CREATE TABLE IF NOT EXISTS profiles (
  tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tree_id, person_id), UNIQUE (tree_id, user_id)
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  given TEXT NOT NULL DEFAULT '', surname TEXT NOT NULL DEFAULT '', sex TEXT NOT NULL DEFAULT 'U',
  birth_date TEXT, birth_place TEXT, death_date TEXT, death_place TEXT,
  living INTEGER NOT NULL DEFAULT 0, notes TEXT, photo_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS people_tree ON people(tree_id, surname, given);
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  partner1_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  partner2_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'married', start_date TEXT, start_place TEXT, end_date TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS families_p1 ON families(partner1_id);
CREATE INDEX IF NOT EXISTS families_p2 ON families(partner2_id);
CREATE TABLE IF NOT EXISTS children (
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'birth', position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, person_id)
);
CREATE INDEX IF NOT EXISTS children_person ON children(person_id);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  type TEXT NOT NULL, date TEXT, place TEXT, description TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_person ON events(person_id);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  title TEXT NOT NULL, author TEXT, url TEXT, citation TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS citations (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  page TEXT, PRIMARY KEY (source_id, person_id)
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, caption TEXT, data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_person ON media(person_id);
`

const INVITE_COLS = 'token_hash AS id, tree_id, role, email, person_id, note, created_by, created_at, expires_at, used_by'

export const clean = (value: unknown, max = 500): string | null => {
  if (value === undefined || value === null) return null
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  return text ? text.slice(0, max) : null
}

export function normalizePerson(input: Record<string, unknown>): PersonInput {
  const out: PersonInput = {}
  if ('given' in input) out.given = clean(input.given, 200) ?? ''
  if ('surname' in input) out.surname = clean(input.surname, 200) ?? ''
  if ('sex' in input) {
    const sex = String(input.sex ?? 'U').toUpperCase().slice(0, 1)
    out.sex = (['M', 'F', 'X'].includes(sex) ? sex : 'U') as Sex
  }
  for (const key of ['birth_date', 'birth_place', 'death_date', 'death_place'] as const) if (key in input) out[key] = clean(input[key], 200)
  if ('notes' in input) out.notes = clean(input.notes, 20_000)
  if ('living' in input) out.living = [true, 1, '1', 'on', 'true', 'yes'].includes(input.living as any) ? 1 : 0
  return out
}

export const fullName = (p: Pick<Person, 'given' | 'surname'>) => `${p.given} ${p.surname}`.trim() || 'Unnamed'

/** The year in a free-text genealogy date ("ABT 1890", "12 MAR 1901", "1850-1860"), if any. */
export const yearOf = (date: string | null | undefined): number | null => {
  const match = date?.match(/\b(\d{3,4})\b/)
  return match ? Number(match[1]) : null
}

export const lifespan = (p: Pick<Person, 'birth_date' | 'death_date' | 'living'>) => {
  const b = yearOf(p.birth_date)
  const d = yearOf(p.death_date)
  if (!b && !d) return p.living ? 'Living' : ''
  return `${b ?? '?'}–${d ?? (p.living ? '' : '?')}`
}

export class Store {
  readonly db: Database

  constructor(path: string, private now = () => Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA foreign_keys = ON')
    this.db.run('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
    // Columns added after 0.1.0. SQLite has no ADD COLUMN IF NOT EXISTS.
    const has = (table: string, column: string) => this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
    if (!has('invites', 'person_id')) this.db.run('ALTER TABLE invites ADD COLUMN person_id TEXT')
    if (!has('invites', 'note')) this.db.run('ALTER TABLE invites ADD COLUMN note TEXT')
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // ---- users -------------------------------------------------------------

  userByEmail(email: string): User | null {
    return this.db.query<User, [string]>('SELECT id,email,name,created_at FROM users WHERE email = ?').get(email.trim().toLowerCase()) ?? null
  }

  user(id: string): User | null {
    return this.db.query<User, [string]>('SELECT id,email,name,created_at FROM users WHERE id = ?').get(id) ?? null
  }

  findOrCreateUser(email: string): User {
    const existing = this.userByEmail(email)
    if (existing) return existing
    const id = newId()
    this.db.query('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)').run(id, email.trim().toLowerCase(), null, this.now())
    return this.user(id)!
  }

  setUserName(id: string, name: string | null) {
    this.db.query('UPDATE users SET name = ? WHERE id = ?').run(clean(name, 120), id)
  }

  // ---- trees + members ---------------------------------------------------

  createTree(ownerId: string, name: string, description: string | null = null): Tree {
    const id = newId()
    const now = this.now()
    this.tx(() => {
      this.db.query('INSERT INTO trees (id,name,description,owner_id,created_at) VALUES (?,?,?,?,?)').run(id, clean(name, 200) ?? 'Family tree', clean(description, 2000), ownerId, now)
      this.db.query('INSERT INTO members (tree_id,user_id,role,created_at) VALUES (?,?,?,?)').run(id, ownerId, 'owner', now)
    })
    return this.tree(id)!
  }

  tree(id: string): Tree | null {
    return this.db.query<Tree, [string]>('SELECT * FROM trees WHERE id = ?').get(id) ?? null
  }

  updateTree(id: string, fields: { name?: string; description?: string | null; home_person_id?: string | null }) {
    if (fields.name !== undefined) this.db.query('UPDATE trees SET name = ? WHERE id = ?').run(clean(fields.name, 200) ?? 'Family tree', id)
    if (fields.description !== undefined) this.db.query('UPDATE trees SET description = ? WHERE id = ?').run(clean(fields.description, 2000), id)
    if (fields.home_person_id !== undefined && (fields.home_person_id === null || this.person(id, fields.home_person_id))) {
      this.db.query('UPDATE trees SET home_person_id = ? WHERE id = ?').run(fields.home_person_id, id)
    }
  }

  deleteTree(id: string) {
    this.db.query('DELETE FROM trees WHERE id = ?').run(id)
  }

  treesFor(userId: string): (Tree & { role: Role; people: number })[] {
    return this.db
      .query<Tree & { role: Role; people: number }, [string]>(
        `SELECT t.*, m.role, (SELECT COUNT(*) FROM people p WHERE p.tree_id = t.id) AS people
         FROM trees t JOIN members m ON m.tree_id = t.id WHERE m.user_id = ? ORDER BY t.created_at`,
      )
      .all(userId)
  }

  role(treeId: string, userId: string | null | undefined): Role | null {
    if (!userId) return null
    return this.db.query<{ role: Role }, [string, string]>('SELECT role FROM members WHERE tree_id = ? AND user_id = ?').get(treeId, userId)?.role ?? null
  }

  members(treeId: string): { user_id: string; email: string; name: string | null; role: Role }[] {
    return this.db
      .query<{ user_id: string; email: string; name: string | null; role: Role }, [string]>(
        'SELECT m.user_id, u.email, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.tree_id = ? ORDER BY m.created_at',
      )
      .all(treeId)
  }

  setMember(treeId: string, userId: string, role: Role) {
    this.db.query('INSERT INTO members (tree_id,user_id,role,created_at) VALUES (?,?,?,?) ON CONFLICT(tree_id,user_id) DO UPDATE SET role = excluded.role').run(treeId, userId, role, this.now())
  }

  removeMember(treeId: string, userId: string) {
    this.db.query("DELETE FROM members WHERE tree_id = ? AND user_id = ? AND role != 'owner'").run(treeId, userId)
  }

  /**
   * A one-time link into a tree. With a person, it is also an invitation to be
   * that person: whoever accepts it can keep their own profile up to date.
   */
  createInvite(treeId: string, createdBy: string, role: 'editor' | 'viewer', email: string | null = null, opts: { days?: number; personId?: string | null; note?: string | null } = {}): string {
    const token = newId(18)
    const personId = opts.personId && this.person(treeId, opts.personId) ? opts.personId : null
    this.db
      .query('INSERT INTO invites (token_hash,tree_id,role,email,created_by,created_at,expires_at,person_id,note) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(sha256(token), treeId, role, email ? email.trim().toLowerCase() : null, createdBy, this.now(), this.now() + (opts.days ?? 14) * 86_400_000, personId, clean(opts.note, 1000))
    return token
  }

  invite(token: string): Invite | null {
    const row = this.db.query<any, [string]>(`SELECT ${INVITE_COLS} FROM invites WHERE token_hash = ?`).get(sha256(token))
    return row && row.expires_at > this.now() && !row.used_by ? row : null
  }

  /** Invites not yet used or expired, newest first. `id` is the token's hash, safe to show. */
  pendingInvites(treeId: string): Invite[] {
    return this.db.query<Invite, [string, number]>(`SELECT ${INVITE_COLS} FROM invites WHERE tree_id = ? AND used_by IS NULL AND expires_at > ? ORDER BY created_at DESC`).all(treeId, this.now())
  }

  revokeInvite(treeId: string, id: string) {
    this.db.query('DELETE FROM invites WHERE tree_id = ? AND token_hash = ? AND used_by IS NULL').run(treeId, id)
  }

  /** The tree joined and, for a profile invite, the person the new member now is. */
  acceptInvite(token: string, userId: string): { tree_id: string; person_id: string | null } | null {
    const invite = this.invite(token)
    if (!invite) return null
    let claimed: string | null = null
    this.tx(() => {
      const current = this.role(invite.tree_id, userId)
      // An invite never demotes: an owner who clicks a viewer link stays owner.
      if (!current || (current === 'viewer' && invite.role === 'editor')) this.setMember(invite.tree_id, userId, invite.role)
      if (invite.person_id && this.claimProfile(invite.tree_id, invite.person_id, userId)) claimed = invite.person_id
      this.db.query('UPDATE invites SET used_by = ? WHERE token_hash = ?').run(userId, sha256(token))
    })
    return { tree_id: invite.tree_id, person_id: claimed }
  }

  // ---- profiles: a member who is a person in the tree --------------------

  /** Link a member to the person they are. One person per member, one member per person. */
  claimProfile(treeId: string, personId: string, userId: string): boolean {
    if (!this.person(treeId, personId) || !this.role(treeId, userId)) return false
    const holder = this.profileUser(treeId, personId)
    if (holder && holder.id !== userId) return false
    this.db.query('DELETE FROM profiles WHERE tree_id = ? AND user_id = ?').run(treeId, userId)
    this.db.query('INSERT OR REPLACE INTO profiles (tree_id,person_id,user_id,created_at) VALUES (?,?,?,?)').run(treeId, personId, userId, this.now())
    return true
  }

  releaseProfile(treeId: string, personId: string) {
    this.db.query('DELETE FROM profiles WHERE tree_id = ? AND person_id = ?').run(treeId, personId)
  }

  /** The member who manages this person's profile, if anyone does. */
  profileUser(treeId: string, personId: string): User | null {
    return this.db.query<User, [string, string]>('SELECT u.id,u.email,u.name,u.created_at FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.tree_id = ? AND p.person_id = ?').get(treeId, personId) ?? null
  }

  /** The person this member is, in this tree. */
  profilePerson(treeId: string, userId: string | null | undefined): string | null {
    if (!userId) return null
    return this.db.query<{ person_id: string }, [string, string]>('SELECT person_id FROM profiles WHERE tree_id = ? AND user_id = ?').get(treeId, userId)?.person_id ?? null
  }

  /** user id -> person id, for everyone in the tree who has claimed a profile. */
  profiles(treeId: string): Map<string, string> {
    return new Map(this.db.query<{ user_id: string; person_id: string }, [string]>('SELECT user_id, person_id FROM profiles WHERE tree_id = ?').all(treeId).map((r) => [r.user_id, r.person_id]))
  }

  /** Editors change anyone; everyone else may change only the person they are. */
  canEditPerson(treeId: string, personId: string, userId: string | null | undefined): boolean {
    if (canEdit(this.role(treeId, userId))) return true
    return Boolean(userId && this.profilePerson(treeId, userId) === personId)
  }

  /** Users who share at least one tree with this one. */
  sharesTree(a: string, b: string): boolean {
    return Boolean(this.db.query<{ n: number }, [string, string]>('SELECT 1 AS n FROM members x JOIN members y ON y.tree_id = x.tree_id WHERE x.user_id = ? AND y.user_id = ? LIMIT 1').get(a, b))
  }

  // ---- people ------------------------------------------------------------

  addPerson(treeId: string, input: Record<string, unknown>): Person {
    const p = normalizePerson(input)
    const id = newId()
    const now = this.now()
    this.db
      .query(
        `INSERT INTO people (id,tree_id,given,surname,sex,birth_date,birth_place,death_date,death_place,living,notes,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, treeId, p.given ?? '', p.surname ?? '', p.sex ?? 'U', p.birth_date ?? null, p.birth_place ?? null, p.death_date ?? null, p.death_place ?? null, p.living ?? 0, p.notes ?? null, now, now)
    if (!this.tree(treeId)?.home_person_id) this.updateTree(treeId, { home_person_id: id })
    return this.person(treeId, id)!
  }

  person(treeId: string, id: string): Person | null {
    return this.db.query<Person, [string, string]>('SELECT * FROM people WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  updatePerson(treeId: string, id: string, input: Record<string, unknown>): Person | null {
    const current = this.person(treeId, id)
    if (!current) return null
    const p = { ...current, ...normalizePerson(input) }
    this.db
      .query('UPDATE people SET given = ?, surname = ?, sex = ?, birth_date = ?, birth_place = ?, death_date = ?, death_place = ?, living = ?, notes = ?, updated_at = ? WHERE tree_id = ? AND id = ?')
      .run(p.given, p.surname, p.sex, p.birth_date, p.birth_place, p.death_date, p.death_place, p.living, p.notes, this.now(), treeId, id)
    return this.person(treeId, id)
  }

  deletePerson(treeId: string, id: string) {
    this.tx(() => {
      this.db.query('DELETE FROM people WHERE tree_id = ? AND id = ?').run(treeId, id)
      // A family left with no partners and no children is just noise.
      this.db.query('DELETE FROM families WHERE tree_id = ? AND partner1_id IS NULL AND partner2_id IS NULL AND id NOT IN (SELECT family_id FROM children)').run(treeId)
      this.db.query('UPDATE trees SET home_person_id = NULL WHERE id = ? AND home_person_id = ?').run(treeId, id)
    })
  }

  people(treeId: string, limit = 5000): Person[] {
    return this.db.query<Person, [string, number]>('SELECT * FROM people WHERE tree_id = ? ORDER BY surname, given LIMIT ?').all(treeId, limit)
  }

  /** Every word of the query must appear in the name, a place or a date. */
  search(treeId: string, query: string, limit = 50): Person[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
    if (!words.length) return this.people(treeId, limit)
    // SQL narrows by the first word; the rest are checked here, so the statement never changes shape.
    const like = `%${words[0]!.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const rows = this.db
      .query<Person, [string, string]>(
        "SELECT * FROM people WHERE tree_id = ? AND lower(given || ' ' || surname || ' ' || coalesce(birth_place,'') || ' ' || coalesce(death_place,'') || ' ' || coalesce(birth_date,'') || ' ' || coalesce(death_date,'')) LIKE ? ESCAPE '\\' ORDER BY surname, given",
      )
      .all(treeId, like)
    const hay = (p: Person) => [p.given, p.surname, p.birth_place, p.death_place, p.birth_date, p.death_date].filter(Boolean).join(' ').toLowerCase()
    return rows.filter((p) => words.every((w) => hay(p).includes(w))).slice(0, limit)
  }

  surnames(treeId: string): { surname: string; n: number }[] {
    return this.db.query<{ surname: string; n: number }, [string]>("SELECT surname, COUNT(*) AS n FROM people WHERE tree_id = ? AND surname != '' GROUP BY surname ORDER BY n DESC, surname LIMIT 200").all(treeId)
  }

  // ---- families ----------------------------------------------------------

  family(treeId: string, id: string): Family | null {
    return this.db.query<Family, [string, string]>('SELECT * FROM families WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  families(treeId: string): Family[] {
    return this.db.query<Family, [string]>('SELECT * FROM families WHERE tree_id = ? ORDER BY created_at').all(treeId)
  }

  createFamily(treeId: string, partner1: string | null, partner2: string | null, fields: { kind?: string; start_date?: string | null; start_place?: string | null; end_date?: string | null } = {}): Family {
    for (const pid of [partner1, partner2]) if (pid && !this.person(treeId, pid)) throw new Error('partner is not in this tree')
    if (partner1 && partner1 === partner2) throw new Error('a person cannot partner themselves')
    const id = newId()
    this.db
      .query('INSERT INTO families (id,tree_id,partner1_id,partner2_id,kind,start_date,start_place,end_date,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, treeId, partner1, partner2, clean(fields.kind, 40) ?? 'married', clean(fields.start_date, 200), clean(fields.start_place, 200), clean(fields.end_date, 200), this.now())
    return this.family(treeId, id)!
  }

  updateFamily(treeId: string, id: string, fields: { kind?: string; start_date?: string | null; start_place?: string | null; end_date?: string | null }) {
    const f = this.family(treeId, id)
    if (!f) return
    const pick = (key: 'start_date' | 'start_place' | 'end_date') => (fields[key] !== undefined ? clean(fields[key], 200) : f[key])
    const kind = fields.kind !== undefined ? (clean(fields.kind, 40) ?? 'married') : f.kind
    this.db.query('UPDATE families SET kind = ?, start_date = ?, start_place = ?, end_date = ? WHERE tree_id = ? AND id = ?').run(kind, pick('start_date'), pick('start_place'), pick('end_date'), treeId, id)
  }

  /** Fill an empty partner slot (a single parent who later gets a known partner). */
  setPartner(treeId: string, familyId: string, personId: string) {
    const fam = this.family(treeId, familyId)
    if (!fam || !this.person(treeId, personId)) throw new Error('not in this tree')
    if (fam.partner1_id === personId || fam.partner2_id === personId) return
    if (this.childrenOf(treeId, familyId).some((c) => c.id === personId)) throw new Error('a child cannot be their own parent')
    if (!fam.partner1_id) this.db.query('UPDATE families SET partner1_id = ? WHERE id = ?').run(personId, familyId)
    else if (!fam.partner2_id) this.db.query('UPDATE families SET partner2_id = ? WHERE id = ?').run(personId, familyId)
    else throw new Error('this family already has two partners')
  }

  deleteFamily(treeId: string, id: string) {
    this.db.query('DELETE FROM families WHERE tree_id = ? AND id = ?').run(treeId, id)
  }

  addChild(treeId: string, familyId: string, childId: string, relation = 'birth') {
    const fam = this.family(treeId, familyId)
    if (!fam || !this.person(treeId, childId)) throw new Error('not in this tree')
    if (fam.partner1_id === childId || fam.partner2_id === childId) throw new Error('a person cannot be their own child')
    if (this.ancestorIds(treeId, fam.partner1_id).has(childId) || this.ancestorIds(treeId, fam.partner2_id).has(childId)) throw new Error('that would make someone their own ancestor')
    const position = this.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM children WHERE family_id = ?').get(familyId)?.n ?? 0
    this.db.query('INSERT OR IGNORE INTO children (family_id,person_id,relation,position) VALUES (?,?,?,?)').run(familyId, childId, clean(relation, 40) ?? 'birth', position)
  }

  removeChild(familyId: string, childId: string) {
    this.db.query('DELETE FROM children WHERE family_id = ? AND person_id = ?').run(familyId, childId)
  }

  /** Families where this person is a partner, each with the other partner and the children. */
  spouseFamilies(treeId: string, personId: string): { family: Family; partner: Person | null; children: Person[] }[] {
    const fams = this.db.query<Family, [string, string, string]>('SELECT * FROM families WHERE tree_id = ? AND (partner1_id = ? OR partner2_id = ?) ORDER BY start_date, created_at').all(treeId, personId, personId)
    return fams.map((family) => {
      const otherId = family.partner1_id === personId ? family.partner2_id : family.partner1_id
      return { family, partner: otherId ? this.person(treeId, otherId) : null, children: this.childrenOf(treeId, family.id) }
    })
  }

  childrenOf(treeId: string, familyId: string): Person[] {
    return this.db.query<Person, [string, string]>('SELECT p.* FROM children c JOIN people p ON p.id = c.person_id WHERE c.family_id = ? AND p.tree_id = ? ORDER BY c.position, p.birth_date').all(familyId, treeId)
  }

  childLinks(treeId: string): { family_id: string; person_id: string; relation: string }[] {
    return this.db.query<any, [string]>('SELECT c.family_id, c.person_id, c.relation FROM children c JOIN families f ON f.id = c.family_id WHERE f.tree_id = ? ORDER BY c.family_id, c.position').all(treeId)
  }

  /** The families this person was born or adopted into. */
  parentFamilies(treeId: string, personId: string): { family: Family; relation: string; parents: Person[]; siblings: Person[] }[] {
    const rows = this.db.query<Family & { relation: string }, [string, string]>('SELECT f.*, c.relation FROM children c JOIN families f ON f.id = c.family_id WHERE c.person_id = ? AND f.tree_id = ?').all(personId, treeId)
    return rows.map(({ relation, ...family }) => ({
      family,
      relation,
      parents: [family.partner1_id, family.partner2_id].filter(Boolean).map((id) => this.person(treeId, id!)).filter(Boolean) as Person[],
      siblings: this.childrenOf(treeId, family.id).filter((p) => p.id !== personId),
    }))
  }

  parents(treeId: string, personId: string): Person[] {
    return this.parentFamilies(treeId, personId).flatMap((f) => f.parents)
  }

  ancestorIds(treeId: string, personId: string | null, max = 5000): Set<string> {
    const seen = new Set<string>()
    if (!personId) return seen
    const queue = [personId]
    while (queue.length && seen.size < max) {
      const id = queue.shift()!
      for (const parent of this.parents(treeId, id)) {
        if (seen.has(parent.id)) continue
        seen.add(parent.id)
        queue.push(parent.id)
      }
    }
    return seen
  }

  /** Ancestors by Ahnentafel number: 1 is the person, 2n the father (or first parent), 2n+1 the mother. */
  pedigree(treeId: string, personId: string, generations = 4): Map<number, Person> {
    const out = new Map<number, Person>()
    const root = this.person(treeId, personId)
    if (!root) return out
    out.set(1, root)
    for (let n = 1; n < 2 ** (generations - 1); n++) {
      const p = out.get(n)
      if (!p) continue
      const fams = this.parentFamilies(treeId, p.id)
      const fam = fams.find((f) => f.relation === 'birth') ?? fams[0]
      if (!fam) continue
      const ps = fam.parents
      const sorted = ps.length === 2 && ps[0]!.sex === 'F' && ps[1]!.sex === 'M' ? [ps[1]!, ps[0]!] : ps.length === 1 && ps[0]!.sex === 'F' ? [undefined, ps[0]!] : ps
      if (sorted[0]) out.set(2 * n, sorted[0])
      if (sorted[1]) out.set(2 * n + 1, sorted[1])
    }
    return out
  }

  descendants(treeId: string, personId: string, depth = 4): Descendant | null {
    const root = this.person(treeId, personId)
    if (!root) return null
    const seen = new Set<string>()
    const walk = (p: Person, d: number): Descendant => {
      seen.add(p.id)
      const unions = d >= depth ? [] : this.spouseFamilies(treeId, p.id)
      return { person: p, unions: unions.map((u) => ({ partner: u.partner, children: u.children.filter((c) => !seen.has(c.id)).map((c) => walk(c, d + 1)) })) }
    }
    return walk(root, 0)
  }

  /** How two people are related, as the chain of steps from a to b (parent / child / partner), shortest first. */
  relationship(treeId: string, a: string, b: string, maxSteps = 12): { person: Person; step: 'self' | 'parent' | 'child' | 'partner' }[] | null {
    if (!this.person(treeId, a) || !this.person(treeId, b)) return null
    const prev = new Map<string, { from: string; step: 'parent' | 'child' | 'partner' }>()
    const depth = new Map<string, number>([[a, 0]])
    const queue = [a]
    while (queue.length) {
      const id = queue.shift()!
      if (id === b) break
      if (depth.get(id)! >= maxSteps) continue
      const next: [string, 'parent' | 'child' | 'partner'][] = [
        ...this.parents(treeId, id).map((p) => [p.id, 'parent'] as [string, 'parent']),
        ...this.spouseFamilies(treeId, id).flatMap((u) => [
          ...(u.partner ? [[u.partner.id, 'partner'] as [string, 'partner']] : []),
          ...u.children.map((c) => [c.id, 'child'] as [string, 'child']),
        ]),
      ]
      for (const [nid, step] of next) {
        if (depth.has(nid)) continue
        depth.set(nid, depth.get(id)! + 1)
        prev.set(nid, { from: id, step })
        queue.push(nid)
      }
    }
    if (!depth.has(b)) return null
    const path: { person: Person; step: 'self' | 'parent' | 'child' | 'partner' }[] = []
    for (let id: string | undefined = b; id; id = prev.get(id)?.from) path.unshift({ person: this.person(treeId, id)!, step: prev.get(id)?.step ?? 'self' })
    return path
  }

  // ---- events, sources, media -------------------------------------------

  events(treeId: string, personId: string): Event[] {
    return this.db.query<Event, [string, string]>('SELECT * FROM events WHERE tree_id = ? AND person_id = ? ORDER BY date, created_at').all(treeId, personId)
  }

  allEvents(treeId: string): Event[] {
    return this.db.query<Event, [string]>('SELECT * FROM events WHERE tree_id = ? ORDER BY person_id, created_at').all(treeId)
  }

  addEvent(treeId: string, personId: string, input: { type: string; date?: string | null; place?: string | null; description?: string | null }): Event {
    if (!this.person(treeId, personId)) throw new Error('person is not in this tree')
    const id = newId()
    this.db.query('INSERT INTO events (id,tree_id,person_id,type,date,place,description,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, treeId, personId, clean(input.type, 60) ?? 'Event', clean(input.date, 200), clean(input.place, 200), clean(input.description, 5000), this.now())
    return this.db.query<Event, [string]>('SELECT * FROM events WHERE id = ?').get(id)!
  }

  deleteEvent(treeId: string, id: string) {
    this.db.query('DELETE FROM events WHERE tree_id = ? AND id = ?').run(treeId, id)
  }

  sources(treeId: string): Source[] {
    return this.db.query<Source, [string]>('SELECT * FROM sources WHERE tree_id = ? ORDER BY title').all(treeId)
  }

  source(treeId: string, id: string): Source | null {
    return this.db.query<Source, [string, string]>('SELECT * FROM sources WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  addSource(treeId: string, input: { title: string; author?: string | null; url?: string | null; citation?: string | null }): Source {
    const id = newId()
    const url = clean(input.url, 2000)
    this.db.query('INSERT INTO sources (id,tree_id,title,author,url,citation,created_at) VALUES (?,?,?,?,?,?,?)').run(id, treeId, clean(input.title, 300) ?? 'Untitled source', clean(input.author, 300), url && /^https?:\/\//i.test(url) ? url : null, clean(input.citation, 5000), this.now())
    return this.source(treeId, id)!
  }

  deleteSource(treeId: string, id: string) {
    this.db.query('DELETE FROM sources WHERE tree_id = ? AND id = ?').run(treeId, id)
  }

  cite(treeId: string, sourceId: string, personId: string, page: string | null = null) {
    if (!this.source(treeId, sourceId) || !this.person(treeId, personId)) throw new Error('not in this tree')
    this.db.query('INSERT INTO citations (source_id,person_id,page) VALUES (?,?,?) ON CONFLICT(source_id,person_id) DO UPDATE SET page = excluded.page').run(sourceId, personId, clean(page, 500))
  }

  uncite(sourceId: string, personId: string) {
    this.db.query('DELETE FROM citations WHERE source_id = ? AND person_id = ?').run(sourceId, personId)
  }

  citationsFor(treeId: string, personId: string): (Source & { page: string | null })[] {
    return this.db.query<Source & { page: string | null }, [string, string]>('SELECT s.*, c.page FROM citations c JOIN sources s ON s.id = c.source_id WHERE c.person_id = ? AND s.tree_id = ? ORDER BY s.title').all(personId, treeId)
  }

  citationsAll(treeId: string): { source_id: string; person_id: string; page: string | null }[] {
    return this.db.query<any, [string]>('SELECT c.* FROM citations c JOIN sources s ON s.id = c.source_id WHERE s.tree_id = ?').all(treeId)
  }

  addMedia(treeId: string, personId: string | null, file: { filename: string; mime: string; data: Uint8Array; caption?: string | null }): Media {
    if (personId && !this.person(treeId, personId)) throw new Error('person is not in this tree')
    const id = newId()
    this.db.query('INSERT INTO media (id,tree_id,person_id,filename,mime,size,caption,data,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, treeId, personId, clean(file.filename, 200) ?? 'photo', file.mime, file.data.byteLength, clean(file.caption, 1000), file.data, this.now())
    if (personId) this.db.query('UPDATE people SET photo_id = coalesce(photo_id, ?) WHERE id = ?').run(id, personId)
    return this.mediaInfo(treeId, id)!
  }

  mediaInfo(treeId: string, id: string): Media | null {
    return this.db.query<Media, [string, string]>('SELECT id,tree_id,person_id,filename,mime,size,caption,created_at FROM media WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  mediaData(treeId: string, id: string): (Media & { data: Uint8Array }) | null {
    return this.db.query<Media & { data: Uint8Array }, [string, string]>('SELECT * FROM media WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  mediaFor(treeId: string, personId: string): Media[] {
    return this.db.query<Media, [string, string]>('SELECT id,tree_id,person_id,filename,mime,size,caption,created_at FROM media WHERE tree_id = ? AND person_id = ? ORDER BY created_at').all(treeId, personId)
  }

  deleteMedia(treeId: string, id: string) {
    this.tx(() => {
      this.db.query('UPDATE people SET photo_id = NULL WHERE tree_id = ? AND photo_id = ?').run(treeId, id)
      this.db.query('DELETE FROM media WHERE tree_id = ? AND id = ?').run(treeId, id)
    })
  }

  setPhoto(treeId: string, personId: string, mediaId: string | null) {
    if (mediaId && !this.mediaInfo(treeId, mediaId)) return
    this.db.query('UPDATE people SET photo_id = ? WHERE tree_id = ? AND id = ?').run(mediaId, treeId, personId)
  }

  stats(treeId: string) {
    const one = (sql: string) => this.db.query<{ n: number }, [string]>(sql).get(treeId)?.n ?? 0
    return {
      people: one('SELECT COUNT(*) AS n FROM people WHERE tree_id = ?'),
      families: one('SELECT COUNT(*) AS n FROM families WHERE tree_id = ?'),
      sources: one('SELECT COUNT(*) AS n FROM sources WHERE tree_id = ?'),
      photos: one('SELECT COUNT(*) AS n FROM media WHERE tree_id = ?'),
      surnames: one("SELECT COUNT(DISTINCT surname) AS n FROM people WHERE tree_id = ? AND surname != ''"),
    }
  }
}
