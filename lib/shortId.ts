/**
 * Generate a short, user-friendly ID from a UUID
 * Converts the UUID to a base36 number and takes first 8 characters
 */
export function generateShortId(uuid: string): string {
  // Remove hyphens from UUID
  const cleanUuid = uuid.replace(/-/g, '')
  
  // Convert hex to decimal then to base36 for a shorter representation
  // Take first 16 chars of UUID and convert to base36
  const shortened = parseInt(cleanUuid.substring(0, 12), 16)
    .toString(36)
    .toUpperCase()
    .padEnd(8, 'X')
    .substring(0, 8)
  
  return shortened
}

/**
 * Format a UUID to show shortened version with a visual indicator
 */
export function formatShortId(uuid: string): string {
  return generateShortId(uuid)
}
