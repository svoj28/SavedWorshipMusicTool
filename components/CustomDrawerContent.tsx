// components/CustomDrawerContent.tsx
import React, { useEffect, useMemo, useState } from 'react'
import {
  View,
  StyleSheet,
  Text,
  TouchableOpacity,
  Alert,
  ScrollView,
  Clipboard,
  Image,
  Animated,
  Modal,
  Dimensions
} from 'react-native'
import { THEMES, useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import Svg, { Rect } from 'react-native-svg'
import QRCodeGenerator from 'qrcode-generator'
import { getCurrentUser, signOut, AuthUser } from '../lib/auth'
import { getContactsByUserId, getContactsByRecipientId, getUserProfileByUserId } from '../db/queries'
import { Contact, UserProfile } from '../db/models'
import { useNavigation, useFocusEffect } from '@react-navigation/native'
import { generateShortId } from '../lib/shortId'
import { onTableChange } from '../lib/sync'

type QRCodeGraphicProps = {
  value: string
  size: number
}

function QRCodeGraphic({ value, size }: QRCodeGraphicProps) {
  const { colors: c } = useAppTheme()

  const qr = useMemo(() => {
    const generated = QRCodeGenerator(0, 'M')
    generated.addData(value)
    generated.make()
    return generated
  }, [value])

  const moduleCount = qr.getModuleCount()
  const modules: React.ReactElement[] = []

  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (!qr.isDark(row, column)) {
        continue
      }

      modules.push(
        <Rect
          key={`${row}-${column}`}
          x={column}
          y={row}
          width={1}
          height={1}
          fill={c.accent}
        />
      )
    }
  }

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${moduleCount} ${moduleCount}`}>
      <Rect x={0} y={0} width={moduleCount} height={moduleCount} fill={c.surface} />
      {modules}
    </Svg>
  )
}

function buildRecipientQrValue(userId: string) {
  return JSON.stringify({
    type: 'savedworship:recipient',
    userId,
    shortId: generateShortId(userId),
  })
}

const guideSections = [
  {
    title: 'Getting Started',
    items: [
      'Sign in or create an account to unlock sync, private notes, chat, profile settings, and contact connections.',
      'Your drawer shows your profile, recipient ID, QR code, and a guide to the app features you can access.',
      'Use the tabs at the bottom to move between Chords, Notes, Manage, and Chat.',
      'The bell icon opens the in-app activity panel for shared updates, sync events, and incoming requests.',
    ],
  },
  {
    title: 'Profile, Friends, and Sharing',
    items: [
      'Edit profile details from the drawer to update your nickname, bio, avatar, and instruments.',
      'Use Show Recipient Info to reveal your unique recipient ID and copy it when connecting with another member.',
      'Open the QR code modal to share your profile with other users for direct messaging or collaboration.',
      'Add contacts, accept requests, and manage personal connections from the friend/contact flow in the drawer.',
    ],
  },
  {
    title: 'Chord Lists and Song Workflows',
    items: [
      'Browse shared chord lists from the Chords tab and open songs to view lyrics and chords together.',
      'Use transpose controls to quickly move a song into a new key without altering the original material.',
      'If you have permissions, you can add new songs, edit existing entries, and manage song data from the chord list flow.',
      'Song import and song editor tools help bring in and organize worship material cleanly.',
    ],
  },
  {
    title: 'Notes, Personal Lists, and Planning',
    items: [
      'Use the Notes tab for private chord lists and personal entries that stay attached to your account.',
      'Create, open, and manage note entries without exposing them to other users.',
      'The team calendar keeps rehearsal dates, schedules, and planning items visible to everyone involved.',
      'Manage screens help organize app-level workflows, resources, and shared settings.',
    ],
  },
  {
    title: 'Tools and Practice Features',
    items: [
      'Metronome gives you BPM control, tap tempo, and timing tools for practice and rehearsal.',
      'Tuner listens through the microphone and shows the frequency you are playing in Hz.',
      'Pad holds a synth chord in any key underneath your set and continues playing while you move around the app.',
      'Manual Transpose helps you shift chords quickly without editing the original song.',
      'Audio Tools groups extra playback, pitch, and utility features in one place.',
      'The app also includes activity-driven flows, sync-aware updates, and background maintenance for a smoother experience.',
    ],
  },
  {
    title: 'Chat and Communication',
    items: [
      'Chat is for real-time messages and ongoing communication with other users.',
      'The in-app activity feed tracks important updates, new uploads, contact requests, and app events.',
      'Use the contact flow and recipient sharing to build a trusted network of worship team members.',
    ],
  },
  {
    title: 'System and Sync',
    items: [
      'The app uses an offline-first local database so your content remains available even when the network is unavailable.',
      'Supabase handles authentication, cloud sync, and realtime updates when you are signed in.',
      'Changes are synchronized in the background so local edits can later reach the server and other devices.',
      'The activity feed, sync services, and repair routines keep the app responsive and up to date.',
      'Password reset and recovery flows are also available when you need to regain access to your account.',
    ],
  },
  {
    title: 'Tips',
    items: [
      'If something does not update immediately, reopen the screen or wait for sync to complete.',
      'Use the drawer QR code and recipient ID when connecting with other members.',
      'Keep your profile information current so sharing, scheduling, and collaboration stay consistent.',
      'Check the activity panel for contact requests, uploads, and other workflow updates.',
    ],
  },
]

interface Props {
  visible: boolean
  onClose: () => void
}
const { height: SCREEN_HEIGHT } = Dimensions.get('window')

export default function CustomDrawerContent({ visible, onClose }: Props) {
  const { colors: c, themeId, setThemeId } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [expandFriends, setExpandFriends] = useState(true)
  const [showRecipientShare, setShowRecipientShare] = useState(false)
  const [showQRModal, setShowQRModal] = useState(false)
  const [showGuideModal, setShowGuideModal] = useState(false)
  const navigation = useNavigation<any>()
  
  

  useEffect(() => {
    loadUser()
  }, [])

  useFocusEffect(
    React.useCallback(() => {
      if (user) {
        loadContacts()
        loadProfile()
      }
    }, [user])
  )

  useEffect(() => {
    const unsubContacts = onTableChange('contacts', () => {
      loadContacts()
    })
    const unsubProfiles = onTableChange('user_profiles', () => {
      loadProfile()
      loadContacts()
    })

    return () => {
      unsubContacts()
      unsubProfiles()
    }
  }, [user])

  const loadUser = async () => {
    try {
      const currentUser = await getCurrentUser()
      setUser(currentUser)
      if (currentUser) {
        await Promise.all([loadContacts(currentUser.id), loadProfile(currentUser.id)])
      }
    } catch (err) {
      console.error('Error loading user:', err)
    } finally {
      setLoading(false)
    }
  }

  const loadContacts = async (userId?: string) => {
    if (!userId && !user) return
    try {
      const selfId = userId || user!.id
      const [outgoing, incoming] = await Promise.all([
        getContactsByUserId(selfId),
        getContactsByRecipientId(selfId),
      ])

      const pairKey = (a: string, b: string) => [a, b].sort().join('::')
      const groups = new Map<string, Contact[]>()
      for (const contact of [...outgoing, ...incoming]) {
        const key = pairKey(contact.userId, contact.contactUserId)
        const list = groups.get(key) || []
        list.push(contact)
        groups.set(key, list)
      }

      const acceptedUnique = Array.from(groups.values()).flatMap((group) => {
        const blocked = group.find(contact => contact.status === 'blocked')
        if (blocked) return []

        const accepted = group.find(contact => contact.status === 'accepted')
        if (!accepted) return []

        return [accepted]
      })

      setContacts(acceptedUnique)
    } catch (err) {
      console.error('Error loading contacts:', err)
    }
  }

  const acceptedContacts = contacts.filter(c => c.status === 'accepted')

  const loadProfile = async (userId?: string) => {
    if (!userId && !user) return
    try {
      const userProfile = await getUserProfileByUserId(userId || user!.id)
      setProfile(userProfile)
    } catch (err) {
      console.error('Error loading profile:', err)
    }
  }

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await Clipboard.setString(text)
      Alert.alert('Copied', `${label} copied to clipboard`)
    } catch (err) {
      Alert.alert('Error', 'Failed to copy to clipboard')
    }
  }

  const handleLogout = async () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        onPress: async () => {
          try {
            onClose()
            await signOut()
          } catch (err) {
            Alert.alert('Error', 'Failed to sign out')
          }
        },
        style: 'destructive',
      },
    ])
  }

  const handleNavigate = (screenName: string) => {
    onClose()
    navigation.navigate(screenName)
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.drawerScroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.drawerContent}
      >
        {/* Header */}
        <View style={styles.header}>
          {/* Top accent line */}
          <View style={styles.accentLine} />

          {/* App title + guide action */}
          <View style={styles.titleBar}>
            <View style={styles.appTitleRow}>
              <Ionicons name="musical-notes" size={14} color={c.accentText} />
              <Text style={styles.appTitle}>SAVED WORSHIP</Text>
            </View>

            <TouchableOpacity
              style={styles.guideButton}
              onPress={() => setShowGuideModal(true)}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Open app guide"
            >
              <Ionicons name="information-circle-outline" size={20} color={c.accent} />
            </TouchableOpacity>
          </View>

          {/* Avatar & User Info */}
          <View style={styles.avatarRow}>
            <View style={styles.avatarWrapper}>
              {profile?.avatarUrl ? (
                <Image source={{ uri: profile.avatarUrl }} style={styles.avatar} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Ionicons name="person" size={28} color={c.text} />
                </View>
              )}
            </View>

            <View style={styles.userInfo}>
              <Text style={styles.userName}>
                {profile?.nickname || user?.email?.split('@')[0] || 'Member'}
              </Text>
              <Text style={styles.userEmail}>{user?.email || 'Not signed in'}</Text>
              {profile?.instruments && (
                <View style={styles.instrumentBadge}>
                  <Text style={styles.instrumentText}>{profile.instruments}</Text>
                </View>
              )}
            </View>
          </View>

          {/* Bio */}
          {profile?.bio && (
            <View style={styles.bioContainer}>
              <Text style={styles.bioText} numberOfLines={2}>
                {profile.bio}
              </Text>
            </View>
          )}

          {user?.id && (
            <View style={styles.recipientShareSection}>
              <TouchableOpacity
                style={styles.recipientShareToggle}
                onPress={() => setShowRecipientShare((current) => !current)}
                activeOpacity={0.75}
              >
                <Ionicons
                  name={showRecipientShare ? 'eye-off-outline' : 'eye-outline'}
                  size={14}
                  color={c.accentText}
                />
                <Text style={styles.recipientShareToggleText}>
                  {showRecipientShare ? 'Hide Recipient Info' : 'Show Recipient Info'}
                </Text>
              </TouchableOpacity>

              {showRecipientShare && (
                <>
                  <TouchableOpacity
                    style={styles.idContainer}
                    onPress={() => copyToClipboard(generateShortId(user.id), 'Recipient ID')}
                    activeOpacity={0.7}
                  >
                    <View style={styles.idRow}>
                      <Text style={styles.idLabel}>RECIPIENT ID</Text>
                      <View style={styles.copyBadge}>
                        <Ionicons name="copy-outline" size={11} color={c.accentText} />
                        <Text style={styles.copyText}>COPY</Text>
                      </View>
                    </View>
                    <Text style={styles.idValue}>{generateShortId(user.id)}</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.qrCodeContainer}
                    onPress={() => setShowQRModal(true)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.qrCodeWrapper}>
                      <QRCodeGraphic value={buildRecipientQrValue(user.id)} size={80} />
                    </View>
                    <View style={styles.qrLabel}>
                      <Ionicons name="scan-circle-outline" size={12} color={c.textMuted} />
                      <Text style={styles.qrLabelText}>Tap to enlarge</Text>
                    </View>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}
        </View>

        <View style={styles.drawerBody}>
      {/* Guide Modal */}
      <Modal
        visible={showGuideModal}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setShowGuideModal(false)}
      >
        <View style={styles.guideModalOverlay}>
          <TouchableOpacity
            style={styles.guideModalBackdrop}
            onPress={() => setShowGuideModal(false)}
            activeOpacity={1}
          />

          <View style={styles.guideModalContent}>
            <View style={styles.guideModalHeader}>
              <View style={styles.guideModalTitleWrap}>
                <Text style={styles.guideModalEyebrow}>App Guide</Text>
                <Text style={styles.guideModalTitle}>How Saved Worship Works</Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowGuideModal(false)}
                style={styles.guideModalCloseButton}
                accessibilityRole="button"
                accessibilityLabel="Close app guide"
              >
                <Ionicons name="close" size={24} color={c.textSub} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.guideModalBody}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.guideModalBodyContent}
            >
              <Text style={styles.guideIntroText}>
                Saved Worship is a worship music workspace for chord lists, lyrics, notes, sync,
                and communication. Use this guide to understand the main screens and the system
                behind them.
              </Text>

              {guideSections.map((section) => (
                <View key={section.title} style={styles.guideSectionCard}>
                  <Text style={styles.guideSectionTitle}>{section.title}</Text>
                  {section.items.map((item) => (
                    <View key={item} style={styles.guideBulletRow}>
                      <View style={styles.guideBulletDot} />
                      <Text style={styles.guideBulletText}>{item}</Text>
                    </View>
                  ))}
                </View>
              ))}

              <View style={styles.guideFooterCard}>
                <Ionicons name="shield-checkmark-outline" size={18} color={c.accentText} />
                <Text style={styles.guideFooterText}>
                  Your content is designed to work offline first, then sync when the connection is
                  available.
                </Text>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

        {/* Scrollable Menu */}
        {/* Section: Account */}
        <Text style={styles.sectionLabel}>ACCOUNT</Text>

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => handleNavigate('EditAccount')}
          activeOpacity={0.6}
        >
          <View style={styles.menuIcon}>
            <Ionicons name="person-outline" size={18} color={c.text} />
          </View>
          <Text style={styles.menuLabel}>Edit Profile</Text>
          <Ionicons name="chevron-forward" size={16} color={c.iconInactive} />
        </TouchableOpacity>

        {/* Section: Calendar */}
         <Text style={[styles.sectionLabel, { marginTop: 20 }]}>TEAM SCHEDULE CALENDAR</Text>
              
        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => handleNavigate('Calendar')}
          activeOpacity={0.6}
        >
          <View style={styles.menuIcon}>
            <Ionicons name="calendar-outline" size={18} color={c.text} />
          </View>
          <Text style={styles.menuLabel}>Team Calendar</Text>
          <Ionicons name="chevron-forward" size={16} color={c.iconInactive} />
        </TouchableOpacity>

        {/* Section: Tools */}
        <Text style={[styles.sectionLabel, { marginTop: 20 }]}>TOOLS</Text>

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => handleNavigate('Metronome')}
          activeOpacity={0.6}
        >
          <View style={styles.menuIcon}>
            <Ionicons name="timer-outline" size={18} color={c.text} />
          </View>
          <Text style={styles.menuLabel}>Metronome</Text>
          <Ionicons name="chevron-forward" size={16} color={c.iconInactive} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => handleNavigate('Tuner')}
          activeOpacity={0.6}
        >
          <View style={styles.menuIcon}>
            <Ionicons name="musical-notes-outline" size={18} color={c.text} />
          </View>
          <Text style={styles.menuLabel}>Tuner</Text>
          <Ionicons name="chevron-forward" size={16} color={c.iconInactive} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => handleNavigate('Pad')}
          activeOpacity={0.6}
        >
          <View style={styles.menuIcon}>
            <Ionicons name="pulse-outline" size={18} color={c.text} />
          </View>
          <Text style={styles.menuLabel}>Pad</Text>
          <Ionicons name="chevron-forward" size={16} color={c.iconInactive} />
        </TouchableOpacity>

        

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => handleNavigate('ManualTranspose')}
          activeOpacity={0.6}
        >
          <View style={styles.menuIcon}>
            <Ionicons name="git-compare-outline" size={18} color={c.text} />
          </View>
          <Text style={styles.menuLabel}>Transpose Chords</Text>
          <Ionicons name="chevron-forward" size={16} color={c.iconInactive} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.menuItem, { borderBottomWidth: 0 }]}
          onPress={() => handleNavigate('AudioTools')}
          activeOpacity={0.6}
        >
          <View style={styles.menuIcon}>
            <Ionicons name="musical-note-outline" size={18} color={c.text} />
          </View>
          <Text style={styles.menuLabel}>Audio Tools</Text>
          <Ionicons name="chevron-forward" size={16} color={c.iconInactive} />
        </TouchableOpacity>

        {/* ── Appearance ────────────────────────────────────────────────
            Every theme is monochrome, so the swatch shows the only thing
            that actually differs between them: where each one sits on the
            grey ramp, and what text looks like against it. */}
        <Text style={styles.appearanceHeading}>Appearance</Text>

        {THEMES.map(theme => {
          const selected = theme.id === themeId
          return (
            <TouchableOpacity
              key={theme.id}
              style={[styles.themeRow, selected && styles.themeRowActive]}
              onPress={() => setThemeId(theme.id)}
              activeOpacity={0.7}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
            >
              <View style={[styles.themeSwatch, { backgroundColor: theme.colors.bg, borderColor: theme.colors.border }]}>
                <View style={[styles.themeSwatchBar, { backgroundColor: theme.colors.text }]} />
                <View style={[styles.themeSwatchBar, styles.themeSwatchBarShort, { backgroundColor: theme.colors.textMuted }]} />
              </View>

              <View style={{ flex: 1 }}>
                <Text style={styles.themeName}>{theme.name}</Text>
                <Text style={styles.themeDescription}>{theme.description}</Text>
              </View>

              <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={18}
                color={selected ? c.text : c.iconInactive}
              />
            </TouchableOpacity>
          )
        })}

        <View style={{ height: 24 }} />

        {/* Footer: Sign Out */}
        <View style={styles.footer}>
          <View style={styles.footerDivider} />
          <TouchableOpacity style={styles.signOutButton} onPress={handleLogout} activeOpacity={0.7}>
            <Ionicons name="log-out-outline" size={17} color={c.textSub} />
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
        </View>
      </ScrollView>

      {/* QR Code Modal */}
      <Modal
        visible={showQRModal}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setShowQRModal(false)}
      >
        <View style={styles.qrModalOverlay}>
          <TouchableOpacity
            style={styles.qrModalBackdrop}
            onPress={() => setShowQRModal(false)}
            activeOpacity={1}
          />
          <View style={styles.qrModalContent}>
            <View style={styles.qrModalHeader}>
              <Text style={styles.qrModalTitle}>Your Profile QR Code</Text>
              <TouchableOpacity
                onPress={() => setShowQRModal(false)}
                style={styles.qrModalCloseButton}
              >
                <Ionicons name="close" size={24} color={c.textSub} />
              </TouchableOpacity>
            </View>

            <View style={styles.qrModalBody}>
              <View style={styles.qrModalQRWrapper}>
                {user?.id && (
                  <QRCodeGraphic value={buildRecipientQrValue(user.id)} size={240} />
                )}
              </View>
              <Text style={styles.qrModalSubtext}>Share this QR code for direct messaging</Text>
            </View>

            <TouchableOpacity
              style={styles.qrModalCopyButton}
              onPress={() => {
                copyToClipboard(generateShortId(user?.id || ''), 'Recipient ID')
                setShowQRModal(false)
              }}
            >
              <Ionicons name="copy-outline" size={16} color={c.accentText} />
              <Text style={styles.qrModalCopyText}>Copy Recipient ID</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: {
    // Fills whatever the host sizes the drawer to - App.tsx owns the width now,
    // because the slide-in animation has to travel exactly that far.
    width: '100%',
    height: '100%',
    backgroundColor: c.surface,
    borderRightWidth: 1,
    borderRightColor: c.border,
  },

  // ── Header ──────────────────────────────────────────────
  header: {
    backgroundColor: c.accent,
    paddingHorizontal: 20,
    paddingTop: 52,
    paddingBottom: 20,
  },
  accentLine: {
    width: 28,
    height: 2,
    backgroundColor: c.surface,
    marginBottom: 16,
    opacity: 0.9,
  },
  titleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  appTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  appTitle: {
    fontSize: 10,
    letterSpacing: 2.5,
    color: c.accentText,
    fontWeight: '600',
    opacity: 0.9,
  },
  guideButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: c.accentText,
    backgroundColor: c.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 14,
  },
  avatarWrapper: {
    borderWidth: 1.5,
    borderColor: c.hairline,
    borderRadius: 30,
    padding: 2,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  avatarPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: c.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 17,
    fontWeight: '700',
    color: c.accentText,
    letterSpacing: 0.2,
    marginBottom: 3,
  },
  userEmail: {
    fontSize: 12,
    color: c.accentText,
    marginBottom: 6,
    opacity: 0.9,
  },
  instrumentBadge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: c.hairline,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  instrumentText: {
    fontSize: 10,
    color: c.accentText,
    letterSpacing: 0.5,
    opacity: 0.9,
  },
  bioContainer: {
    borderTopWidth: 1,
    borderTopColor: c.hairline,
    paddingTop: 12,
    marginBottom: 14,
  },
  bioText: {
    fontSize: 12,
    color: c.accentText,
    lineHeight: 18,
    fontStyle: 'italic',
    opacity: 0.9,
  },
  recipientShareSection: {
    gap: 10,
  },
  recipientShareToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: c.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingVertical: 10,
  },
  recipientShareToggleText: {
    fontSize: 11,
    color: c.text,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  idContainer: {
    backgroundColor: c.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 12,
  },
  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  idLabel: {
    fontSize: 9,
    letterSpacing: 2,
    color: c.textSub,
    fontWeight: '600',
  },
  copyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.surface,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  copyText: {
    fontSize: 9,
    letterSpacing: 1,
    color: c.text,
    fontWeight: '600',
  },
  idValue: {
    fontSize: 13,
    fontFamily: 'monospace',
    color: c.text,
    letterSpacing: 1,
  },

  // ── Menu ────────────────────────────────────────────────
  drawerScroll: {
    flex: 1,
  },
  drawerContent: {
    paddingBottom: 24,
  },
  drawerBody: {
    paddingHorizontal: 20,
  },
  sectionLabel: {
    fontSize: 9,
    letterSpacing: 2.5,
    color: c.iconInactive,
    fontWeight: '700',
    marginBottom: 8,
    marginTop: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
    marginBottom: 8,
  },
  expandButton: {
    padding: 4,
  },
  appearanceHeading: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: c.textMuted,
    marginTop: 22,
    marginBottom: 10,
  },
  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  themeRowActive: {
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  themeSwatch: {
    width: 38,
    height: 38,
    borderRadius: 9,
    borderWidth: 1,
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 7,
  },
  themeSwatchBar: { height: 3, borderRadius: 2 },
  themeSwatchBarShort: { width: '60%' },
  themeName: { fontSize: 14, fontWeight: '700', color: c.text },
  themeDescription: { fontSize: 11, color: c.textMuted, marginTop: 2 },

  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    gap: 12,
  },
  menuIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: c.text,
    letterSpacing: 0.1,
  },

  // ── Friends ─────────────────────────────────────────────
  friendsContainer: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.hairline,
    overflow: 'hidden',
  },
  emptyFriends: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 8,
  },
  emptyFriendsText: {
    fontSize: 12,
    color: c.iconInactive,
    fontStyle: 'italic',
  },
  friendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    gap: 10,
  },
  friendAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  friendAvatarText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.accentText,
  },
  friendInfo: {
    flex: 1,
  },
  friendName: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
  },
  friendId: {
    fontSize: 10,
    color: c.iconInactive,
    marginTop: 1,
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: c.accent,
  },
  countRow: {
    marginTop: 8,
    alignItems: 'flex-end',
  },
  countText: {
    fontSize: 10,
    color: c.iconInactive,
    letterSpacing: 0.5,
  },

  // ── Footer ───────────────────────────────────────────────
  footer: {
    paddingHorizontal: 0,
    paddingTop: 8,
    paddingBottom: 0,
  },
  footerDivider: {
    height: 1,
    backgroundColor: c.surfaceAlt,
    marginBottom: 14,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  signOutText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.textSub,
    letterSpacing: 0.3,
  },

  // ── QR Code ──────────────────────────────────────────────
  qrCodeContainer: {
    backgroundColor: c.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 16,
    marginTop: 10,
    alignItems: 'center',
  },
  qrCodeWrapper: {
    backgroundColor: c.surface,
    padding: 8,
    borderRadius: 6,
    marginBottom: 10,
  },
  qrLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  qrLabelText: {
    fontSize: 11,
    color: c.textMuted,
    fontStyle: 'italic',
    letterSpacing: 0.3,
  },

  // ── QR Modal ─────────────────────────────────────────────
  qrModalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.accent,
  },
  qrModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  qrModalContent: {
    backgroundColor: c.surface,
    borderRadius: 16,
    width: '85%',
    maxWidth: 320,
    overflow: 'hidden',
    elevation: 10,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  qrModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  qrModalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
    letterSpacing: 0.2,
  },
  qrModalCloseButton: {
    padding: 4,
  },
  qrModalBody: {
    paddingHorizontal: 20,
    paddingVertical: 24,
    alignItems: 'center',
  },
  qrModalQRWrapper: {
    backgroundColor: c.surfaceAlt,
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  qrModalSubtext: {
    fontSize: 12,
    color: c.textMuted,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  qrModalCopyButton: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginBottom: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: c.accent,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  qrModalCopyText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.accentText,
    letterSpacing: 0.3,
  },

  // ── Guide Modal ─────────────────────────────────────────
  guideModalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.accent,
    paddingHorizontal: 16,
  },
  guideModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  guideModalContent: {
    width: '100%',
    maxWidth: 420,
    height: SCREEN_HEIGHT * 0.88,
    backgroundColor: c.surface,
    borderRadius: 18,
    overflow: 'hidden',
    elevation: 10,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  guideModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  guideModalTitleWrap: {
    flex: 1,
    paddingRight: 12,
  },
  guideModalEyebrow: {
    fontSize: 9,
    letterSpacing: 2.2,
    textTransform: 'uppercase',
    color: c.textMuted,
    marginBottom: 4,
    fontWeight: '700',
  },
  guideModalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: c.text,
    letterSpacing: 0.2,
  },
  guideModalCloseButton: {
    padding: 4,
  },
  guideModalBody: {
    flexShrink: 1,
  },
  guideModalBodyContent: {
    paddingHorizontal: 20,
    paddingVertical: 18,
    paddingBottom: 28,
    flexGrow: 1,
    gap: 12,
  },
  guideIntroText: {
    fontSize: 13,
    lineHeight: 20,
    color: c.textSub,
    marginBottom: 4,
  },
  guideSectionCard: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 16,
    gap: 10,
  },
  guideSectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: c.text,
    letterSpacing: 0.15,
  },
  guideBulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  guideBulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.accent,
    marginTop: 7,
  },
  guideBulletText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: c.textSub,
  },
  guideFooterCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.accent,
    borderRadius: 14,
    padding: 16,
  },
  guideFooterText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    color: c.accentText,
  },
})
