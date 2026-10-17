/**
 * The family.ancestry API, as a client. The CLI, the TUI and the MCP server all use it.
 *
 * family.ancestry is a Moshpit name: it lives outside the public DNS and its
 * certificate chains to the Moshpit Root CA, not to a root your OS ships. So:
 *
 *   1. resolve the host with the system resolver (works if you run moshcode dns),
 *   2. else ask the Moshpit DNS-over-HTTPS resolver (dns.moshcode.sh),
 *   3. connect to that address with SNI set to the name, and verify the
 *      certificate against the Moshpit root bundled in public/moshpit-root-ca.crt.
 *
 * ANCESTRY_URL points it at another instance (your own, or http://127.0.0.1:8792);
 * ordinary public hosts go through plain fetch. The token comes from
 * ANCESTRY_TOKEN or the file `ancestry login` writes.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { rootCertificates } from 'node:tls'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_URL = 'https://family.ancestry'
export const MOSHPIT_DOH = 'https://dns.moshcode.sh/dns-query'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export type Config = { url?: string; token?: string; email?: string; tree?: string }

export const configPath = () => process.env.ANCESTRY_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'family-ancestry', 'config.json')

export function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as Config
  } catch {
    return {}
  }
}

export function writeConfig(config: Config) {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

let rootPem: string | null | undefined
function moshpitRoot(): string | null {
  if (rootPem !== undefined) return rootPem
  try {
    rootPem = readFileSync(new URL('../public/moshpit-root-ca.crt', import.meta.url), 'utf8')
  } catch {
    rootPem = null
  }
  return rootPem
}

function dnsQuery(name: string): Uint8Array<ArrayBuffer> {
  const parts: number[] = [0x5e, 0x0a, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]
  for (const label of name.replace(/\.$/, '').split('.')) {
    const bytes = new TextEncoder().encode(label)
    parts.push(bytes.length, ...bytes)
  }
  parts.push(0, 0, 1, 0, 1)
  return new Uint8Array(parts)
}

function skipName(buf: Uint8Array, at: number): number {
  while (at < buf.length) {
    const len = buf[at]!
    if (len === 0) return at + 1
    if ((len & 0xc0) === 0xc0) return at + 2
    at += len + 1
  }
  return at
}

/** The A records in a DNS wire-format answer. */
export function parseDnsAnswer(buf: Uint8Array): string[] {
  if (buf.length < 12) return []
  const qd = (buf[4]! << 8) | buf[5]!
  const an = (buf[6]! << 8) | buf[7]!
  let at = 12
  for (let i = 0; i < qd; i++) at = skipName(buf, at) + 4
  const out: string[] = []
  for (let i = 0; i < an && at + 10 <= buf.length; i++) {
    at = skipName(buf, at)
    const type = (buf[at]! << 8) | buf[at + 1]!
    const rdlen = (buf[at + 8]! << 8) | buf[at + 9]!
    at += 10
    if (type === 1 && rdlen === 4) out.push(`${buf[at]}.${buf[at + 1]}.${buf[at + 2]}.${buf[at + 3]}`)
    at += rdlen
  }
  return out
}

export async function resolveMoshpit(host: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetchImpl(MOSHPIT_DOH, { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: dnsQuery(host), signal: AbortSignal.timeout(6_000) })
    if (!r.ok) return null
    return parseDnsAnswer(new Uint8Array(await r.arrayBuffer()))[0] ?? null
  } catch {
    return null
  }
}

export type PersonSummary = { id: string; name: string; given: string; surname: string; sex: string; birth_date: string | null; birth_place: string | null; death_date: string | null; death_place: string | null; living: number; notes: string | null; url: string }
export type PersonDetail = PersonSummary & {
  parents: { family_id: string; relation: string; parents: { id: string; name: string }[]; siblings: { id: string; name: string }[] }[]
  unions: { family_id: string; kind: string; start_date: string | null; start_place: string | null; end_date: string | null; partner: { id: string; name: string } | null; children: { id: string; name: string }[] }[]
  events: { id: string; type: string; date: string | null; place: string | null; description: string | null }[]
  sources: { id: string; title: string; url: string | null; page: string | null }[]
  photos: { id: string; url: string; caption: string | null }[]
  siblings?: { id: string; name: string; kind: string; via: { id: string; name: string } | null }[]
  bonds?: { id: string; kind: string; label: string; other: { id: string; name: string; kind: string }; note: string | null }[]
  pets?: { id: string; name: string; species: string | null }[]
  businesses?: { role_id: string; business: { id: string; name: string; category: string | null }; role: string; label: string; title: string | null; start_date: string | null; end_date: string | null }[]
  kind?: string
  species?: string | null
}
export type TreeSummary = { id: string; name: string; description: string | null; role: string; people: number; home_person_id: string | null }

