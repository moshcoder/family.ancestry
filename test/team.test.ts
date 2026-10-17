import { describe, expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth, type Mail } from '../src/auth.ts'
import { createApp } from '../src/server.ts'
import { Network } from '../src/network.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

function world() {
  const store = new Store(':memory:')
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const net = new Network(store)
  const app = createApp({ store, auth, site: SITE, net })
  const browser = (cookie: string, ip: string) => ({
    get: (path: string) => app.request(`${SITE}${path}`, { headers: { cookie, 'x-real-ip': ip } }),
    post: (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'x-real-ip': ip, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
  })
  const as = (user: User, ip = '10.0.0.1') => browser(`fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`, ip)
  const stranger = (ip = '10.0.0.9') => browser(`fa_csrf=${CSRF}`, ip)
  const user = (email: string, name: string | null = null) => {
    const u = store.findOrCreateUser(email)
    if (name) store.setUserName(u.id, name)
    return store.user(u.id)!
  }
  const family = () => {
    const owner = user('anthony@example.com', 'Anthony')
    const tree = store.createTree(owner.id, 'The Ettinger Family')
    const me = store.addPerson(tree.id, { given: 'Anthony', surname: 'Ettinger', living: '1' })
    const aunt = store.addPerson(tree.id, { given: 'Rosalind', surname: 'Ettinger', living: '1' })
    const biz = store.addBusiness(tree.id, { name: 'Profullstack, Inc.', category: 'Software', place: 'Sacramento', notes: 'family-only notes about the books' })
    store.addBusinessRole(tree.id, biz.id, me.id, { role: 'owner' })
    store.claimProfile(tree.id, me.id, owner.id)
    store.addBusinessRole(tree.id, biz.id, aunt.id, { role: 'investor' })
    return { owner, tree, biz }
  }
  return { store, auth, net, app, mail, as, stranger, user, family }
}

const link = (m: Mail) => m.text.match(/https?:\/\/\S+\/team\/invite\/[A-Za-z0-9_-]+/)![0]!.replace(SITE, '')

describe('business teams', () => {
  test('invite an employee: they join the business, never the tree', async () => {
    const w = world()
    const { owner, tree, biz } = w.family()
    const anthony = w.as(owner)

    const page = await (await anthony.get(`/t/${tree.id}/b/${biz.id}`)).text()
    expect(page).toContain('Invite someone to the team')
    const sent = await anthony.post(`/t/${tree.id}/b/${biz.id}/team/invite`, { email: 'Preshy@Example.com', role: 'employee', title: 'Operations', note: 'Welcome aboard' })
    expect(decodeURIComponent(sent.headers.get('location')!)).toContain('Invite emailed to preshy@example.com.')
    const invite = w.mail.at(-1)!
    expect(invite).toMatchObject({ to: 'preshy@example.com', subject: 'Anthony invited you to join Profullstack, Inc.' })
    expect(invite.text).toContain('as an employee (Operations)')
    expect(invite.text).not.toContain('Ettinger')

    const preshy = w.user('preshy@example.com', 'Preshy')
    const p = w.as(preshy)
    expect(await (await p.get(link(invite))).text()).toContain('Join Profullstack, Inc.')
    const joined = await p.post(link(invite))
    expect(joined.headers.get('location')).toStartWith(`/w/${biz.id}`)

    const work = await (await p.get(`/w/${biz.id}`)).text()
    expect(work).toContain('Profullstack, Inc.')
    expect(work).toContain('Operations')
    expect(work).toContain('Anthony')
    for (const secret of ['Rosalind', 'Ettinger', 'family-only notes', 'Investor', 'anthony@example.com']) expect(work).not.toContain(secret)
    expect(await (await p.get('/trees')).text()).toContain(`/w/${biz.id}`)

    // Still nobody in the tree: the tree, its people and its business page are a 404 to them.
    expect((await p.get(`/t/${tree.id}`)).status).toBe(404)
    expect((await p.get(`/t/${tree.id}/b/${biz.id}`)).status).toBe(404)
    expect(w.store.role(tree.id, preshy.id)).toBeNull()
    // The invite is spent; strangers see nothing at /w.
    expect((await p.post(link(invite))).status).toBe(404)
    expect((await w.as(w.user('nosy@example.com')).get(`/w/${biz.id}`)).status).toBe(404)
    // Connected with the person who invited them, filed under business.
    expect(w.net.connected(owner.id, preshy.id)).toBe(true)
    expect(w.net.contactByEmail(owner.id, 'preshy@example.com')).toMatchObject({ circle: 'business', company: 'Profullstack, Inc.' })

    // The family sees the team on the business page, and can remove them.
    expect(await (await anthony.get(`/t/${tree.id}/b/${biz.id}`)).text()).toContain('preshy@example.com')
    await anthony.post(`/t/${tree.id}/b/${biz.id}/team/${preshy.id}/remove`)
    expect((await p.get(`/w/${biz.id}`)).status).toBe(404)
  })

  test('viewers cannot invite; family members are sent to the full page', async () => {
    const w = world()
    const { tree, biz } = w.family()
    const viewer = w.user('viewer@example.com')
    w.store.setMember(tree.id, viewer.id, 'viewer')
    expect((await w.as(viewer).post(`/t/${tree.id}/b/${biz.id}/team/invite`, { email: 'x@example.com' })).status).toBe(403)
    expect((await w.as(viewer).get(`/w/${biz.id}`)).headers.get('location')).toBe(`/t/${tree.id}/b/${biz.id}`)
  })

  test('a listed business: anyone asks to join the team, the family decides', async () => {
    const w = world()
    const { owner, tree, biz } = w.family()
    const anthony = w.as(owner)
    expect((await w.stranger().get(`/families/b/${biz.id}`)).status).toBe(404)
    await anthony.post(`/t/${tree.id}/b/${biz.id}/team/listing`, { listed: '1', listing: 'We build software. Work here? Ask to join.' })
    const dir = await (await w.stranger().get('/families')).text()
    expect(dir).toContain('Profullstack, Inc.')
    expect(dir).toContain('We build software')
    const pub = await (await w.stranger().get(`/families/b/${biz.id}`)).text()
    for (const secret of ['Rosalind', 'family-only notes', 'Investor', 'Anthony']) expect(pub).not.toContain(secret)

    const asked = await w.stranger().post(`/families/b/${biz.id}/request`, { name: 'Sam', email: 'sam@example.com', role: 'employee', note: 'Support since May' })
    expect(asked.headers.get('location')).toBe(`/families/b/${biz.id}?sent=1`)
    expect(w.mail.at(-1)).toMatchObject({ to: 'anthony@example.com', subject: 'Sam asked to join Profullstack, Inc.' })
    const mails = w.mail.length
    await w.stranger('10.0.0.2').post(`/families/b/${biz.id}/request`, { name: 'Sam', email: 'sam@example.com' })
    expect(w.mail.length).toBe(mails)

    expect(await (await anthony.get(`/t/${tree.id}/b/${biz.id}`)).text()).toContain('Support since May')
    const id = (w.store.db.query("SELECT id FROM business_requests WHERE email = 'sam@example.com'").get() as { id: string }).id
    const invited = await anthony.post(`/t/${tree.id}/b/${biz.id}/team/requests/${id}/invite`)
    expect(decodeURIComponent(invited.headers.get('location')!)).toContain('Invite emailed to sam@example.com.')
    expect(w.mail.at(-1)!.subject).toBe('Anthony invited you to join Profullstack, Inc.')
  })

  test('the API: team, invite, work, listing', async () => {
    const w = world()
    const { owner, tree, biz } = w.family()
    const call = (u: User, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => w.app.request(`${SITE}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${w.auth.createToken(u.id, 't')}`, 'content-type': 'application/json' } })
    const r = (await (await call(owner, `/trees/${tree.id}/businesses/${biz.id}/team`, { email: 'pat@example.com', role: 'manager', title: 'Head of sales' })).json()) as any
    expect(r.result).toBe('Invite emailed to pat@example.com.')
    const team = (await (await call(owner, `/trees/${tree.id}/businesses/${biz.id}/team`)).json()) as any
    expect(team.invites).toMatchObject([{ email: 'pat@example.com', role: 'manager', title: 'Head of sales' }])
    const pat = w.user('pat@example.com', 'Pat')
    await w.as(pat).post(link(w.mail.at(-1)!))
    const work = (await (await call(pat, '/work')).json()) as any
    expect(work.businesses).toMatchObject([{ id: biz.id, name: 'Profullstack, Inc.', role: 'manager', title: 'Head of sales' }])
    const one = (await (await call(pat, `/work/${biz.id}`)).json()) as any
    expect(one.team.map((m: any) => m.name)).toEqual(['Anthony', 'Pat'])
    expect(JSON.stringify(one)).not.toContain('pat@example.com')
    expect((await call(pat, `/trees/${tree.id}/businesses/${biz.id}/team`)).status).toBe(404)
    expect(((await (await call(owner, `/trees/${tree.id}/businesses/${biz.id}/listing`, { listed: true })).json()) as any).listed).toBe(true)
  })
})
