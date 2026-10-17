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
/** Signed in with an email of their own (a magic link proved it), not only through pit.world. */
export const emailVerified = (user: Pick<User, 'email'> | null | undefined) => Boolean(user?.email) && !user!.email.endsWith('@pit.invalid')

export type User = { id: string; email: string; name: string | null; created_at: number }
export type Tree = { id: string; name: string; description: string | null; owner_id: string; home_person_id: string | null; created_at: number; plan_paid_at: number | null }
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
  /** 'person', or 'pet' (Family plan): a pet has owners, never parents or partners. */
  kind: 'person' | 'pet'
  species: string | null
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
  /** How it ended: divorced, separated or widowed. Null with an end_date is a divorce (before 0.6.1). */
  end_kind?: string | null
  end_place?: string | null
  created_at: number
}
export type Event = { id: string; tree_id: string; person_id: string; type: string; date: string | null; place: string | null; description: string | null; created_at: number }
export type Source = { id: string; tree_id: string; title: string; author: string | null; url: string | null; citation: string | null; created_at: number }
export type Media = { id: string; tree_id: string; person_id: string | null; business_id?: string | null; album_id?: string | null; uploaded_by?: string | null; filename: string; mime: string; size: number; caption: string | null; created_at: number }
/** A named set of photos in a tree: "Christmas 1985", "Grandma's 90th". */
export type Album = { id: string; tree_id: string; title: string; description: string | null; created_by: string; cover_id: string | null; created_at: number }
export type Invite = { id: string; tree_id: string; role: 'editor' | 'viewer'; email: string | null; person_id: string | null; note: string | null; created_by: string; created_at: number; expires_at: number; used_by: string | null }
export type Association = { id: string; tree_id: string; person_id: string; other_id: string; kind: string; note: string | null; created_at: number }
export type Payment = { ref: string; tree_id: string; user_id: string; amount_cents: number; currency: string; chain: string | null; status: string; created_at: number; updated_at: number }
export type Business = {
  id: string
  tree_id: string
  name: string
  category: string | null
  founded: string | null
  closed: string | null
  place: string | null
  website: string | null
  notes: string | null
  photo_id: string | null
  created_at: number
  updated_at: number
}
export type BusinessRole = { id: string; tree_id: string; business_id: string; person_id: string; role: string; title: string | null; start_date: string | null; end_date: string | null; note: string | null; created_at: number }
export type SiblingKind = 'full' | 'half' | 'step' | 'adoptive' | 'foster'
export type Sibling = { person: Person; kind: SiblingKind; via: Person | null }
/** `union` is the partnership's kind on a partner step: married, partners or dating. */
export type PathStep = { person: Person; step: 'self' | 'parent' | 'child' | 'partner'; relation?: string; union?: string }
/** What a partnership can be. Divorced is a marriage with an end date. */
export const UNION_KINDS = ['married', 'partners', 'dating'] as const
export type Descendant = { person: Person; unions: { partner: Person | null; children: Descendant[] }[] }

export const PERSON_FIELDS = ['given', 'surname', 'sex', 'birth_date', 'birth_place', 'death_date', 'death_place', 'living', 'notes', 'species'] as const

/** How a child belongs to a family. GEDCOM's PEDI values, minus LDS sealing. */
/** How a partnership ended. */
export const UNION_ENDS = ['divorced', 'separated', 'widowed'] as const
export const CHILD_RELATIONS = ['birth', 'adopted', 'step', 'foster'] as const

/**
 * Bonds that are not a line of descent: the grandparents who raised you, a
 * godparent, a guardian. Each reads two ways, from the person and from the other
 * one; `as` is what the other is to the person, `back` what the person is to them.
 * A pet's owner is a bond too, which is what keeps pets out of every bloodline walk.
 */
export const BONDS: Record<string, { as: string; back: string }> = {
  raised_by: { as: 'Raised by', back: 'Raised' },
  guardian: { as: 'Guardian', back: 'Ward' },
  godparent: { as: 'Godparent', back: 'Godchild' },
  caregiver: { as: 'Caregiver', back: 'Cared for' },
  chosen_family: { as: 'Chosen family', back: 'Chosen family' },
  friend: { as: 'Friend', back: 'Friend' },
  neighbor: { as: 'Neighbor', back: 'Neighbor' },
  pet: { as: 'Owner', back: 'Pet' },
}
export const bondKind = (value: unknown): string | null => {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (BONDS[v]) return v
  // GEDCOM RELA text ("Raised by", "Godparent") maps back to its key.
  const byLabel = Object.entries(BONDS).find(([, b]) => b.as.toLowerCase() === String(value ?? '').trim().toLowerCase())
  return byLabel?.[0] ?? null
}
/**
 * What a person was to a business. Businesses are their own entries, never
 * people: they have no parents or partners, so no bloodline walk can reach one.
 */
export const BUSINESS_ROLES: Record<string, string> = {
  founder: 'Founder',
  owner: 'Owner',
  partner: 'Partner',
  investor: 'Investor',
  officer: 'Officer',
  manager: 'Manager',
  employee: 'Employee',
  apprentice: 'Apprentice',
  other: 'Other',
}
export const businessRole = (value: unknown): string | null => {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (BUSINESS_ROLES[v]) return v
  const byLabel = Object.entries(BUSINESS_ROLES).find(([, label]) => label.toLowerCase() === v.replace(/_/g, ' '))
  return byLabel?.[0] ?? null
}
export const BUSINESS_FIELDS = ['name', 'category', 'founded', 'closed', 'place', 'website', 'notes'] as const
export type BusinessInput = Partial<Pick<Business, (typeof BUSINESS_FIELDS)[number]>>