export class AncestryClient {
  private route: Promise<{ origin: string; init: Record<string, unknown> }> | null = null
  readonly base: string
  token: string | null

  constructor(opts: { url?: string; token?: string | null; fetchImpl?: typeof fetch } = {}) {
    const config = readConfig()
    this.base = (opts.url ?? process.env.ANCESTRY_URL ?? config.url ?? DEFAULT_URL).replace(/\/+$/, '')
    this.token = opts.token !== undefined ? opts.token : (process.env.ANCESTRY_TOKEN ?? config.token ?? null)
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private fetchImpl: typeof fetch

  /** Work out once how to reach the instance: directly, or by address with SNI. */
  private connect() {
    this.route ??= (async () => {
      const url = new URL(this.base)
      const ca = moshpitRoot()
      const tls = url.protocol === 'https:' && ca ? { tls: { ca: [ca, ...rootCertificates] } } : {}
      if (isIP(url.hostname) || url.hostname === 'localhost') return { origin: url.origin, init: {} }
      try {
        await lookup(url.hostname)
        return { origin: url.origin, init: tls }
      } catch {}
      const ip = await resolveMoshpit(url.hostname, this.fetchImpl)
      if (!ip) throw new Error(`${url.hostname} does not resolve (not in the public DNS, and the Moshpit resolver did not answer).`)
      const origin = `${url.protocol}//${ip}${url.port ? `:${url.port}` : ''}`
      return { origin, init: { headers: { host: url.host }, ...(url.protocol === 'https:' && ca ? { tls: { ca, serverName: url.hostname } } : {}) } }
    })()
    return this.route
  }

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    let route: { origin: string; init: Record<string, unknown> }
    try {
      route = await this.connect()
    } catch (error) {
      this.route = null
      throw error
    }
    try {
      return await this.fetchImpl(`${route.origin}${path}`, {
        ...route.init,
        ...init,
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...((route.init.headers as Record<string, string>) ?? {}),
          ...((init.headers as Record<string, string>) ?? {}),
        },
        signal: AbortSignal.timeout(60_000),
      } as RequestInit)
    } catch (error) {
      this.route = null
      throw new Error(`Could not reach ${this.base}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, ...rest } = init
    const response = await this.raw(path, json !== undefined ? { ...rest, body: JSON.stringify(json), headers: { 'content-type': 'application/json', ...((rest.headers as Record<string, string>) ?? {}) } } : rest)
    const body = (await response.json().catch(() => ({}))) as any
    if (!response.ok) throw new ApiError(body?.error ?? `HTTP ${response.status}`, response.status)
    return body as T
  }

  me() {
    return this.request<{ user: { id: string; email: string; name: string | null }; trees: TreeSummary[] }>('/api/v1/me')
  }
  trees() {
    return this.request<{ trees: TreeSummary[] }>('/api/v1/trees').then((r) => r.trees)
  }
  createTree(name: string, description?: string) {
    return this.request<{ tree: TreeSummary }>('/api/v1/trees', { method: 'POST', json: { name, description } }).then((r) => r.tree)
  }
  tree(id: string) {
    return this.request<{ tree: TreeSummary; role: string; stats: Record<string, number>; surnames: { surname: string; n: number }[] }>(`/api/v1/trees/${enc(id)}`)
  }
  people(tree: string, q = '', limit = 100) {
    return this.request<{ people: PersonSummary[] }>(`/api/v1/trees/${enc(tree)}/people?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.people)
  }
  person(tree: string, id: string) {
    return this.request<{ person: PersonDetail }>(`/api/v1/trees/${enc(tree)}/people/${enc(id)}`).then((r) => r.person)
  }
  addPerson(tree: string, fields: Record<string, unknown>) {
    return this.request<{ person: PersonDetail }>(`/api/v1/trees/${enc(tree)}/people`, { method: 'POST', json: fields }).then((r) => r.person)
  }
  updatePerson(tree: string, id: string, fields: Record<string, unknown>) {
    return this.request<{ person: PersonDetail }>(`/api/v1/trees/${enc(tree)}/people/${enc(id)}`, { method: 'PATCH', json: fields }).then((r) => r.person)
  }
  addEvent(tree: string, id: string, event: { type: string; date?: string; place?: string; description?: string }) {
    return this.request<{ event: unknown }>(`/api/v1/trees/${enc(tree)}/people/${enc(id)}/events`, { method: 'POST', json: event })
  }
  pedigree(tree: string, id: string, generations = 4) {
    return this.request<{ ancestors: { n: number; generation: number; id: string; name: string; birth_date: string | null; death_date: string | null; sex: string }[] }>(`/api/v1/trees/${enc(tree)}/pedigree/${enc(id)}?generations=${generations}`).then((r) => r.ancestors)
  }
  descendants(tree: string, id: string, generations = 3) {
    return this.request<{ descendants: any }>(`/api/v1/trees/${enc(tree)}/descendants/${enc(id)}?generations=${generations}`).then((r) => r.descendants)
  }
  relate(tree: string, a: string, b: string) {
    return this.request<{ relationship: string; path: { step: string; id: string; name: string }[] | null }>(`/api/v1/trees/${enc(tree)}/relate?a=${enc(a)}&b=${enc(b)}`)
  }
  importGedcom(tree: string, text: string) {
    return this.request<{ imported: { people: number; families: number; sources: number; events: number; skipped: number; warnings: string[] } }>(`/api/v1/trees/${enc(tree)}/import`, { method: 'POST', body: text, headers: { 'content-type': 'text/plain; charset=utf-8' } }).then((r) => r.imported)
  }
  async exportGedcom(tree: string, privacy = false): Promise<string> {
    const res = await this.raw(`/api/v1/trees/${enc(tree)}/export${privacy ? '?privacy=1' : ''}`, { headers: { accept: 'text/plain' } })
    if (!res.ok) throw new ApiError(((await res.json().catch(() => ({}))) as any)?.error ?? `HTTP ${res.status}`, res.status)
    return res.text()
  }
  health() {
    return this.request<{ ok: boolean; version: string }>('/health')
  }

