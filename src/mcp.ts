/**
 * `ancestry mcp`: family.ancestry as an MCP server on stdio, so an AI assistant
 * can look things up in the family tree and help fill it in.
 *
 *   ancestry login                         once, to get a token
 *   claude mcp add ancestry -- ancestry mcp
 *
 * The assistant acts as you: it sees the trees you see and can change only the
 * ones you can edit.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AncestryClient } from './client.js'
import { formatDescendants, formatPedigree, formatPerson } from './cli.js'
import { VERSION } from './html.js'

const text = (value: string) => ({ content: [{ type: 'text', text: value }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))

export function createMcpServer(client = new AncestryClient()): McpServer {
  // Typed loosely: the SDK's generic tool() signature recurses past TypeScript's
  // instantiation depth with zod shapes. The shapes are still validated at runtime.
  const server: any = new McpServer({ name: 'family.ancestry', version: VERSION })
  const person = {
    given: z.string().max(200).optional(),
    surname: z.string().max(200).optional(),
    sex: z.enum(['M', 'F', 'X', 'U']).optional(),
    birth_date: z.string().max(200).optional().describe('free text, GEDCOM style: "12 MAR 1901", "ABT 1890"'),
    birth_place: z.string().max(200).optional(),
    death_date: z.string().max(200).optional(),
    death_place: z.string().max(200).optional(),
    living: z.boolean().optional(),
    notes: z.string().max(20000).optional(),
  }

  server.tool('list_trees', 'List the family trees you can see, with your role in each and how many people they hold.', {}, async () => json(await client.trees()))

  server.tool(
    'search_people',
    'Search a family tree by name, place or year. Every word must match. Returns ids to use with the other tools.',
    { tree_id: z.string(), query: z.string().max(200).default(''), limit: z.number().int().min(1).max(500).optional() },
    async ({ tree_id, query, limit }: any) => json((await client.people(tree_id, query, limit ?? 50)).map((p) => ({ id: p.id, name: p.name, birth: [p.birth_date, p.birth_place].filter(Boolean).join(', '), death: [p.death_date, p.death_place].filter(Boolean).join(', '), living: !!p.living }))),
  )

  server.tool('get_person', 'Everything about one person: dates, places, parents, siblings, partners, children, events, sources, notes.', { tree_id: z.string(), person_id: z.string() }, async ({ tree_id, person_id }: any) => text(formatPerson(await client.person(tree_id, person_id))))

  server.tool(
    'add_person',
    'Add someone to a tree. To attach them to an existing person, give relative_of (that person\'s id) and as: parent, partner or child (what the NEW person is to them).',
    { tree_id: z.string(), ...person, relative_of: z.string().optional(), as: z.enum(['parent', 'partner', 'child']).optional(), relation: z.enum(['birth', 'adopted', 'step', 'foster']).optional() },
    async ({ tree_id, ...fields }: any) => {
      const p = await client.addPerson(tree_id, fields)
      return text(`Added ${p.name} (${p.id}).\n\n${formatPerson(p)}`)
    },
  )

  server.tool('update_person', 'Change facts about a person. Only the fields given are changed.', { tree_id: z.string(), person_id: z.string(), ...person }, async ({ tree_id, person_id, ...fields }: any) => text(formatPerson(await client.updatePerson(tree_id, person_id, fields))))

  server.tool(
    'link_relative',
    'Record that two people already in the tree are related: other_id is the parent, partner or child of person_id.',
    { tree_id: z.string(), person_id: z.string(), other_id: z.string(), as: z.enum(['parent', 'partner', 'child']), relation: z.enum(['birth', 'adopted', 'step', 'foster']).optional() },
    async ({ tree_id, person_id, other_id, as, relation }: any) => text(formatPerson(await client.addPerson(tree_id, { relative_of: person_id, existing_id: other_id, as, relation }))),
  )

  server.tool(
    'add_event',
    'Add a life event to a person: Residence, Occupation, Military, Immigration, Census, Burial, or anything else.',
    { tree_id: z.string(), person_id: z.string(), type: z.string().max(60), date: z.string().max(200).optional(), place: z.string().max(200).optional(), description: z.string().max(5000).optional() },
    async ({ tree_id, person_id, ...event }: any) => {
      await client.addEvent(tree_id, person_id, event)
      return text('Event added.')
    },
  )

  server.tool('pedigree', "A person's ancestors, generation by generation (Ahnentafel numbered: father 2n, mother 2n+1).", { tree_id: z.string(), person_id: z.string(), generations: z.number().int().min(2).max(8).optional() }, async ({ tree_id, person_id, generations }: any) => text(formatPedigree(await client.pedigree(tree_id, person_id, generations ?? 4), generations ?? 4)))

  server.tool('descendants', "A person's descendants with their partners.", { tree_id: z.string(), person_id: z.string(), generations: z.number().int().min(1).max(10).optional() }, async ({ tree_id, person_id, generations }: any) => text(formatDescendants(await client.descendants(tree_id, person_id, generations ?? 3))))

  server.tool('relationship', 'How two people in a tree are related, in words ("second cousin once removed") and as the chain of people between them.', { tree_id: z.string(), a: z.string(), b: z.string() }, async ({ tree_id, a, b }: any) => json(await client.relate(tree_id, a, b)))

  server.tool('export_gedcom', 'Export a tree as GEDCOM 5.5.1 text. privacy hides details of living people.', { tree_id: z.string(), privacy: z.boolean().optional() }, async ({ tree_id, privacy }: any) => text(await client.exportGedcom(tree_id, privacy ?? true)))

  server.tool('import_gedcom', 'Import GEDCOM text into a tree you can edit.', { tree_id: z.string(), gedcom: z.string().max(25_000_000) }, async ({ tree_id, gedcom }: any) => json(await client.importGedcom(tree_id, gedcom)))

  server.tool(
    'invite_to_tree',
    'Email someone an invite to a family tree. Give person_id to invite them to BE that person: once they join, they manage their own profile. Up to 20 emails at once, and a daily limit per sender.',
    { tree_id: z.string(), emails: z.array(z.string().email()).min(1).max(20), role: z.enum(['viewer', 'editor']).optional(), person_id: z.string().optional(), note: z.string().max(1000).optional() },
    async ({ tree_id, emails, ...opts }: any) => json(await client.invite(tree_id, emails, opts)),
  )

  server.tool('tree_members', 'Who belongs to a tree, their role, and which person each one is (if they claimed a profile).', { tree_id: z.string() }, async ({ tree_id }: any) => json(await client.members(tree_id)))

  // ---- network: the people in your life, private to you ----
  const contact = {
    name: z.string().max(200).optional(),
    nickname: z.string().max(200).optional(),
    circle: z.enum(['family', 'friends', 'business']).optional(),
    relationship: z.string().max(200).optional().describe('how you know them: "cousin", "college roommate", "our plumber"'),
    company: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    birthday: z.string().max(200).optional(),
    anniversary: z.string().max(200).optional(),
    emails: z.array(z.string()).max(20).optional().describe('"work: a@b.com" or just the address'),
    phones: z.array(z.string()).max(20).optional(),
    addresses: z.array(z.object({ label: z.string().optional(), lines: z.string() })).max(10).optional(),
    links: z.array(z.string().url()).max(20).optional(),
    notes: z.string().max(20000).optional(),
  }

  server.tool('list_contacts', "Search your network (family, friends, business). Private to you; matches names, emails, phones, companies, addresses and notes.", { query: z.string().max(200).default(''), circle: z.enum(['family', 'friends', 'business']).optional() }, async ({ query, circle }: any) => json(await client.contacts(query, circle)))
  server.tool('get_contact', 'Everything you keep about one contact.', { contact_id: z.string() }, async ({ contact_id }: any) => json(await client.contact(contact_id)))
  server.tool('add_contact', 'Add someone you know to your network.', contact, async (fields: any) => json(await client.addContact(fields)))
  server.tool('update_contact', 'Change a contact. Lists (emails, phones, addresses, links) are replaced whole.', { contact_id: z.string(), ...contact }, async ({ contact_id, ...fields }: any) => json(await client.updateContact(contact_id, fields)))
  server.tool('connect_contact', 'Ask a contact to connect: one email from you, and if they say yes you can message each other. Use it for people the user actually knows, one at a time.', { contact_id: z.string(), note: z.string().max(1000).optional() }, async ({ contact_id, note }: any) => text(await client.connectContact(contact_id, note)))
  server.tool('inbox', 'Your conversations, newest first, with unread counts, and who you could write to.', {}, async () => json(await client.inbox()))
  server.tool('read_conversation', 'The messages between you and one person (marks them read).', { user_id: z.string() }, async ({ user_id }: any) => json(await client.conversation(user_id)))
  server.tool('send_message', 'Send a private message to one person you are connected with or share a tree with. Only send what the user asked you to send.', { user_id: z.string(), body: z.string().min(1).max(5000) }, async ({ user_id, body }: any) => json(await client.sendMessage(user_id, body)))

  return server
}

export async function runMcp(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport())
}
