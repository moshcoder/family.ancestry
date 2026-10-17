import { describe, expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth, type Mail } from '../src/auth.ts'
import { createApp, parseEmails } from '../src/server.ts'
import { Network, parseAddresses, parseLabeled, parseVcards, toVcard } from '../src/network.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

/** One app, many browsers: each `as(user)` is a signed-in session with its own cookie. */
function world() {
  const store = new Store(':memory:')
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const net = new Network(store)
  const app = createApp({ store, auth, site: SITE, net })
  const as = (user: User) => {
    const cookie = `fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`
    const get = (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } })
    const post = (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) })
    return { get, post }
  }
  const user = (email: string, name: string | null = null) => {
    const u = store.findOrCreateUser(email)
    if (name) store.setUserName(u.id, name)
    return store.user(u.id)!
  }
  return { store, auth, net, app, mail, as, user }
}

describe('parsing', () => {
  test('labeled lines, addresses and email lists', () => {
    expect(parseLabeled('work: A@B.com\nhttps://x.example/y\n\n+1 555 0100')).toEqual([
      { label: 'work', value: 'A@B.com' },
      { label: null, value: 'https://x.example/y' },
      { label: null, value: '+1 555 0100' },
    ])
    expect(parseAddresses('home: 1 Main St\nSpringfield\n\nPO Box 9')).toEqual([
      { label: 'home', lines: '1 Main St\nSpringfield' },
      { label: null, lines: 'PO Box 9' },
    ])
    expect(parseEmails('a@x.com, B@x.com\nnot-an-email a@x.com')).toEqual(['a@x.com', 'b@x.com'])
  })

  test('vCard survives a round trip, folded lines and all', () => {
    const { store, net, user } = world()
    void store
    const me = user('me@example.com')
    net.addContact(me.id, { name: 'Rose Ettinger', circle: 'family', relationship: 'aunt', emails: 'home: rose@example.com', phones: 'cell: 555 0100', addresses: 'home: 12 Elm St, Apt 3\nChicago', birthday: '14 MAY 1958', notes: 'Makes the best strudel; ask her about the farm.\nSecond line.', company: 'Ettinger Bakery' })
    const vcf = toVcard(net.contacts(me.id))
    const [card] = parseVcards(vcf)
    expect(card).toMatchObject({ name: 'Rose Ettinger', circle: 'family', company: 'Ettinger Bakery', birthday: '14 MAY 1958', notes: 'Makes the best strudel; ask her about the farm.\nSecond line.' })
    expect((card as any).emails).toEqual([{ label: 'home', value: 'rose@example.com' }])
    expect((card as any).addresses[0].lines).toBe('12 Elm St, Apt 3\nChicago')
  })

  test('reads cards from other apps', () => {
    const cards = parseVcards('BEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;Jane;;;\r\nTEL;CELL:555 0199\r\nitem1.EMAIL;type=INTERNET;type=WORK:jane@corp.example\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ name: 'Jane Doe', phones: [{ label: 'cell', value: '555 0199' }], emails: [{ label: 'work', value: 'jane@corp.example' }] })
  })
})

describe('network store', () => {
  test('contacts are private to whoever saved them', () => {
    const { net, user } = world()
    const a = user('a@example.com')
    const b = user('b@example.com')
    const c = net.addContact(a.id, { name: 'Cousin Vinny', circle: 'family' })
    expect(net.contact(b.id, c.id)).toBeNull()
    expect(net.contacts(b.id)).toHaveLength(0)
    expect(net.contacts(a.id, { q: 'vinny' })).toHaveLength(1)
    expect(net.circleCounts(a.id)).toEqual({ family: 1, neighbors: 0, friends: 0, business: 0 })
  })

  test('messages only between people who know each other; a block ends it both ways', () => {
    const { store, net, user } = world()
    const a = user('a@example.com')
    const b = user('b@example.com')
    const stranger = user('spam@example.com')
    expect(net.canMessage(stranger.id, a.id)).toBe(false)
    expect(() => net.send(stranger.id, a.id, 'buy my course')).toThrow()

    const token = net.createConnectRequest(a.id, b.email, 'friends', net.addContact(a.id, { name: 'Bee', emails: [b.email] }).id)
    expect(net.acceptConnectRequest(token, a)).toBeNull() // not your own
    expect(net.acceptConnectRequest(token, b)?.id).toBe(a.id)
    expect(net.acceptConnectRequest(token, b)).toBeNull() // once
    expect(net.contactByEmail(a.id, b.email)?.linked_user_id).toBe(b.id)
    expect(net.contactByEmail(b.id, a.email)?.linked_user_id).toBe(a.id)

    net.send(a.id, b.id, 'hi Bee')
    net.send(a.id, b.id, 'are you coming Sunday?')
    expect(net.unreadCount(b.id)).toBe(2)
    expect(net.threads(b.id)[0]).toMatchObject({ other: { id: a.id }, unread: 2 })
    expect(net.conversation(b.id, a.id).map((m) => m.body)).toEqual(['hi Bee', 'are you coming Sunday?'])
    expect(net.unreadCount(b.id)).toBe(0)

    net.block(b.id, a.id)
    expect(net.canMessage(a.id, b.id)).toBe(false)
    expect(net.canMessage(b.id, a.id)).toBe(false)
    net.unblock(b.id, a.id)

    // Sharing a tree is enough, without a connection.
    const tree = store.createTree(a.id, 'Fam')
    store.setMember(tree.id, stranger.id, 'viewer')
    expect(net.canMessage(stranger.id, a.id)).toBe(true)
    expect(net.reachable(a.id).map((u) => u.id).sort()).toEqual([b.id, stranger.id].sort())
  })
})

describe('join the family', () => {
  test('add a person, invite them, they join as themselves and keep their own profile', async () => {
    const w = world()
    const tony = w.user('tony@example.com', 'Tony')
    const owner = w.as(tony)
    const treeId = (await owner.post('/trees', { name: 'Ettinger family' })).headers.get('location')!.split('/').pop()!

    const added = await owner.post(`/t/${treeId}/people`, { given: 'Lily', surname: 'Ettinger', living: '1' })
    expect(added.headers.get('location')).toMatch(/\?added=1$/)
    const page = await (await owner.get(added.headers.get('location')!)).text()
    expect(page).toContain('Invite them to manage their own profile and join the family')
    const lilyId = added.headers.get('location')!.split('/').pop()!.split('?')[0]!

    const sent = await owner.post(`/t/${treeId}/invites`, { email: 'lily@example.com', person_id: lilyId, back: 'person' })
    expect(sent.headers.get('location')).toContain(`/t/${treeId}/p/${lilyId}?ok=`)
    const mail = w.mail.at(-1)!
    expect(mail.to).toBe('lily@example.com')
    expect(mail.subject).toBe('Tony added you to the Ettinger family family tree')
    expect(mail.text).toContain('as Lily Ettinger')
    // She is in Tony's network already, as family, linked to her person.
    expect(w.net.contactByEmail(tony.id, 'lily@example.com')).toMatchObject({ circle: 'family', tree_id: treeId, person_id: lilyId, name: 'Lily Ettinger' })

    const lily = w.user('lily@example.com')
    const her = w.as(lily)
    const url = mail.text.match(/(http:\/\/family\.test\/invite\/\S+)/)![1]!.replace(SITE, '')
    expect(await (await her.get(url)).text()).toContain('Join the family')
    const joined = await her.post(url)
    expect(joined.headers.get('location')).toContain(`/t/${treeId}/p/${lilyId}?welcome=1&ok=`)
    expect(w.store.role(treeId, lily.id)).toBe('viewer')
    expect(w.store.profilePerson(treeId, lily.id)).toBe(lilyId)

    // Her own profile: yes. Anyone else: no.
    expect((await her.post(`/t/${treeId}/p/${lilyId}`, { given: 'Lily', surname: 'Ettinger', birth_date: '2015', living: '1' })).status).toBe(302)
    expect(w.store.person(treeId, lilyId)!.birth_date).toBe('2015')
    const other = w.store.addPerson(treeId, { given: 'Robert' })
    expect((await her.post(`/t/${treeId}/p/${other.id}`, { given: 'Bob' })).status).toBe(403)
    expect(await (await owner.get(`/t/${treeId}/p/${lilyId}`)).text()).toContain('Managed by lily@example.com')

    // Joining connects them, so they can talk in the inbox.
    expect(w.net.connected(tony.id, lily.id)).toBe(true)
    expect((await her.post(`/inbox/${tony.id}`, { body: 'Thanks Uncle Tony!' })).status).toBe(302)
    expect(w.mail.at(-1)!.subject).toBe('lily@example.com sent you a message')
    expect(await (await owner.get('/inbox')).text()).toContain('Thanks Uncle Tony!')
    expect(await (await owner.get('/trees')).text()).toContain('<span class="badge">1</span>')
  })

  test('invite several people by email at once; strangers cannot open an inbox thread', async () => {
    const w = world()
    const tony = w.user('tony@example.com')
    const owner = w.as(tony)
    const treeId = (await owner.post('/trees', { name: 'Fam' })).headers.get('location')!.split('/').pop()!
    const res = await owner.post(`/t/${treeId}/invites`, { emails: 'a@example.com, b@example.com\nc@example.com', role: 'editor', note: 'Help me with Grandpa' })
    expect(res.status).toBe(200)
    expect(w.mail.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
    expect(w.mail[0]!.text).toContain('"Help me with Grandpa"')
    expect(w.store.pendingInvites(treeId)).toHaveLength(3)
    const html = await (await owner.get(`/t/${treeId}/members`)).text()
    expect(html).toContain('Waiting to join')

    await owner.post(`/t/${treeId}/invites/${w.store.pendingInvites(treeId)[0]!.id}/revoke`)
    expect(w.store.pendingInvites(treeId)).toHaveLength(2)

    const stranger = w.as(w.user('stranger@example.com'))
    expect((await stranger.get(`/inbox/${tony.id}`)).status).toBe(404)
    expect((await stranger.post(`/inbox/${tony.id}`, { body: 'hello friend, great opportunity' })).status).toBe(404)
  })

  test('the network pages and the contacts API', async () => {
    const w = world()
    const me = w.user('me@example.com', 'Me')
    const b = w.as(me)
    const made = await b.post('/network/contacts', { name: 'Dr. Patel', circle: 'business', relationship: 'our dentist', phones: 'office: 555 0142', emails: 'front@patel.example' })
    const id = made.headers.get('location')!.split('/').pop()!
    const page = await (await b.get(`/network/c/${id}`)).text()
    expect(page).toContain('our dentist')
    expect(page).toContain('Ask to connect')
    expect(await (await b.get('/network?circle=business')).text()).toContain('Dr. Patel')
    expect(await (await b.get('/network?circle=family')).text()).not.toContain('Dr. Patel')

    await b.post(`/network/c/${id}/connect`, { note: 'Is this the right email for appointments?' })
    expect(w.mail.at(-1)!.subject).toBe('Me wants to stay in touch on family.ancestry')

    const token = w.auth.createToken(me.id, 'test')
    const api = (path: string, init: RequestInit = {}) => w.app.request(`${SITE}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } })
    const created = (await (await api('/contacts', { method: 'POST', body: JSON.stringify({ name: 'Sam', email: 'sam@example.com', circle: 'friends' }) })).json()) as any
    expect(created.contact.emails).toEqual([{ label: null, value: 'sam@example.com' }])
    const list = (await (await api('/contacts?circle=friends')).json()) as any
    expect(list.contacts.map((c: any) => c.name)).toEqual(['Sam'])
    const imported = (await (await api('/contacts/import?circle=family', { method: 'POST', body: 'BEGIN:VCARD\nFN:Grandma June\nEMAIL:june@example.com\nEND:VCARD\nBEGIN:VCARD\nFN:Sam again\nEMAIL:sam@example.com\nEND:VCARD\n', headers: { 'content-type': 'text/vcard' } })).json()) as any
    expect(imported.imported).toEqual({ added: 1, skipped: 1 })
    expect((await api('/inbox')).status).toBe(200)
    expect(await (await b.get('/settings')).text()).toContain('included free')
  })
})