  /** `other_id` is `kind` (raised_by, guardian, godparent, caregiver, chosen_family) to this person. */
  addBond(tree: string, person: string, body: { kind: string; other_id?: string; note?: string; [k: string]: unknown }) {
    return this.request<{ person: PersonDetail; other: PersonSummary }>(`/api/v1/trees/${enc(tree)}/people/${enc(person)}/bonds`, { method: 'POST', json: body })
  }
  removeBond(tree: string, id: string) {
    return this.request<{ ok: boolean }>(`/api/v1/trees/${enc(tree)}/bonds/${enc(id)}`, { method: 'DELETE' })
  }
  addPet(tree: string, fields: Record<string, unknown>) {
    return this.request<{ pet: PersonDetail }>(`/api/v1/trees/${enc(tree)}/pets`, { method: 'POST', json: fields }).then((r) => r.pet)
  }
  plan(tree: string) {
    return this.request<{ active: boolean; paid_at: number | null; price: string; chains: string[]; url: string }>(`/api/v1/trees/${enc(tree)}/plan`)
  }
  planCheckout(tree: string, chain?: string) {
    return this.request<{ checkoutUrl: string; ref: string } | { active: true }>(`/api/v1/trees/${enc(tree)}/plan/checkout`, { method: 'POST', json: { chain } })
  }
  claim(tree: string, body: Record<string, unknown>) {
    return this.request<{ person: PersonDetail }>(`/api/v1/trees/${enc(tree)}/claim`, { method: 'POST', json: body }).then((r) => r.person)
  }

  // ---- businesses: founders, owners, partners, investors, staff ------------

