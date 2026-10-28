export function normalizeBase(name: string): string {
  let v = String(name || '').trim()
  v = v.replace(/\.json$/i, '')
  v = v.replace(/\\/g, '/')
  v = v.replace(/^Data:Structures\//i, '')
  v = v.replace(/^Data:/i, '')
  const slash = v.lastIndexOf('/')
  if (slash >= 0) v = v.slice(slash + 1)
  return v
}

export function dataPageTitle(base: string, suffix = ''): string {
  return `Data:Structures/${base}${suffix}.json`
}

export function indexTitle(base: string): string {
  return dataPageTitle(normalizeBase(base), '')
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function partTitle(base: string, partIndex: number): string {
  return dataPageTitle(normalizeBase(base), `_${pad2(partIndex)}`)
}

export function structureDisplayNameFromTitle(title: string): string {
  const t = title.replace(/^Data:Structures\//i, '').replace(/\.json$/i, '')
  const us = t.indexOf('_')
  return us >= 0 ? t.slice(0, us) : t
}