/** A web address, or nothing: "ettingerplumbing.com" becomes https://ettingerplumbing.com. */
export const cleanUrl = (value: unknown): string | null => {
  const url = clean(value, 500)
  if (!url || !/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(url)) return null
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

export function normalizeBusiness(input: Record<string, unknown>): BusinessInput {
  const out: BusinessInput = {}
  if ('name' in input) out.name = clean(input.name, 200) ?? ''
  if ('category' in input) out.category = clean(input.category, 80)
  for (const key of ['founded', 'closed', 'place'] as const) if (key in input) out[key] = clean(input[key], 200)
  if ('website' in input) out.website = cleanUrl(input.website)
  if ('notes' in input) out.notes = clean(input.notes, 20_000)
  return out
}

export type PersonInput = Partial<Pick<Person, (typeof PERSON_FIELDS)[number]>>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_identities (
  token_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, name TEXT, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject)
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
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, cover_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS albums_tree ON albums(tree_id);
CREATE TABLE IF NOT EXISTS associations (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL,
  UNIQUE (person_id, other_id, kind)
);
CREATE INDEX IF NOT EXISTS associations_other ON associations(other_id);
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  name TEXT NOT NULL, category TEXT, founded TEXT, closed TEXT, place TEXT, website TEXT, notes TEXT, photo_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS businesses_tree ON businesses(tree_id, name);
CREATE TABLE IF NOT EXISTS business_roles (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL, title TEXT, start_date TEXT, end_date TEXT, note TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS business_roles_business ON business_roles(business_id);
CREATE INDEX IF NOT EXISTS business_roles_person ON business_roles(person_id);
CREATE TABLE IF NOT EXISTS business_contacts (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (business_id, user_id)
);
CREATE TABLE IF NOT EXISTS payments (
  ref TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, chain TEXT,
  status TEXT NOT NULL, raw TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`


/** divorced, separated or widowed; anything else is no ending kind. */
export const unionEnd = (value: unknown): string | null => ((UNION_ENDS as readonly string[]).includes(String(value ?? '').toLowerCase()) ? String(value).toLowerCase() : null)

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
  if ('species' in input) out.species = clean(input.species, 80)
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
    const inviteCols = this.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('invites')").all().map((c) => c.name)
    if (!inviteCols.includes('person_id')) this.db.run('ALTER TABLE invites ADD COLUMN person_id TEXT')
    if (!inviteCols.includes('note')) this.db.run('ALTER TABLE invites ADD COLUMN note TEXT')
    // 0.3.0: pets, and the one-time Family plan.
    const peopleCols = this.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('people')").all().map((c) => c.name)
    if (!peopleCols.includes('kind')) this.db.run("ALTER TABLE people ADD COLUMN kind TEXT NOT NULL DEFAULT 'person'")
    if (!peopleCols.includes('species')) this.db.run('ALTER TABLE people ADD COLUMN species TEXT')
    const treeCols = this.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('trees')").all().map((c) => c.name)
    if (!treeCols.includes('plan_paid_at')) this.db.run('ALTER TABLE trees ADD COLUMN plan_paid_at INTEGER')
    // 0.5.0: photos of a business.
    const mediaCols = this.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('media')").all().map((c) => c.name)
    if (!mediaCols.includes('business_id')) this.db.run('ALTER TABLE media ADD COLUMN business_id TEXT REFERENCES businesses(id) ON DELETE SET NULL')
    // 0.6.1: how a partnership ended, and where.
    const familyCols = this.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('families')").all().map((c) => c.name)
    if (!familyCols.includes('end_kind')) this.db.run('ALTER TABLE families ADD COLUMN end_kind TEXT')
    if (!familyCols.includes('end_place')) this.db.run('ALTER TABLE families ADD COLUMN end_place TEXT')
    // 0.6.0: the family photo album. Who uploaded a photo, and which album it is in.
    if (!mediaCols.includes('album_id')) this.db.run('ALTER TABLE media ADD COLUMN album_id TEXT REFERENCES albums(id) ON DELETE SET NULL')
    if (!mediaCols.includes('uploaded_by')) this.db.run('ALTER TABLE media ADD COLUMN uploaded_by TEXT')
    this.db.run('CREATE INDEX IF NOT EXISTS media_album ON media(album_id)')
    this.db.run('CREATE INDEX IF NOT EXISTS media_tree_created ON media(tree_id, created_at)')
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

  // ---- sign in with pit.world (one account for every *.pit.world site) ----

  /** The account a pit.world sign-in (its CoinPay DID) is linked to. Email never links: pit.world cannot vouch for it. */
  userByIdentity(provider: string, subject: string): User | null {
    const row = this.db.query<{ user_id: string }, [string, string]>('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').get(provider, subject)
    return row ? this.user(row.user_id) : null
  }

  identities(userId: string): { provider: string; subject: string; created_at: number }[] {
    return this.db.query<any, [string]>('SELECT provider, subject, created_at FROM user_identities WHERE user_id = ? ORDER BY created_at').all(userId)
  }

  linkIdentity(userId: string, provider: string, subject: string) {
    this.db.query('INSERT OR REPLACE INTO user_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)').run(provider, subject, userId, this.now())
  }

  unlinkIdentity(userId: string, provider: string) {
    this.db.query('DELETE FROM user_identities WHERE user_id = ? AND provider = ?').run(userId, provider)
  }

  /** A pit.world sign-in with no account here yet, held until they say which account is theirs. */
  holdIdentity(provider: string, subject: string, name: string | null, minutes = 30): string {
    const token = newId(24)
    this.db.query('DELETE FROM pending_identities WHERE expires_at < ?').run(this.now())
    this.db.query('INSERT INTO pending_identities (token_hash, provider, subject, name, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256(token), provider, subject, clean(name, 120), this.now() + minutes * 60_000)
    return token
  }

  heldIdentity(token: string | null | undefined): { provider: string; subject: string; name: string | null } | null {
    if (!token) return null
    const row = this.db.query<{ provider: string; subject: string; name: string | null; expires_at: number }, [string]>('SELECT provider, subject, name, expires_at FROM pending_identities WHERE token_hash = ?').get(sha256(token))
    return row && row.expires_at > this.now() ? { provider: row.provider, subject: row.subject, name: row.name } : null
  }

  dropHeldIdentity(token: string) {
    this.db.query('DELETE FROM pending_identities WHERE token_hash = ?').run(sha256(token))
  }

  /** A new account for someone who arrived by pit.world: no email of theirs (an address nothing is sent to), their name. */
  createBridgedUser(provider: string, subject: string, name: string | null): User {
    const id = newId()
    const placeholder = `${sha256(`${provider}\u0000${subject}`).slice(0, 24)}@pit.invalid`
    this.tx(() => {
      this.db.query('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)').run(id, placeholder, clean(name, 120), this.now())
      this.linkIdentity(id, provider, subject)
    })
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
    const row = this.db.query<any, [string]>('SELECT token_hash AS id, tree_id, role, email, person_id, note, created_by, created_at, expires_at, used_by FROM invites WHERE token_hash = ?').get(sha256(token))
    return row && row.expires_at > this.now() && !row.used_by ? row : null
  }

  /** Invites not yet used or expired, newest first. `id` is the token's hash, safe to show. */
  pendingInvites(treeId: string): Invite[] {
    return this.db.query<Invite, [string, number]>('SELECT token_hash AS id, tree_id, role, email, person_id, note, created_by, created_at, expires_at, used_by FROM invites WHERE tree_id = ? AND used_by IS NULL AND expires_at > ? ORDER BY created_at DESC').all(treeId, this.now())
  }

  revokeInvite(treeId: string, id: string) {
    this.db.query('DELETE FROM invites WHERE tree_id = ? AND token_hash = ? AND used_by IS NULL').run(treeId, id)
  }

  /** The tree joined and, for a profile invite, the person the new member now is. */
  acceptInvite(token: string, userId: string): { tree_id: string; person_id: string | null; mismatch: boolean } | null {
    const invite = this.invite(token)
    if (!invite) return null
    let claimed: string | null = null
    // A profile is yours only if the invite went to the address you signed in with (and so proved).
    const mismatch = Boolean(invite.person_id && invite.email && this.user(userId)?.email !== invite.email)
    this.tx(() => {
      const current = this.role(invite.tree_id, userId)
      // An invite never demotes: an owner who clicks a viewer link stays owner.
      if (!current || (current === 'viewer' && invite.role === 'editor')) this.setMember(invite.tree_id, userId, invite.role)
      if (invite.person_id && !mismatch && this.claimProfile(invite.tree_id, invite.person_id, userId)) claimed = invite.person_id
      this.db.query('UPDATE invites SET used_by = ? WHERE token_hash = ?').run(userId, sha256(token))
    })
    return { tree_id: invite.tree_id, person_id: claimed, mismatch }
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

  addPerson(treeId: string, input: Record<string, unknown>, kind: 'person' | 'pet' = 'person'): Person {
    const p = normalizePerson(input)
    const id = newId()
    const now = this.now()
    this.db
      .query(
        `INSERT INTO people (id,tree_id,given,surname,sex,birth_date,birth_place,death_date,death_place,living,notes,kind,species,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, treeId, p.given ?? '', p.surname ?? '', p.sex ?? 'U', p.birth_date ?? null, p.birth_place ?? null, p.death_date ?? null, p.death_place ?? null, p.living ?? 0, p.notes ?? null, kind, kind === 'pet' ? (p.species ?? null) : null, now, now)
    if (kind === 'person' && !this.tree(treeId)?.home_person_id) this.updateTree(treeId, { home_person_id: id })
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
      .query('UPDATE people SET given = ?, surname = ?, sex = ?, birth_date = ?, birth_place = ?, death_date = ?, death_place = ?, living = ?, notes = ?, species = ?, updated_at = ? WHERE tree_id = ? AND id = ?')
      .run(p.given, p.surname, p.sex, p.birth_date, p.birth_place, p.death_date, p.death_place, p.living, p.notes, current.kind === 'pet' ? p.species : null, this.now(), treeId, id)
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

  createFamily(treeId: string, partner1: string | null, partner2: string | null, fields: { kind?: string; start_date?: string | null; start_place?: string | null; end_date?: string | null; end_kind?: string | null; end_place?: string | null } = {}): Family {
    for (const pid of [partner1, partner2]) if (pid && !this.person(treeId, pid)) throw new Error('partner is not in this tree')
    for (const pid of [partner1, partner2]) if (pid && this.person(treeId, pid)!.kind === 'pet') throw new Error('pets have owners, not partners')
    if (partner1 && partner1 === partner2) throw new Error('a person cannot partner themselves')
    const id = newId()
    this.db
      .query('INSERT INTO families (id,tree_id,partner1_id,partner2_id,kind,start_date,start_place,end_date,end_kind,end_place,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, treeId, partner1, partner2, clean(fields.kind, 40) ?? 'married', clean(fields.start_date, 200), clean(fields.start_place, 200), clean(fields.end_date, 200), unionEnd(fields.end_kind), clean(fields.end_place, 200), this.now())
    return this.family(treeId, id)!
  }

  updateFamily(treeId: string, id: string, fields: { kind?: string; start_date?: string | null; start_place?: string | null; end_date?: string | null; end_kind?: string | null; end_place?: string | null }) {
    const f = this.family(treeId, id)
    if (!f) return
    const pick = (key: 'start_date' | 'start_place' | 'end_date' | 'end_place') => (fields[key] !== undefined ? clean(fields[key], 200) : (f[key] ?? null))
    const kind = fields.kind !== undefined ? (clean(fields.kind, 40) ?? 'married') : f.kind
    const endKind = fields.end_kind !== undefined ? unionEnd(fields.end_kind) : (f.end_kind ?? null)
    this.db.query('UPDATE families SET kind = ?, start_date = ?, start_place = ?, end_date = ?, end_kind = ?, end_place = ? WHERE tree_id = ? AND id = ?').run(kind, pick('start_date'), pick('start_place'), pick('end_date'), endKind, pick('end_place'), treeId, id)
  }

  /** Fill an empty partner slot (a single parent who later gets a known partner). */
  setPartner(treeId: string, familyId: string, personId: string) {
    const fam = this.family(treeId, familyId)
    if (!fam || !this.person(treeId, personId)) throw new Error('not in this tree')
    if (this.person(treeId, personId)!.kind === 'pet') throw new Error('pets have owners, not partners')
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
    if (this.person(treeId, childId)!.kind === 'pet') throw new Error('pets have owners, not parents')
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

  /**
   * How two people are related, as the chain of steps from a to b (parent / child / partner), shortest first.
   * Each parent or child step carries how that child belongs to that family (birth, adopted, step, foster),
   * so the words can say "adoptive mother" instead of "mother".
   */
  relationship(treeId: string, a: string, b: string, maxSteps = 12): PathStep[] | null {
    if (!this.person(treeId, a) || !this.person(treeId, b)) return null
    type Hop = { step: 'parent' | 'child' | 'partner'; relation?: string; union?: string }
    const prev = new Map<string, Hop & { from: string }>()
    const depth = new Map<string, number>([[a, 0]])
    const queue = [a]
    // Blood steps first, so a full sibling is reached through a birth parent before a step-parent.
    const rank = (r?: string) => (!r || r === 'birth' ? 0 : 1)
    while (queue.length) {
      const id = queue.shift()!
      if (id === b) break
      if (depth.get(id)! >= maxSteps) continue
      const next: [string, Hop][] = [
        ...this.parentFamilies(treeId, id).flatMap((f) => f.parents.map((p) => [p.id, { step: 'parent', relation: f.relation }] as [string, Hop])),
        ...this.spouseFamilies(treeId, id).flatMap((u) => [
          ...(u.partner ? [[u.partner.id, { step: 'partner', union: u.family.kind }] as [string, Hop]] : []),
          ...this.childLinksOf(treeId, u.family.id).map((c) => [c.person_id, { step: 'child', relation: c.relation }] as [string, Hop]),
        ]),
      ].sort((x, y) => rank(x[1].relation) - rank(y[1].relation))
      for (const [nid, hop] of next) {
        if (depth.has(nid)) continue
        depth.set(nid, depth.get(id)! + 1)
        prev.set(nid, { from: id, ...hop })
        queue.push(nid)
      }
    }
    if (!depth.has(b)) return null
    const path: PathStep[] = []
    for (let id: string | undefined = b; id; id = prev.get(id)?.from) {
      const hop = prev.get(id)
      path.unshift({ person: this.person(treeId, id)!, step: hop?.step ?? 'self', ...(hop?.relation ? { relation: hop.relation } : {}), ...(hop?.union ? { union: hop.union } : {}) })
    }
    return path
  }

  childLinksOf(treeId: string, familyId: string): { person_id: string; relation: string }[] {
    return this.db.query<{ person_id: string; relation: string }, [string, string]>('SELECT c.person_id, c.relation FROM children c JOIN families f ON f.id = c.family_id WHERE c.family_id = ? AND f.tree_id = ? ORDER BY c.position').all(familyId, treeId)
  }

  /**
   * Everyone who is a brother or sister in any sense, each once, closest kind first:
   *   full      same family, both by birth
   *   adoptive  same family, one or both adopted in
   *   foster    same family, one or both fostered
   *   half      shares one birth parent through a different family
   *   step      same family as a step-child, or a child of a parent's other partner
   */
  siblings(treeId: string, personId: string): Sibling[] {
    const out = new Map<string, Sibling>()
    const order: SiblingKind[] = ['full', 'adoptive', 'foster', 'half', 'step']
    const put = (person: Person | null, kind: SiblingKind, via: Person | null) => {
      if (!person || person.id === personId) return
      const had = out.get(person.id)
      if (!had || order.indexOf(kind) < order.indexOf(had.kind)) out.set(person.id, { person, kind, via })
    }
    const mine = this.parentFamilies(treeId, personId)
    const myFamilyIds = new Set(mine.map((f) => f.family.id))
    for (const f of mine) {
      for (const c of this.childLinksOf(treeId, f.family.id)) {
        const rels = [f.relation, c.relation]
        const kind: SiblingKind = rels.includes('step') ? 'step' : rels.includes('foster') ? 'foster' : rels.includes('adopted') ? 'adoptive' : 'full'
        put(this.person(treeId, c.person_id), kind, null)
      }
    }
    for (const f of mine) {
      for (const parent of f.parents) {
        for (const other of this.spouseFamilies(treeId, parent.id)) {
          if (myFamilyIds.has(other.family.id)) continue
          for (const c of this.childLinksOf(treeId, other.family.id)) {
            put(this.person(treeId, c.person_id), f.relation === 'birth' && c.relation === 'birth' ? 'half' : 'step', parent)
          }
          // A parent's partner who is not your parent is a step-parent; their children from elsewhere are step-siblings.
          const stepParent = other.partner
          if (!stepParent || f.parents.some((p) => p.id === stepParent.id)) continue
          for (const theirs of this.spouseFamilies(treeId, stepParent.id)) {
            if (theirs.family.id === other.family.id || myFamilyIds.has(theirs.family.id)) continue
            for (const c of theirs.children) put(c, 'step', stepParent)
          }
        }
      }
    }
    return [...out.values()].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || (x.person.birth_date ?? '').localeCompare(y.person.birth_date ?? ''))
  }

  /** Per partnership: the partner's children by someone else, who are this person's step-children. */
  stepChildren(treeId: string, personId: string): { familyId: string; children: Person[] }[] {
    const unions = this.spouseFamilies(treeId, personId)
    const mine = new Set(unions.flatMap((u) => u.children.map((c) => c.id)))
    return unions
      .filter((u) => u.partner)
      .map((u) => ({ familyId: u.family.id, children: this.spouseFamilies(treeId, u.partner!.id).filter((x) => x.family.id !== u.family.id && x.partner?.id !== personId).flatMap((x) => x.children).filter((c) => !mine.has(c.id) && c.id !== personId) }))
      .filter((x) => x.children.length)
  }

  /** People who are partners of this person's parents but not their parent. */
  stepParents(treeId: string, personId: string): Person[] {
    const mine = this.parentFamilies(treeId, personId)
    const parents = new Set(mine.flatMap((f) => f.parents.map((p) => p.id)))
    const out = new Map<string, Person>()
    for (const f of mine) for (const p of f.parents) for (const u of this.spouseFamilies(treeId, p.id)) if (u.partner && !parents.has(u.partner.id)) out.set(u.partner.id, u.partner)
    return [...out.values()]
  }

  // ---- bonds outside the bloodline, and pets -------------------------------

  /** `other` is `kind` to `person`: addBond(t, me, grandma, 'raised_by'). */
  addBond(treeId: string, personId: string, otherId: string, kind: string, note: string | null = null): Association {
    const k = bondKind(kind)
    if (!k) throw new Error(`kind must be one of: ${Object.keys(BONDS).join(', ')}`)
    const person = this.person(treeId, personId)
    const other = this.person(treeId, otherId)
    if (!person || !other) throw new Error('not in this tree')
    if (person.id === other.id) throw new Error('a bond needs two people')
    if (k === 'pet' ? person.kind !== 'pet' || other.kind === 'pet' : person.kind === 'pet' || other.kind === 'pet') throw new Error(k === 'pet' ? 'a pet bond joins a pet to a person' : 'pets have owners, not family bonds')
    this.db.query('INSERT OR IGNORE INTO associations (id,tree_id,person_id,other_id,kind,note,created_at) VALUES (?,?,?,?,?,?,?)').run(newId(), treeId, personId, otherId, k, clean(note, 500), this.now())
    return this.db.query<Association, [string, string, string]>('SELECT * FROM associations WHERE person_id = ? AND other_id = ? AND kind = ?').get(personId, otherId, k)!
  }

  removeBond(treeId: string, id: string) {
    this.db.query('DELETE FROM associations WHERE tree_id = ? AND id = ?').run(treeId, id)
  }

  bond(treeId: string, id: string): Association | null {
    return this.db.query<Association, [string, string]>('SELECT * FROM associations WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  /** Every bond touching this person, worded from their side: "Raised by Grandma", "Godchild Sam". */
  bondsFor(treeId: string, personId: string): { id: string; kind: string; label: string; other: Person; note: string | null }[] {
    const rows = this.db.query<Association, [string, string, string]>('SELECT * FROM associations WHERE tree_id = ? AND (person_id = ? OR other_id = ?) ORDER BY created_at, rowid').all(treeId, personId, personId)
    return rows.flatMap((r) => {
      const forward = r.person_id === personId
      const other = this.person(treeId, forward ? r.other_id : r.person_id)
      const words = BONDS[r.kind] ?? { as: r.kind, back: r.kind }
      return other ? [{ id: r.id, kind: r.kind, label: forward ? words.as : words.back, other, note: r.note }] : []
    })
  }

  allBonds(treeId: string): Association[] {
    return this.db.query<Association, [string]>('SELECT * FROM associations WHERE tree_id = ? ORDER BY created_at, rowid').all(treeId)
  }

  /** A pet, owned by one or more people in the tree. */
  addPet(treeId: string, input: Record<string, unknown>, ownerIds: string[]): Person {
    const owners = ownerIds.map((id) => this.person(treeId, id)).filter((p): p is Person => Boolean(p && p.kind === 'person'))
    if (!owners.length) throw new Error('a pet needs an owner in this tree')
    return this.tx(() => {
      const pet = this.addPerson(treeId, input, 'pet')
      for (const o of owners) this.addBond(treeId, pet.id, o.id, 'pet')
      return pet
    })
  }

  petsOf(treeId: string, personId: string): Person[] {
    return this.db.query<Person, [string, string]>("SELECT p.* FROM associations a JOIN people p ON p.id = a.person_id WHERE a.tree_id = ? AND a.other_id = ? AND a.kind = 'pet' ORDER BY p.given").all(treeId, personId)
  }

  /** Living people nobody has claimed yet: who a new member might be. */
  unclaimed(treeId: string): Person[] {
    return this.db
      .query<Person, [string, string]>("SELECT * FROM people p WHERE p.tree_id = ? AND p.kind = 'person' AND p.death_date IS NULL AND p.death_place IS NULL AND p.id NOT IN (SELECT person_id FROM profiles WHERE tree_id = ?) ORDER BY surname, given")
      .all(treeId, treeId)
  }

  // ---- businesses: their own entries, linked to the people in them -------

  addBusiness(treeId: string, input: Record<string, unknown>): Business {
    const b = normalizeBusiness(input)
    if (!b.name) throw new Error('give the business a name')
    const id = newId()
    const now = this.now()
    this.db
      .query('INSERT INTO businesses (id,tree_id,name,category,founded,closed,place,website,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, treeId, b.name, b.category ?? null, b.founded ?? null, b.closed ?? null, b.place ?? null, b.website ?? null, b.notes ?? null, now, now)
    return this.business(treeId, id)!
  }

  business(treeId: string, id: string): Business | null {
    return this.db.query<Business, [string, string]>('SELECT * FROM businesses WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  updateBusiness(treeId: string, id: string, input: Record<string, unknown>): Business | null {
    const current = this.business(treeId, id)
    if (!current) return null
    const b = { ...current, ...normalizeBusiness(input) }
    if (!b.name) b.name = current.name
    this.db
      .query('UPDATE businesses SET name = ?, category = ?, founded = ?, closed = ?, place = ?, website = ?, notes = ?, updated_at = ? WHERE tree_id = ? AND id = ?')
      .run(b.name, b.category, b.founded, b.closed, b.place, b.website, b.notes, this.now(), treeId, id)
    return this.business(treeId, id)
  }

  deleteBusiness(treeId: string, id: string) {
    this.tx(() => {
      this.db.query('DELETE FROM media WHERE tree_id = ? AND business_id = ?').run(treeId, id)
      this.db.query('DELETE FROM businesses WHERE tree_id = ? AND id = ?').run(treeId, id)
    })
  }

  businesses(treeId: string, limit = 5000): Business[] {
    return this.db.query<Business, [string, number]>('SELECT * FROM businesses WHERE tree_id = ? ORDER BY name LIMIT ?').all(treeId, limit)
  }

  /** Every word must appear in the name, what it does, the place, a date, or the name of someone in it. */
  searchBusinesses(treeId: string, query: string, limit = 50): Business[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
    if (!words.length) return this.businesses(treeId, limit)
    const people = new Map<string, string>()
    for (const r of this.db.query<{ business_id: string; given: string; surname: string }, [string]>('SELECT r.business_id, p.given, p.surname FROM business_roles r JOIN people p ON p.id = r.person_id WHERE r.tree_id = ?').all(treeId)) {
      people.set(r.business_id, `${people.get(r.business_id) ?? ''} ${r.given} ${r.surname}`)
    }
    const hay = (b: Business) => [b.name, b.category, b.place, b.founded, b.closed, people.get(b.id)].filter(Boolean).join(' ').toLowerCase()
    return this.businesses(treeId).filter((b) => words.every((w) => hay(b).includes(w))).slice(0, limit)
  }

  /** `person` was `role` at `business`, optionally with a title and the years. */
  addBusinessRole(treeId: string, businessId: string, personId: string, input: { role?: unknown; title?: unknown; start_date?: unknown; end_date?: unknown; note?: unknown }): BusinessRole {
    const role = businessRole(input.role ?? 'owner')
    if (!role) throw new Error(`role must be one of: ${Object.keys(BUSINESS_ROLES).join(', ')}`)
    if (!this.business(treeId, businessId)) throw new Error('no such business in this tree')
    const person = this.person(treeId, personId)
    if (!person) throw new Error('that person is not in this tree')
    if (person.kind === 'pet') throw new Error('pets do not run businesses')
    const id = newId()
    this.db
      .query('INSERT INTO business_roles (id,tree_id,business_id,person_id,role,title,start_date,end_date,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, treeId, businessId, personId, role, clean(input.title, 120), clean(input.start_date, 200), clean(input.end_date, 200), clean(input.note, 500), this.now())
    return this.businessRoleRow(treeId, id)!
  }

  businessRoleRow(treeId: string, id: string): BusinessRole | null {
    return this.db.query<BusinessRole, [string, string]>('SELECT * FROM business_roles WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  removeBusinessRole(treeId: string, id: string) {
    this.db.query('DELETE FROM business_roles WHERE tree_id = ? AND id = ?').run(treeId, id)
  }

  /** The people in a business: founders first, then owners, partners, investors and staff, earliest first. */
  businessPeople(treeId: string, businessId: string): (BusinessRole & { person: Person })[] {
    const order = Object.keys(BUSINESS_ROLES)
    const rows = this.db.query<BusinessRole, [string, string]>('SELECT * FROM business_roles WHERE tree_id = ? AND business_id = ? ORDER BY start_date IS NULL, start_date, created_at, rowid').all(treeId, businessId)
    return rows
      .flatMap((r) => {
        const person = this.person(treeId, r.person_id)
        return person ? [{ ...r, person }] : []
      })
      .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
  }

  /** The businesses a person was part of, and as what. */
  businessesOf(treeId: string, personId: string): (BusinessRole & { business: Business })[] {
    const rows = this.db.query<BusinessRole, [string, string]>('SELECT * FROM business_roles WHERE tree_id = ? AND person_id = ? ORDER BY start_date IS NULL, start_date, created_at, rowid').all(treeId, personId)
    return rows.flatMap((r) => {
      const business = this.business(treeId, r.business_id)
      return business ? [{ ...r, business }] : []
    })
  }

  allBusinessRoles(treeId: string): BusinessRole[] {
    return this.db.query<BusinessRole, [string]>('SELECT * FROM business_roles WHERE tree_id = ? ORDER BY created_at, rowid').all(treeId)
  }

  addBusinessMedia(treeId: string, businessId: string, file: { filename: string; mime: string; data: Uint8Array; caption?: string | null }): Media {
    if (!this.business(treeId, businessId)) throw new Error('no such business in this tree')
    const id = newId()
    this.db.query('INSERT INTO media (id,tree_id,person_id,business_id,filename,mime,size,caption,data,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, treeId, null, businessId, clean(file.filename, 200) ?? 'photo', file.mime, file.data.byteLength, clean(file.caption, 1000), file.data, this.now())
    this.db.query('UPDATE businesses SET photo_id = coalesce(photo_id, ?) WHERE id = ?').run(id, businessId)
    return this.mediaInfo(treeId, id)!
  }

  businessMedia(treeId: string, businessId: string): Media[] {
    return this.db.query<Media, [string, string]>('SELECT id,tree_id,person_id,business_id,album_id,uploaded_by,filename,mime,size,caption,created_at FROM media WHERE tree_id = ? AND business_id = ? ORDER BY created_at').all(treeId, businessId)
  }

  setBusinessPhoto(treeId: string, businessId: string, mediaId: string | null) {
    if (mediaId && this.mediaInfo(treeId, mediaId)?.business_id !== businessId) return
    this.db.query('UPDATE businesses SET photo_id = ? WHERE tree_id = ? AND id = ?').run(mediaId, treeId, businessId)
  }

  /**
   * Your own Network contact for this business. Contacts are private, so the
   * link is per member: each of you sees only your own.
   */
  businessContact(businessId: string, userId: string): string | null {
    return this.db.query<{ contact_id: string }, [string, string]>('SELECT contact_id FROM business_contacts WHERE business_id = ? AND user_id = ?').get(businessId, userId)?.contact_id ?? null
  }

  setBusinessContact(businessId: string, userId: string, contactId: string | null) {
    if (!contactId) this.db.query('DELETE FROM business_contacts WHERE business_id = ? AND user_id = ?').run(businessId, userId)
    else this.db.query('INSERT INTO business_contacts (business_id,user_id,contact_id,created_at) VALUES (?,?,?,?) ON CONFLICT(business_id,user_id) DO UPDATE SET contact_id = excluded.contact_id').run(businessId, userId, contactId, this.now())
  }

  // ---- the Family plan: one payment per tree, for good -------------------

  markPaid(treeId: string) {
    this.db.query('UPDATE trees SET plan_paid_at = coalesce(plan_paid_at, ?) WHERE id = ?').run(this.now(), treeId)
  }

  recordPayment(p: { ref: string; tree_id: string; user_id: string; amount_cents: number; currency: string; chain: string | null; raw: unknown }) {
    this.db
      .query('INSERT OR IGNORE INTO payments (ref,tree_id,user_id,amount_cents,currency,chain,status,raw,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(p.ref, p.tree_id, p.user_id, p.amount_cents, p.currency, p.chain, 'pending', JSON.stringify(p.raw ?? null), this.now(), this.now())
  }

  payment(ref: string): Payment | null {
    return this.db.query<Payment, [string]>('SELECT ref,tree_id,user_id,amount_cents,currency,chain,status,created_at,updated_at FROM payments WHERE ref = ?').get(ref) ?? null
  }

  paymentsFor(treeId: string): Payment[] {
    return this.db.query<Payment, [string]>('SELECT ref,tree_id,user_id,amount_cents,currency,chain,status,created_at,updated_at FROM payments WHERE tree_id = ? ORDER BY created_at DESC').all(treeId)
  }

  /** Record a webhook's status. Settling marks the tree paid, in the same transaction. Unknown refs are ignored. */
  settlePayment(ref: string, status: string, raw: unknown, settled: boolean): Payment | null {
    return this.tx(() => {
      this.db.query('UPDATE payments SET status = ?, raw = ?, updated_at = ? WHERE ref = ?').run(status || 'unknown', JSON.stringify(raw ?? null), this.now(), ref)
      const p = this.payment(ref)
      if (p && settled) this.markPaid(p.tree_id)
      return p
    })
  }

  /** Whether this user is a member of any tree on the Family plan. */
  inPaidTree(userId: string): boolean {
    return Boolean(this.db.query<{ n: number }, [string]>('SELECT 1 AS n FROM members m JOIN trees t ON t.id = m.tree_id WHERE m.user_id = ? AND t.plan_paid_at IS NOT NULL LIMIT 1').get(userId))
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

  addMedia(treeId: string, personId: string | null, file: { filename: string; mime: string; data: Uint8Array; caption?: string | null; albumId?: string | null; uploadedBy?: string | null }): Media {
    if (personId && !this.person(treeId, personId)) throw new Error('person is not in this tree')
    if (file.albumId && !this.album(treeId, file.albumId)) throw new Error('no such album in this tree')
    const id = newId()
    this.db.query('INSERT INTO media (id,tree_id,person_id,album_id,uploaded_by,filename,mime,size,caption,data,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, treeId, personId, file.albumId ?? null, file.uploadedBy ?? null, clean(file.filename, 200) ?? 'photo', file.mime, file.data.byteLength, clean(file.caption, 1000), file.data, this.now())
    if (personId) this.db.query('UPDATE people SET photo_id = coalesce(photo_id, ?) WHERE id = ?').run(id, personId)
    return this.mediaInfo(treeId, id)!
  }

  mediaInfo(treeId: string, id: string): Media | null {
    return this.db.query<Media, [string, string]>('SELECT id,tree_id,person_id,business_id,album_id,uploaded_by,filename,mime,size,caption,created_at FROM media WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  mediaData(treeId: string, id: string): (Media & { data: Uint8Array }) | null {
    return this.db.query<Media & { data: Uint8Array }, [string, string]>('SELECT * FROM media WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  mediaFor(treeId: string, personId: string): Media[] {
    return this.db.query<Media, [string, string]>('SELECT id,tree_id,person_id,business_id,album_id,uploaded_by,filename,mime,size,caption,created_at FROM media WHERE tree_id = ? AND person_id = ? ORDER BY created_at').all(treeId, personId)
  }

  deleteMedia(treeId: string, id: string) {
    this.tx(() => {
      this.db.query('UPDATE people SET photo_id = NULL WHERE tree_id = ? AND photo_id = ?').run(treeId, id)
      this.db.query('UPDATE businesses SET photo_id = NULL WHERE tree_id = ? AND photo_id = ?').run(treeId, id)
      this.db.query('UPDATE albums SET cover_id = NULL WHERE tree_id = ? AND cover_id = ?').run(treeId, id)
      this.db.query('DELETE FROM media WHERE tree_id = ? AND id = ?').run(treeId, id)
    })
  }

  setPhoto(treeId: string, personId: string, mediaId: string | null) {
    if (mediaId && !this.mediaInfo(treeId, mediaId)) return
    this.db.query('UPDATE people SET photo_id = ? WHERE tree_id = ? AND id = ?').run(mediaId, treeId, personId)
  }

  // ---- the family photo album ---------------------------------------------

  addAlbum(treeId: string, userId: string, input: { title?: unknown; description?: unknown }): Album {
    const title = clean(input.title, 200)
    if (!title) throw new Error('an album needs a title')
    const id = newId()
    this.db.query('INSERT INTO albums (id,tree_id,title,description,created_by,cover_id,created_at) VALUES (?,?,?,?,?,?,?)').run(id, treeId, title, clean(input.description, 2000), userId, null, this.now())
    return this.album(treeId, id)!
  }

  album(treeId: string, id: string): Album | null {
    return this.db.query<Album, [string, string]>('SELECT * FROM albums WHERE tree_id = ? AND id = ?').get(treeId, id) ?? null
  }

  /** Every album in the tree, newest first, with how many photos each holds and a cover (chosen, or the newest photo). */
  albums(treeId: string): (Album & { photos: number; cover: string | null })[] {
    return this.db
      .query<Album & { photos: number; cover: string | null }, [string]>(
        'SELECT a.*, (SELECT COUNT(*) FROM media m WHERE m.album_id = a.id) AS photos, coalesce(a.cover_id, (SELECT m.id FROM media m WHERE m.album_id = a.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)) AS cover FROM albums a WHERE a.tree_id = ? ORDER BY a.created_at DESC',
      )
      .all(treeId)
  }

  updateAlbum(treeId: string, id: string, input: { title?: unknown; description?: unknown; cover_id?: unknown }): Album | null {
    const a = this.album(treeId, id)
    if (!a) return null
    const title = 'title' in input ? clean(input.title, 200) ?? a.title : a.title
    const description = 'description' in input ? clean(input.description, 2000) : a.description
    let cover = a.cover_id
    if ('cover_id' in input) {
      const want = input.cover_id ? String(input.cover_id) : null
      cover = want && this.mediaInfo(treeId, want)?.album_id === id ? want : want ? a.cover_id : null
    }
    this.db.query('UPDATE albums SET title = ?, description = ?, cover_id = ? WHERE tree_id = ? AND id = ?').run(title, description, cover, treeId, id)
    return this.album(treeId, id)
  }

  /** The album goes; its photos stay in the tree's photos. */
  deleteAlbum(treeId: string, id: string) {
    this.tx(() => {
      this.db.query('UPDATE media SET album_id = NULL WHERE tree_id = ? AND album_id = ?').run(treeId, id)
      this.db.query('DELETE FROM albums WHERE tree_id = ? AND id = ?').run(treeId, id)
    })
  }

  /**
   * Photos in the tree, newest first: one album's, or all of them (people's, businesses' and albums').
   * With the uploader's name, so the album can say who shared each one.
   */
  photos(treeId: string, opts: { albumId?: string | null; limit?: number; before?: number | null } = {}): (Media & { uploader: string | null })[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 120))
    const before = opts.before ?? Number.MAX_SAFE_INTEGER
    if (opts.albumId)
      return this.db
        .query<Media & { uploader: string | null }, [string, string, number, number]>(
          'SELECT m.id,m.tree_id,m.person_id,m.business_id,m.album_id,m.uploaded_by,m.filename,m.mime,m.size,m.caption,m.created_at, coalesce(u.name, u.email) AS uploader FROM media m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.tree_id = ? AND m.album_id = ? AND m.created_at < ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?',
        )
        .all(treeId, opts.albumId, before, limit)
    return this.db
      .query<Media & { uploader: string | null }, [string, number, number]>(
        'SELECT m.id,m.tree_id,m.person_id,m.business_id,m.album_id,m.uploaded_by,m.filename,m.mime,m.size,m.caption,m.created_at, coalesce(u.name, u.email) AS uploader FROM media m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.tree_id = ? AND m.created_at < ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?',
      )
      .all(treeId, before, limit)
  }

  /** Change a photo's caption, who is in it, or its album. Only the fields given change. */
  updateMedia(treeId: string, id: string, input: { caption?: unknown; person_id?: unknown; album_id?: unknown }): Media | null {
    const m = this.mediaInfo(treeId, id)
    if (!m) return null
    const caption = 'caption' in input ? clean(input.caption, 1000) : m.caption
    let person = m.person_id
    if ('person_id' in input) {
      person = input.person_id ? String(input.person_id) : null
      if (person && !this.person(treeId, person)) throw new Error('person is not in this tree')
    }
    let album = m.album_id ?? null
    if ('album_id' in input) {
      album = input.album_id ? String(input.album_id) : null
      if (album && !this.album(treeId, album)) throw new Error('no such album in this tree')
    }
    this.tx(() => {
      this.db.query('UPDATE media SET caption = ?, person_id = ?, album_id = ? WHERE tree_id = ? AND id = ?').run(caption, person, album, treeId, id)
      if (m.person_id && m.person_id !== person) this.db.query('UPDATE people SET photo_id = NULL WHERE tree_id = ? AND id = ? AND photo_id = ?').run(treeId, m.person_id, id)
      if (person) this.db.query('UPDATE people SET photo_id = coalesce(photo_id, ?) WHERE tree_id = ? AND id = ?').run(id, treeId, person)
      if (m.album_id && m.album_id !== album) this.db.query('UPDATE albums SET cover_id = NULL WHERE tree_id = ? AND id = ? AND cover_id = ?').run(treeId, m.album_id, id)
    })
    return this.mediaInfo(treeId, id)
  }

  /** How many photos someone has uploaded to any tree since a time, for the daily cap. */
  uploadsSince(userId: string, since: number): number {
    return this.db.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM media WHERE uploaded_by = ? AND created_at >= ?').get(userId, since)?.n ?? 0
  }

  stats(treeId: string) {
    const one = (sql: string) => this.db.query<{ n: number }, [string]>(sql).get(treeId)?.n ?? 0
    return {
      people: one("SELECT COUNT(*) AS n FROM people WHERE tree_id = ? AND kind = 'person'"),
      pets: one("SELECT COUNT(*) AS n FROM people WHERE tree_id = ? AND kind = 'pet'"),
      families: one('SELECT COUNT(*) AS n FROM families WHERE tree_id = ?'),
      sources: one('SELECT COUNT(*) AS n FROM sources WHERE tree_id = ?'),
      businesses: one('SELECT COUNT(*) AS n FROM businesses WHERE tree_id = ?'),
      photos: one('SELECT COUNT(*) AS n FROM media WHERE tree_id = ?'),
      surnames: one("SELECT COUNT(DISTINCT surname) AS n FROM people WHERE tree_id = ? AND surname != ''"),
    }
  }
}
