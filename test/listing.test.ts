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
  const app = createApp({ store, auth, site: SITE, net: new Network(store) })
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
  return { store, auth, app, mail, as, stranger, user }
}

describe('listed families', () => {
  test('a listing shows the name and the note, never the tree', async () => {
    const w = world()
    const owner = w.user('owner@example.com', 'Tony Owner')
    const tree = w.store.createTree(owner.id, 'The Ettinger Family', 'private description: grandma Rose')
    w.store.addPerson(tree.id, { given: 'Rosalind', surname: 'Ettinger', living: '1' })
    const visitor = w.stranger()

    expect((await visitor.get(`/families/${tree.id}`)).status).toBe(404)
    expect(await (await visitor.get('/families')).text()).not.toContain('The Ettinger Family')

    await w.as(owner).post(`/t/${tree.id}/listing`, { listed: '1', listing: 'The Ettingers of Chicago. Family, ask and we will add you.' })
    const dir = await (await visitor.get('/families?q=ettinger')).text()
    expect(dir).toContain('The Ettinger Family')
    expect(dir).toContain('The Ettingers of Chicago')
    const page = await (await visitor.get(`/families/${tree.id}`)).text()
    expect(page).toContain('Ask for an invite')
    for (const secret of ['Rosalind', 'grandma Rose', 'owner@example.com', 'Tony Owner']) expect(page).not.toContain(secret)

    // The tree itself is exactly as private as before.
    expect((await visitor.get(`/t/${tree.id}`)).status).toBe(302)
    expect((await w.as(w.user('nosy@example.com')).get(`/t/${tree.id}`)).status).toBe(404)
    // Only the owner lists or unlists.
    const editor = w.user('editor@example.com')
    w.store.setMember(tree.id, editor.id, 'editor')
    expect((await w.as(editor).post(`/t/${tree.id}/listing`, { listing: 'hijacked' })).status).toBe(403)
  })

  test('ask, and the family invites or declines; the visitor always hears the same thing', async () => {
    const w = world()
    const owner = w.user('owner@example.com', 'Tony')
    const member = w.user('karen@example.com', 'Karen')
    const tree = w.store.createTree(owner.id, 'Fam')
    w.store.setMember(tree.id, member.id, 'viewer')
    await w.as(owner).post(`/t/${tree.id}/listing`, { listed: '1' })

    const visitor = w.stranger()
    const asked = await visitor.post(`/families/${tree.id}/request`, { name: 'Nan Smith', email: 'Nan@Example.com', circle: 'family', note: "Rose's sister" })
    expect(asked.headers.get('location')).toBe(`/families/${tree.id}?sent=1`)
    expect(await (await visitor.get(asked.headers.get('location')!)).text()).toContain('Your request is with the family')
    expect(w.mail.at(-1)).toMatchObject({ to: 'owner@example.com', subject: 'Nan Smith asked to join Fam' })
    expect(w.mail.at(-1)!.text).toContain("Rose's sister")
    const mails = w.mail.length

    // Same address again, a member's address, and a bot filling the hidden field: same answer, no email.
    for (const fields of <Record<string, string>[]>[
      { name: 'Nan', email: 'nan@example.com' },
      { name: 'Karen', email: 'karen@example.com' },
      { name: 'Bot', email: 'bot@example.com', website: 'http://spam.example' },
    ]) expect((await w.stranger('10.0.0.2').post(`/families/${tree.id}/request`, fields)).headers.get('location')).toBe(`/families/${tree.id}?sent=1`)
    expect(w.mail.length).toBe(mails)
    expect((await visitor.post(`/families/${tree.id}/request`, { name: '', email: 'x' })).status).toBe(400)

    const members = await (await w.as(owner).get(`/t/${tree.id}/members`)).text()
    expect(members).toContain('Asking to join')
    expect(members).toContain('nan@example.com')
    expect(await (await w.as(member).get(`/t/${tree.id}/members`)).text()).not.toContain('nan@example.com')

    const id = (w.store.db.query("SELECT id FROM join_requests WHERE email = 'nan@example.com'").get() as { id: string }).id
    expect((await w.as(member).post(`/t/${tree.id}/requests/${id}/invite`)).status).toBe(403)
    const invited = await w.as(owner).post(`/t/${tree.id}/requests/${id}/invite`)
    expect(decodeURIComponent(invited.headers.get('location')!)).toContain('Invite emailed to nan@example.com.')
    expect(w.mail.at(-1)).toMatchObject({ to: 'nan@example.com', subject: 'Tony invited you to the Fam family tree' })
    expect(await (await w.as(owner).get(`/t/${tree.id}/members`)).text()).not.toContain('Asking to join')

    // Declining tells nobody anything.
    await w.stranger('10.0.0.3').post(`/families/${tree.id}/request`, { name: 'Pat', email: 'pat@example.com', circle: 'friends' })
    const pat = (w.store.db.query("SELECT id FROM join_requests WHERE email = 'pat@example.com'").get() as { id: string }).id
    const before = w.mail.length
    await w.as(owner).post(`/t/${tree.id}/requests/${pat}/decline`)
    expect(w.mail.length).toBe(before)
    expect(w.store.db.query("SELECT decision FROM join_requests WHERE id = ?").get(pat)).toEqual({ decision: 'declined' })
  })

  test('one address can only ask so often', async () => {
    const w = world()
    const owner = w.user('owner@example.com')
    const tree = w.store.createTree(owner.id, 'Fam')
    await w.as(owner).post(`/t/${tree.id}/listing`, { listed: '1' })
    const spammer = w.stranger('10.9.9.9')
    for (let i = 0; i < 8; i++) await spammer.post(`/families/${tree.id}/request`, { name: `P${i}`, email: `p${i}@example.com` })
    expect(w.mail.filter((m) => m.to === 'owner@example.com')).toHaveLength(5)
  })

  test('the API: listing, directory, ask, answer', async () => {
    const w = world()
    const owner = w.user('owner@example.com', 'Tony')
    const tree = w.store.createTree(owner.id, 'Fam')
    const call = (user: User, path: string, body?: unknown) => w.app.request(`${SITE}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${w.auth.createToken(user.id, 't')}`, 'content-type': 'application/json' } })
    expect(((await (await call(owner, `/trees/${tree.id}/listing`, { listed: true, listing: 'Find us' })).json()) as any)).toMatchObject({ listed: true, listing: 'Find us', url: `${SITE}/families/${tree.id}` })
    const someone = w.user('someone@example.com', 'Someone')
    expect(((await (await call(someone, '/families?q=fam')).json()) as any).families).toEqual([{ id: tree.id, name: 'Fam', listing: 'Find us' }])
    expect((await call(someone, `/families/${tree.id}/request`, { name: 'Someone', email: 'someone@example.com', circle: 'neighbors' })).status).toBe(202)
    const reqs = ((await (await call(owner, `/trees/${tree.id}/requests`)).json()) as any).requests
    expect(reqs).toMatchObject([{ name: 'Someone', email: 'someone@example.com', circle: 'neighbors' }])
    expect((await call(someone, `/trees/${tree.id}/requests`)).status).toBe(404)
    expect(((await (await call(owner, `/trees/${tree.id}/requests/${reqs[0].id}/invite`, {})).json()) as any).result).toBe('Invite emailed to someone@example.com.')
    expect((await call(owner, `/trees/${tree.id}/listing`, { listed: false })).status).toBe(200)
    expect((await call(someone, `/families/${tree.id}/request`, { name: 'x', email: 'x@example.com' })).status).toBe(404)
  })
})
