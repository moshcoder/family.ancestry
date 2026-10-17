import { describe, expect, test } from 'bun:test'
import { Store, fullName } from '../src/db.ts'
import { exportGedcom, importGedcom, parseLines, splitName } from '../src/gedcom.ts'
import { SAMPLE_GED } from './fixtures.ts'

const fresh = () => {
  const store = new Store(':memory:')
  const user = store.findOrCreateUser('a@example.com')
  return { store, tree: store.createTree(user.id, 'Imported'), user }
}

describe('gedcom', () => {
  test('splitName', () => {
    expect(splitName('Johann /Ettinger/')).toEqual({ given: 'Johann', surname: 'Ettinger' })
    expect(splitName('John Paul /Smith/ Jr')).toEqual({ given: 'John Paul Jr', surname: 'Smith' })
    expect(splitName('Mononym')).toEqual({ given: 'Mononym', surname: '' })
  })

  test('parseLines nests by level and tolerates CRLF + BOM', () => {
    const roots = parseLines('﻿0 HEAD\r\n1 CHAR UTF-8\r\n0 @I1@ INDI\r\n1 NAME A /B/\r\n0 TRLR\r\n')
    expect(roots.map((r) => r.tag)).toEqual(['HEAD', 'INDI', 'TRLR'])
    expect(roots[1]!.xref).toBe('@I1@')
    expect(roots[1]!.children[0]!.value).toBe('A /B/')
  })

  test('imports people, families, events, sources, notes and pedigree', () => {
    const { store, tree } = fresh()
    const r = importGedcom(store, tree.id, SAMPLE_GED)
    expect(r).toMatchObject({ people: 6, families: 2, sources: 1 })
    expect(r.events).toBe(2)
    const johann = store.search(tree.id, 'johann')[0]!
    expect(johann).toMatchObject({ surname: 'Ettinger', sex: 'M', birth_date: '12 MAR 1871', birth_place: 'Baden, Germany', death_date: '1940' })
    expect(johann.notes).toBe('Came over on the SS Elbe. Ran a bakery on Halsted Street for thirty years.\nGrandma said he never lost the accent.')
    expect(store.events(tree.id, johann.id).map((e) => e.type).sort()).toEqual(['Immigration', 'Occupation'])
    expect(store.citationsFor(tree.id, johann.id)[0]).toMatchObject({ title: '1910 United States Federal Census', page: 'Sheet 4A, line 12' })
    const anna = store.search(tree.id, 'anna')[0]!
    expect(store.parentFamilies(tree.id, anna.id)[0]!.relation).toBe('adopted')
    const robert = store.search(tree.id, 'robert')[0]!
    const ped = store.pedigree(tree.id, robert.id, 3)
    expect(fullName(ped.get(4)!)).toBe('Johann Ettinger')
    expect(fullName(ped.get(5)!)).toBe('Maria Weber')
  })

  test('rejects things that are not GEDCOM', () => {
    const { store, tree } = fresh()
    expect(() => importGedcom(store, tree.id, '<html>nope</html>')).toThrow(/GEDCOM/)
  })

  test('round trip: export then import gives the same tree', () => {
    const a = fresh()
    importGedcom(a.store, a.tree.id, SAMPLE_GED)
    const ged = exportGedcom(a.store, a.tree.id)
    expect(ged.startsWith('0 HEAD\r\n')).toBe(true)
    expect(ged.trimEnd().endsWith('0 TRLR')).toBe(true)
    expect(ged).toContain('2 PEDI adopted')
    const b = fresh()
    const r = importGedcom(b.store, b.tree.id, ged)
    expect(r).toMatchObject({ people: 6, families: 2, sources: 1, events: 2 })
    const robert = b.store.search(b.tree.id, 'robert')[0]!
    expect(fullName(b.store.pedigree(b.tree.id, robert.id, 3).get(4)!)).toBe('Johann Ettinger')
    expect(b.store.search(b.tree.id, 'johann')[0]!.notes).toContain('never lost the accent')
  })

  test('privacy export hides living people', () => {
    const { store, tree } = fresh()
    store.addPerson(tree.id, { given: 'Secret', surname: 'Smith', birth_date: '1990', birth_place: 'Home', living: true })
    store.addPerson(tree.id, { given: 'Old', surname: 'Smith', birth_date: '1850', death_date: '1920' })
    const ged = exportGedcom(store, tree.id, { privacy: true })
    expect(ged).toContain('1 NAME Living /Smith/')
    expect(ged).not.toContain('Secret')
    expect(ged).not.toContain('Home')
    expect(ged).toContain('Old /Smith/')
  })

  test('long notes are split into CONC/CONT lines under 255 chars', () => {
    const { store, tree } = fresh()
    store.addPerson(tree.id, { given: 'Long', notes: `${'x'.repeat(600)}\nsecond line` })
    const ged = exportGedcom(store, tree.id)
    expect(ged.split('\r\n').every((l) => l.length < 255)).toBe(true)
    const b = fresh()
    importGedcom(b.store, b.tree.id, ged)
    expect(b.store.search(b.tree.id, 'long')[0]!.notes).toBe(`${'x'.repeat(600)}\nsecond line`)
  })
})
