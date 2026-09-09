import { createNavigationContainerRef } from '@react-navigation/native'
import { AppNotification } from './notifications'

export const navigationRef = createNavigationContainerRef<any>()

type ManagementSection = 'lineup' | 'files' | 'conversation' | 'announcements' | 'versions'

function resolveManagementSection(notification: AppNotification): ManagementSection | null {
  const label = String(notification.data?.sectionLabel || notification.title || '').toLowerCase()

  if (label.includes('lineup')) return 'lineup'
  if (label.includes('file')) return 'files'
  if (label.includes('version')) return 'versions'
  if (label.includes('announcement') || label.includes('important message')) return 'announcements'
  if (label.includes('message')) return 'conversation'
  return null
}

export function navigateFromNotification(notification: AppNotification) {
  if (!navigationRef.isReady()) return false

  switch (notification.type) {
    case 'management_broadcast': {
      const initialSection = resolveManagementSection(notification)
      if (initialSection === 'lineup') {
        navigationRef.navigate('LineupsTab')
        return true
      }
      navigationRef.navigate('ManagementTab', initialSection ? { initialSection } : undefined)
      return true
    }
    case 'contact_request':
    case 'contact_accepted':
    case 'contact_rejected':
      navigationRef.navigate('ConversationTab')
      return true
    case 'new_upload':
      navigationRef.navigate('ChordListsTab')
      return true
    default:
      navigationRef.navigate('ManagementTab')
      return true
  }
}
