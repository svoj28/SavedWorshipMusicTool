import React, { useEffect, useState , useMemo} from 'react'
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Image,
  ScrollView,
  Animated,
  Dimensions,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import { getUserProfileByUserId } from '../db/queries'
import { UserProfile } from '../db/models'

const { width, height } = Dimensions.get('window')

const ROLE_ICONS: Record<string, string> = {
  Vocals: 'mic',
  Drums: 'musical-notes',
  Keyboard: 'musical-note',
  Bass: 'musical-notes',
  'Electric Guitar': 'musical-note',
  'Acoustic Guitar': 'musical-note',
  'Song Leader': 'star',
}

interface UserProfileModalProps {
  visible: boolean
  targetUserId: string | null
  onClose: () => void
  onMessage?: (userId: string) => void
  isActiveUser?: boolean
}

export default function UserProfileModal({
  visible,
  targetUserId,
  onClose,
  onMessage,
  isActiveUser = false,
}: UserProfileModalProps) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [isPrivate, setIsPrivate] = useState(false)
  const slideAnim = React.useRef(new Animated.Value(height)).current
const fadeAnim = React.useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (visible && targetUserId) {
      loadProfile(targetUserId)
Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 70,
        friction: 12,
      }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start()
    } else {
Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: height,
        duration: 260,
        useNativeDriver: true,
      }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start()
    }
  }, [visible, targetUserId])

  const loadProfile = async (uid: string) => {
    setLoading(true)
    try {
      const local = await getUserProfileByUserId(uid)
      if (local) {
        setProfile(local)
                setIsPrivate(local.bio?.startsWith('[private]') ?? false)
      } else {
                try {
          const { supabase } = await import('../lib/supabase')
          const { data } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('user_id', uid)
            .single()
          if (data) {
            setProfile({
              id: data.id,
              userId: data.user_id,
              nickname: data.nickname ?? '',
              bio: data.bio ?? '',
              avatarUrl: data.avatar_url ?? '',
              instruments: data.instruments ?? '',
              createdAt: data.created_at ?? Date.now(),
              updatedAt: data.updated_at ?? Date.now(),
              synced: true,
              role: data.role ?? 'user',
            })
            setIsPrivate(data.bio?.startsWith('[private]') ?? false)
          }
        } catch (e) {}
      }
    } catch (err) {
      console.error('Error loading profile for modal:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
Animated.parallel([
    Animated.timing(slideAnim, {
      toValue: height,
      duration: 240,
      useNativeDriver: true,
    }),
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => onClose())
  }

  const roles = profile?.instruments
    ? profile.instruments.split(',').map(r => r.trim()).filter(Boolean)
    : []

    const displayBio = profile?.bio?.replace('[private]', '').trim() || ''

  if (!visible) return null

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose}>
      {/* Backdrop */}
<Animated.View style={[styles.backdrop, { opacity: fadeAnim }]}>
      <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={handleClose} />
</Animated.View>

      <Animated.View style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}>
        {/* Pull indicator */}
<View style={styles.pullBarWrapper}>
        <View style={styles.pullBar} />
</View>

        <ScrollView
showsVerticalScrollIndicator={false}
bounces={false}
          contentContainerStyle={styles.scrollContent}
>
          {/* ── Hero Banner ── */}
          <View style={styles.heroBanner}>
{/* Cross / decorative pattern */}
            <View style={styles.heroPattern}>
              {/* Subtle vertical line */}
              <View style={styles.patternLineV} />
              {/* Subtle horizontal line */}
              <View style={styles.patternLineH} />
              {/* Corner accents */}
              <View style={[styles.cornerAccent, styles.cornerTL]} />
              <View style={[styles.cornerAccent, styles.cornerBR]} />
            </View>

            {/* Wordmark */}
            <View style={styles.brandmarkRow}>
              <View style={styles.brandmarkDivider} />
              <Text style={styles.brandmarkText}>WORSHIP TEAM</Text>
              <View style={styles.brandmarkDivider} />
            </View>

            {/* Close button */}
            <TouchableOpacity style={styles.closeBtn} onPress={handleClose} activeOpacity={0.7}>
              <Ionicons name="close" size={18} color={c.text} />
            </TouchableOpacity>
          </View>

          {/* ── Avatar overlap ── */}
          <View style={styles.avatarOverlapContainer}>
            <View style={styles.avatarRingOuter}>
              <View style={styles.avatarRingInner}>
              {profile?.avatarUrl ? (
                <Image source={{ uri: profile.avatarUrl }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Ionicons name="person" size={42} color={c.textMuted} />
                </View>
              )}
</View>
            </View>

            {isActiveUser && (
              <View style={styles.activePill}>
                <View style={styles.activePillDot} />
                <Text style={styles.activePillText}>Active</Text>
              </View>
            )}
          </View>

          {/* ── Name ── */}
          <View style={styles.nameRow}>
            <Text style={styles.nickname}>{profile?.nickname || 'Unknown'}</Text>
            {isPrivate && (
              <View style={styles.privateBadge}>
                <Ionicons name="lock-closed" size={10} color={c.textMuted} />
                <Text style={styles.privateBadgeText}>Private</Text>
              </View>
            )}
          </View>

          {/* Thin rule below name */}
          <View style={styles.nameDivider}>
            <View style={styles.nameDividerLine} />
            <View style={styles.nameDividerDiamond} />
            <View style={styles.nameDividerLine} />
          </View>

          {isPrivate ? (
            /* ── PRIVATE ── */
            <View style={styles.privateBlock}>
<View style={styles.privateLockCircle}>
              <Ionicons name="lock-closed-outline" size={28} color={c.textSub} />
</View>
              <Text style={styles.privateTitle}>Profile is Private</Text>
              <Text style={styles.privateSubtitle}>
                Only the member's name and photo are visible to others.
              </Text>
            </View>
          ) : (
            /* ── PUBLIC ── */
            <>
                            {displayBio ? (
                <View style={styles.bioBlock}>
<Text style={styles.bioLabel}>About</Text>
                  <Text style={styles.bioText}>{displayBio}</Text>
                </View>
              ) : null}

                            {roles.length > 0 && (
                <View style={styles.section}>
<View style={styles.sectionHeader}>
                    <View style={styles.sectionAccentBar} />
                  <Text style={styles.sectionLabel}>Ministry Roles</Text>
</View>
                  <View style={styles.rolesWrap}>
                    {roles.map(role => (
                      <View key={role} style={styles.roleChip}>
                        <Ionicons
                          name={(ROLE_ICONS[role] as any) || 'musical-note'}
                          size={12}
                          color={c.text}
                        />
                        <Text style={styles.roleChipText}>{role}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </>
          )}

          {/* ── Message button ── */}
          {onMessage && (
<View style={styles.actionContainer}>
            <TouchableOpacity
              style={styles.messageBtn}
              onPress={() => {
                handleClose()
                onMessage(targetUserId!)
              }}
activeOpacity={0.85}
            >
              <Ionicons name="chatbubble-outline" size={16} color={c.accentText} />
              <Text style={styles.messageBtnText}>Send Message</Text>
            </TouchableOpacity>
</View>
          )}

          <View style={{ height: 36 }} />
        </ScrollView>
      </Animated.View>
    </Modal>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: c.accent,
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: c.surfaceAlt,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: height * 0.88,
    overflow: 'hidden',
// Subtle top shadow
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 16,
  },
  scrollContent: {
    paddingBottom: 0,
  },
  pullBarWrapper: {
    paddingTop: 10,
    paddingBottom: 2,
    alignItems: 'center',
  },
  pullBar: {
    width: 36,
    height: 3,
    borderRadius: 2,
    backgroundColor: c.border,
      },

  // ── Hero Banner ──
  heroBanner: {
    height: 116,
    backgroundColor: c.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    overflow: 'hidden',
justifyContent: 'flex-end',
    paddingBottom: 14,
    position: 'relative',
  },
  heroPattern: {
    ...StyleSheet.absoluteFill,
  },
  patternLineV: {
    position: 'absolute',
    left: '50%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: c.accent,
  },
  patternLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: 1,
    backgroundColor: c.accent,
  },
  cornerAccent: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderColor: c.accent,
  },
  cornerTL: {
    top: 12,
    left: 14,
    borderTopWidth: 1.5,
    borderLeftWidth: 1.5,
  },
  cornerBR: {
    bottom: 12,
    right: 14,
    borderBottomWidth: 1.5,
    borderRightWidth: 1.5,
  },
  brandmarkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 40,
  },
  brandmarkDivider: {
    flex: 1,
    height: 1,
    backgroundColor: c.textMuted,
  },
  brandmarkText: {
    fontSize: 10,
    fontWeight: '700',
    color: c.textMuted,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
  },
  closeBtn: {
    position: 'absolute',
    top: 12,
    right: 14,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Avatar ──
  avatarOverlapContainer: {
    alignItems: 'center',
    marginTop: -48,
    marginBottom: 10,
  },
  avatarRingOuter: {
    padding: 4,
    borderRadius: 64,
    backgroundColor: c.surfaceAlt,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14,
    shadowRadius: 10,
    elevation: 6,
  },
  avatarRingInner: {
    padding: 3,
    borderRadius: 58,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  avatar: {
    width: 90,
    height: 90,
    borderRadius: 45,
  },
  avatarFallback: {
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.accent,
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 4,
    marginTop: 10,
    gap: 5,
  },
  activePillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.surface,
  },
  activePillText: {
    fontSize: 11,
    fontWeight: '600',
    color: c.accentText,
letterSpacing: 0.5,
  },

  // ── Name ──
  nameRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
        paddingHorizontal: 24,
marginBottom: 10,
  },
  nickname: {
    fontSize: 24,
    fontWeight: '700',
    color: c.text,
letterSpacing: -0.3,
    textAlign: 'center',
  },
  privateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.surfaceMuted,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
borderWidth: 1,
    borderColor: c.border,
  },
  privateBadgeText: {
    fontSize: 10,
    color: c.textMuted,
    fontWeight: '600',
  letterSpacing: 0.5,
  },

  // Ornamental divider
  nameDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 40,
    marginBottom: 16,
    gap: 8,
  },
  nameDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: c.border,
  },
  nameDividerDiamond: {
    width: 6,
    height: 6,
    backgroundColor: c.textMuted,
    transform: [{ rotate: '45deg' }],
  },

  // ── Bio ──
  bioBlock: {
    marginHorizontal: 24,
        marginBottom: 8,
    backgroundColor: c.surfaceAlt,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: c.border,
  },
  bioLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: c.textMuted,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 7,
    textAlign: 'center',
  },
  bioText: {
    fontSize: 14,
    color: c.textSub,
    lineHeight: 22,
    textAlign: 'center',
fontStyle: 'italic',
  },

  // ── Roles ──
  section: {
    marginHorizontal: 24,
    marginTop: 16,
  },
sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionAccentBar: {
    width: 3,
    height: 14,
    backgroundColor: c.accent,
    borderRadius: 2,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textSub,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
      },
  rolesWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  roleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.surface,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  roleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
letterSpacing: 0.2,
  },

  // ── Private State ──
  privateBlock: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 32,
    gap: 12,
  },
  privateLockCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  privateTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.textSub,
letterSpacing: 0.2,
  },
  privateSubtitle: {
    fontSize: 13,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },

  // ── Action ──
  actionContainer: {
    paddingHorizontal: 24,
    marginTop: 24,
  },
  messageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: c.accent,
        paddingVertical: 15,
    borderRadius: 10,
    // Subtle shadow
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 4,
  },
  messageBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: c.accentText,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
})
