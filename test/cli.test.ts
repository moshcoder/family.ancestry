import { describe, expect, test } from 'bun:test'
import { formatPedigree, parseArgs, personFields } from '../src/cli.ts'
import { parseDnsAnswer } from '../src/client.ts'
import { initialState, onKey, relatives } from '../src/tui.ts'
import { createMcpServer } from '../src/mcp.ts'
import { AncestryClient } from '../src/client.ts'

describe('cli', () => {
  test('parseArgs', () => {
    expect(parseArgs(['add', '--given', 'Ada', '--living', '--surname=Lovelace', '-g', '5'])).toEqual({ _: ['add'], flags: { given: 'Ada', living: true, surname: 'Lovelace', generations: '5' } })
  })

  test('personFields maps flags to fields', () => {
    expect(personFields({ given: 'A', born: '1900', birthplace: 'X', living: true, tree: 't' })).toEqual({ given: 'A', birth_date: '1900', birth_place: 'X', living: true })
  })

  test('formatPedigree draws a sideways tree', () => {
    const out = formatPedigree(
      [
        { n: 1, name: 'Me', birth_date: '1990', death_date: null },
        { n: 2, name: 'Dad', birth_date: '1960', death_date: null },
        { n: 3, name: 'Mum', birth_date: '1962', death_date: null },
        { n: 4, name: 'Grandpa', birth_date: '1930', death_date: '2010' },
      ],
      3,
    )
    expect(out).toBe(['Me (1990–)  #1', '├─ Dad (1960–)  #2', '│  └─ Grandpa (1930–2010)  #4', '└─ Mum (1962–)  #3'].join('\n'))
  })

  test('parseDnsAnswer reads A records', () => {
    // header (1 question, 1 answer), question family.ancestry A IN, answer ptr c00c A IN ttl 60 len 4 1.2.3.4
    const q = [6, ...Buffer.from('family'), 8, ...Buffer.from('ancestry'), 0, 0, 1, 0, 1]
    const buf = new Uint8Array([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, ...q, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4])
    expect(parseDnsAnswer(buf)).toEqual(['1.2.3.4'])
  })
})

describe('tui keys', () => {
  test('typing searches, tab switches panes, enter jumps', () => {
    const s = initialState()
    s.people = [{ id: 'a' } as any, { id: 'b' } as any]
    expect(onKey(s, { name: 'k', key: 'k', char: 'k' })).toBe('search')
    expect(s.query).toBe('k')
    expect(onKey(s, { name: 'down', key: 'down' })).toBe('load')
    expect(s.selected).toBe(1)
    onKey(s, { name: 'tab', key: 'tab' })
    expect(s.focus).toBe('detail')
    s.detail = { parents: [{ parents: [{ id: 'p', name: 'P' }], siblings: [] }], unions: [] } as any
    expect(relatives(s.detail).map((r) => r.id)).toEqual(['p'])
    expect(onKey(s, { name: 'enter', key: 'enter' })).toBe('jump')
    expect(onKey(s, { name: 'c', key: 'ctrl+c' })).toBe('quit')
  })
})

describe('mcp', () => {
  test('registers the family tree tools', () => {
    const server: any = createMcpServer(new AncestryClient({ url: 'http://127.0.0.1:1', token: null }))
    const tools = Object.keys(server._registeredTools ?? {})
    for (const name of ['list_trees', 'search_people', 'get_person', 'add_person', 'link_relative', 'pedigree', 'descendants', 'relationship', 'export_gedcom', 'import_gedcom', 'invite_to_tree', 'tree_members', 'list_contacts', 'add_contact', 'connect_contact', 'inbox', 'send_message']) expect(tools).toContain(name)
  })
})
