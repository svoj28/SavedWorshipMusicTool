export function isChordListPrivate(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '' || normalized === '0' || normalized === 'false' || normalized === 'f' || normalized === 'no') {
      return false
    }
    if (normalized === '1' || normalized === 'true' || normalized === 't' || normalized === 'yes') {
      return true
    }
  }
  return Boolean(value)
}

export function isChordListPublic(record: { is_private?: unknown; isPrivate?: unknown }): boolean {
  const privacyValue = record.is_private ?? record.isPrivate
  return !isChordListPrivate(privacyValue)
}