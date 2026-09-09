import React, { useState , useMemo} from 'react'
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import { useNotifications } from '../lib/NotificationContext'
import { isMuted } from '../lib/notifications'
import NotificationPanel from './NotificationPanel'

export default function NotificationBell() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const { unreadCount, muteState } = useNotifications()
  const [panelVisible, setPanelVisible] = useState(false)
  const muted = isMuted(muteState)

  return (
    <>
      <TouchableOpacity
        onPress={() => setPanelVisible(true)}
        style={[styles.button, muted && styles.buttonMuted]}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.65}
      >
        <Ionicons
          name={muted ? 'notifications-off-outline' : 'notifications-outline'}
          size={20}
          color={muted ? c.textMuted : c.text}
        />

        {unreadCount > 0 && !muted && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </Text>
          </View>
        )}
      </TouchableOpacity>

      <NotificationPanel
        visible={panelVisible}
        onClose={() => setPanelVisible(false)}
      />
    </>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  button: {
    marginRight: 14,
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
    position: 'relative',
  },
  buttonMuted: {
    backgroundColor: c.surfaceAlt,
    borderColor: c.hairline,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: c.accent,
    borderRadius: 9,
    minWidth: 17,
    height: 17,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 1.5,
    borderColor: c.hairline,
  },
  badgeText: {
    color: c.accentText,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
})