  businesses(tree: string, q = '', limit = 100) {
    return this.request<{ businesses: BusinessSummary[] }>(`/api/v1/trees/${enc(tree)}/businesses?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.businesses)
  }
  business(tree: string, id: string) {
    return this.request<{ business: BusinessDetail }>(`/api/v1/trees/${enc(tree)}/businesses/${enc(id)}`).then((r) => r.business)
  }
  /** {name, category?, founded?, closed?, place?, website?, notes?, people?: [{person_id, role, title?, start_date?, end_date?}]} */
  addBusiness(tree: string, fields: Record<string, unknown>) {
    return this.request<{ business: BusinessDetail }>(`/api/v1/trees/${enc(tree)}/businesses`, { method: 'POST', json: fields }).then((r) => r.business)
  }
  updateBusiness(tree: string, id: string, fields: Record<string, unknown>) {
    return this.request<{ business: BusinessDetail }>(`/api/v1/trees/${enc(tree)}/businesses/${enc(id)}`, { method: 'PATCH', json: fields }).then((r) => r.business)
  }
  deleteBusiness(tree: string, id: string) {
    return this.request<{ ok: boolean }>(`/api/v1/trees/${enc(tree)}/businesses/${enc(id)}`, { method: 'DELETE' })
  }
  /** {person_id (or given + surname), role, title?, start_date?, end_date?, note?} */
  addBusinessRole(tree: string, id: string, body: Record<string, unknown>) {
    return this.request<{ business: BusinessDetail }>(`/api/v1/trees/${enc(tree)}/businesses/${enc(id)}/people`, { method: 'POST', json: body }).then((r) => r.business)
  }
  removeBusinessRole(tree: string, roleId: string) {
    return this.request<{ ok: boolean }>(`/api/v1/trees/${enc(tree)}/business-roles/${enc(roleId)}`, { method: 'DELETE' })
  }
  /** Link one of your own Network contacts (null unlinks; create adds the business to your network). */
  linkBusinessContact(tree: string, id: string, body: { contact_id?: string | null; create?: boolean }) {
    return this.request<{ business: BusinessDetail }>(`/api/v1/trees/${enc(tree)}/businesses/${enc(id)}/contact`, { method: 'POST', json: body }).then((r) => r.business)
  }
  search(tree: string, q: string, limit = 50) {
    return this.request<{ people: { id: string; name: string; kind: string; birth_date: string | null; death_date: string | null; url: string }[]; businesses: BusinessSummary[] }>(`/api/v1/trees/${enc(tree)}/search?q=${encodeURIComponent(q)}&limit=${limit}`)
  }

  // ---- local recommendations ----------------------------------------------

  local(q = '', category?: string) {
    return this.request<{ results: { name: string; category: string; town: string | null; phone: string | null; website: string | null; score: number; by: { name: string | null; circle: string; note: string | null; mine: boolean }[] }[] }>(`/api/v1/local?q=${encodeURIComponent(q)}${category ? `&category=${enc(category)}` : ''}`).then((r) => r.results)
  }
  recommendBusiness(body: Record<string, unknown>) {
    return this.request<{ recommendation: { id: string; name: string; category: string } }>('/api/v1/local', { method: 'POST', json: body }).then((r) => r.recommendation)
  }

  // ---- invites -----------------------------------------------------------

  /** Email invites (or, with no emails, make a link). With person_id, they join as that person. */
  invite(tree: string, emails: string[], opts: { role?: 'editor' | 'viewer'; person_id?: string; note?: string } = {}) {
    return this.request<{ invites: { email: string | null; name?: string | null; person_id?: string | null; url: string; mailed: boolean }[] }>(`/api/v1/trees/${enc(tree)}/invites`, { method: 'POST', json: { emails, ...opts } }).then((r) => r.invites)
  }
  invites(tree: string) {
    return this.request<{ invites: { id: string; email: string | null; role: string; person_id: string | null; expires_at: number }[] }>(`/api/v1/trees/${enc(tree)}/invites`).then((r) => r.invites)
  }
  members(tree: string) {
    return this.request<{ members: { user_id: string; email: string; name: string | null; role: string; person_id: string | null }[] }>(`/api/v1/trees/${enc(tree)}/members`).then((r) => r.members)
  }

  // ---- network -----------------------------------------------------------

  contacts(q = '', circle?: string) {
    return this.request<{ contacts: ContactSummary[] }>(`/api/v1/contacts?q=${encodeURIComponent(q)}${circle ? `&circle=${enc(circle)}` : ''}`).then((r) => r.contacts)
  }
  contact(id: string) {
    return this.request<{ contact: ContactSummary }>(`/api/v1/contacts/${enc(id)}`).then((r) => r.contact)
  }
  addContact(fields: Record<string, unknown>) {
    return this.request<{ contact: ContactSummary }>('/api/v1/contacts', { method: 'POST', json: fields }).then((r) => r.contact)
  }
  updateContact(id: string, fields: Record<string, unknown>) {
    return this.request<{ contact: ContactSummary }>(`/api/v1/contacts/${enc(id)}`, { method: 'PATCH', json: fields }).then((r) => r.contact)
  }
  deleteContact(id: string) {
    return this.request<{ ok: boolean }>(`/api/v1/contacts/${enc(id)}`, { method: 'DELETE' })
  }
  connectContact(id: string, note?: string) {
    return this.request<{ result: string }>(`/api/v1/contacts/${enc(id)}/connect`, { method: 'POST', json: { note } }).then((r) => r.result)
  }
  recommendContact(id: string, to: string, note?: string) {
    return this.request<{ recommendation: { id: string; card: { name: string } }; to: UserSummary }>(`/api/v1/contacts/${enc(id)}/recommend`, { method: 'POST', json: { to, note } })
  }
  recommendations() {
    return this.request<{ recommendations: { id: string; card: { circle: string; name: string; company: string | null; title: string | null; emails: { value: string }[]; phones: { value: string }[] }; note: string | null; from: UserSummary }[] }>('/api/v1/recommendations').then((r) => r.recommendations)
  }
  saveRecommendation(id: string) {
    return this.request<{ contact: ContactSummary }>(`/api/v1/recommendations/${enc(id)}/save`, { method: 'POST' }).then((r) => r.contact)
  }
  importContacts(vcf: string, circle = 'friends') {
    return this.request<{ imported: { added: number; skipped: number } }>(`/api/v1/contacts/import?circle=${enc(circle)}`, { method: 'POST', body: vcf, headers: { 'content-type': 'text/vcard; charset=utf-8' } }).then((r) => r.imported)
  }
  async exportContacts(): Promise<string> {
    const res = await this.raw('/api/v1/contacts.vcf', { headers: { accept: 'text/vcard' } })
    if (!res.ok) throw new ApiError(((await res.json().catch(() => ({}))) as any)?.error ?? `HTTP ${res.status}`, res.status)
    return res.text()
  }
  inbox() {
    return this.request<{ unread: number; threads: { with: UserSummary; unread: number; last: MessageSummary }[]; reachable: UserSummary[] }>('/api/v1/inbox')
  }
  conversation(user: string) {
    return this.request<{ with: UserSummary; can_message: boolean; messages: MessageSummary[] }>(`/api/v1/inbox/${enc(user)}`)
  }
  sendMessage(user: string, body: string) {
    return this.request<{ message: MessageSummary }>(`/api/v1/inbox/${enc(user)}`, { method: 'POST', json: { body } }).then((r) => r.message)
  }
}

export type BusinessSummary = {
  id: string
  name: string
  category: string | null
  founded: string | null
  closed: string | null
  place: string | null
  website: string | null
  notes: string | null
  url: string
  people: { role_id: string; id: string; name: string; role: string; label: string; title: string | null; start_date: string | null; end_date: string | null; note?: string | null }[]
}
export type BusinessDetail = BusinessSummary & { photos: { id: string; url: string; caption: string | null }[]; contact: { id: string; name: string } | null }
export type UserSummary = { id: string; name: string | null; email: string }
export type MessageSummary = { id: string; sender_id: string; recipient_id: string; body: string; created_at: number }
export type ContactSummary = {
  id: string
  circle: string
  name: string
  nickname: string | null
  relationship: string | null
  company: string | null
  title: string | null
  birthday: string | null
  anniversary: string | null
  emails: { label: string | null; value: string }[]
  phones: { label: string | null; value: string }[]
  addresses: { label: string | null; lines: string }[]
  links: { label: string | null; value: string }[]
  notes: string | null
  linked_user_id: string | null
}

const enc = encodeURIComponent
