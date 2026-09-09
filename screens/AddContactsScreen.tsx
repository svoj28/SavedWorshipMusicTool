import React, { useEffect, useState, useRef , useMemo} from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Share,
  Image,
  Modal,
Animated,
  RefreshControl,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import { CameraView, Camera, BarcodeScanningResult } from '../components/ScannerCamera'
import { getCurrentUser } from '../lib/auth'
import {
addContact,
getContactsByUserId,
deleteContact,
getUserProfileByShortId,
updateContact,
  getUserProfileByUserId,
  getContactsByRecipientId,
  getContactByUserIdAndContactUserId,
  query,
} from '../db/queries'
import { Contact } from '../db/models'
import { generateShortId } from '../lib/shortId'
import {
notifyContactRequest,
notifyContactAccepted,
notifyContactRejected,
} from '../lib/notifications'
import { onDataRefresh, onTableChange } from '../lib/sync'
import { usePullToRefresh } from '../lib/usePullToRefresh'

type TabType = 'share' | 'add' | 'contacts'

interface AddContactFormData {
  recipientId: string
}

// ─── Decorative ornament ─────────────────────────────────────────────────────
function Ornament({ style }: { style?: object }) {
  const { colors: c } = useAppTheme()
  const ornamentStyles = useMemo(() => makeOrnamentStyles(c), [c])

  return (
    <View style={[ornamentStyles.row, style]}>
      <View style={ornamentStyles.line} />
      <View style={ornamentStyles.diamond} />
      <View style={ornamentStyles.line} />
    </View>
  )
}

const makeOrnamentStyles = (c: AppColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  line: { flex: 1, height: 1, backgroundColor: c.border },
  diamond: {
    width: 6,
    height: 6,
    backgroundColor: c.textMuted,
    transform: [{ rotate: '45deg' }],
  },
})

// ─── Main Screen ─────────────────────────────────────────────────────────────
export default function AddContactsScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [user, setUser] = useState<any>(null)
  const [activeTab, setActiveTab] = useState<TabType>('share')
  const [loading, setLoading] = useState(true)
  const [contacts, setContacts] = useState<Contact[]>([])
const [userProfiles, setUserProfiles] = useState<Record<string, any>>({})
  const [formData, setFormData] = useState<AddContactFormData>({ recipientId: '' })
  const [addingContact, setAddingContact] = useState(false)
const [inputFocused, setInputFocused] = useState(false)

    const [scannerVisible, setScannerVisible] = useState(false)
  const [hasPermission, setHasPermission] = useState<boolean | null>(null)
  const [scanned, setScanned] = useState(false)
  const hasLoadedOnceRef = useRef(false)

const fadeAnim = useRef(new Animated.Value(0)).current
  const slideAnim = useRef(new Animated.Value(8)).current

  useEffect(() => { void loadUserAndContacts() }, [])

  useEffect(() => {
    fadeAnim.setValue(0)
    slideAnim.setValue(8)
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 280, useNativeDriver: true }),
    ]).start()
  }, [activeTab])
  
  useEffect(() => {
    const unsubRefresh = onDataRefresh((table) => {
      if (table === 'contacts') {
        void loadUserAndContacts({ silent: true })
      }
    })

    const unsubContacts = onTableChange('contacts', () => void loadUserAndContacts({ silent: true }))
    const unsubProfiles = onTableChange('user_profiles', () => void loadUserAndContacts({ silent: true }))

    return () => {
      unsubRefresh()
      unsubContacts()
      unsubProfiles()
    }
  }, [])

  const loadUserAndContacts = async ({ silent = false }: { silent?: boolean } = {}) => {
  try {
    if (!silent) setLoading(true)
    const currentUser = await getCurrentUser()
    if (currentUser) {
      setUser(currentUser)
      const allRows = await query('SELECT * FROM contacts', [])
      console.log('=== ALL CONTACTS IN DB:', JSON.stringify(allRows))

      const incoming = await getContactsByRecipientId(currentUser.id)
      const outgoing = await getContactsByUserId(currentUser.id)

      // ADD THESE to see what's coming back
      console.log('=== CURRENT USER ID:', currentUser.id)
      console.log('=== INCOMING (requests TO me):', JSON.stringify(incoming))
      console.log('=== OUTGOING (requests FROM me):', JSON.stringify(outgoing))

      const pairKey = (a: string, b: string) => [a, b].sort().join('::')
      const groups = new Map<string, Contact[]>()
      for (const contact of [...incoming, ...outgoing]) {
        const key = pairKey(contact.userId, contact.contactUserId)
        const list = groups.get(key) || []
        list.push(contact)
        groups.set(key, list)
      }

      const allContacts = Array.from(groups.values()).map(group => {
        const blocked = group.find(c => c.status === 'blocked')
        if (blocked) return blocked
        const accepted = group.find(c => c.status === 'accepted')
        if (accepted) return accepted
        return group.find(c => c.status === 'pending') || group[0]
      })

      setContacts(allContacts)

      const profiles: Record<string, any> = {}
      for (const contact of allContacts) {
        const otherPersonId = contact.userId === currentUser.id
          ? contact.contactUserId
          : contact.userId
        try {
          const profile = await getUserProfileByUserId(otherPersonId)
          if (profile) profiles[otherPersonId] = profile
        } catch (err) {
          console.warn(`Failed to load profile for ${otherPersonId}:`, err)
        }
      }
      setUserProfiles(profiles)
    }
  } catch (err) {
    console.error('Error loading user:', err)
    Alert.alert('Error', 'Failed to load member data.')
  } finally {
    hasLoadedOnceRef.current = true
    if (!silent) setLoading(false)
  }
}

  const { refreshing, onRefresh } = usePullToRefresh(() => loadUserAndContacts({ silent: true }))

  const handleAddContact = async (recipientId?: string) => {
  let idToAdd = (recipientId ?? formData.recipientId).trim()
  if (!idToAdd) { Alert.alert('Required', 'Please enter a Recipient ID.'); return }
  if (idToAdd === user?.id) { Alert.alert('Notice', 'You cannot add yourself.'); return }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(idToAdd)) {
    const profile = await getUserProfileByShortId(idToAdd)
    if (!profile) { Alert.alert('Not Found', 'No member found with that Recipient ID.'); return }
    idToAdd = profile.userId
  }

  try {
    setAddingContact(true)
    const existing = contacts.find(c =>
  (c.userId === user.id && c.contactUserId === idToAdd) ||
  (c.userId === idToAdd && c.contactUserId === user.id)
)
    if (existing) { Alert.alert('Notice', 'This member is already in your contacts.'); return }

    // YOU are userId (sender), THEY are contactUserId (recipient who sees the request)
    const newContact = await addContact({
  userId: user.id,
  contactUserId: idToAdd,
  status: 'pending',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  synced: false,
})
console.log('=== SAVED CONTACT:', JSON.stringify(newContact))

    await notifyContactRequest(idToAdd, user?.displayName || 'A team member', user.id)
    setFormData({ recipientId: '' })
    await loadUserAndContacts({ silent: true })
    Alert.alert('Request Sent', 'Your connection request has been delivered.')
  } catch (err) {
    console.error('Error adding contact:', err)
    Alert.alert('Error', 'Failed to send contact request.')
  } finally {
    setAddingContact(false)
  }
}

  const handleDeleteContact = async (contactId: string) => {
    Alert.alert('Remove Member', 'Are you sure you want to remove this contact?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            const current = contacts.find(c => c.id === contactId)
            if (!current) return
            const otherUserId = current.userId === user.id ? current.contactUserId : current.userId
            const ownRow = await getContactByUserIdAndContactUserId(user.id, otherUserId)
            if (ownRow) {
              await updateContact(ownRow.id, { status: 'blocked', updatedAt: Date.now() })
            } else {
              await addContact({
                userId: user.id,
                contactUserId: otherUserId,
                status: 'blocked',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                synced: false,
              })
            }
            await loadUserAndContacts({ silent: true })
                      } catch {
            Alert.alert('Error', 'Failed to remove contact.')
          }
        },
              },
    ])
  }

const handleAcceptContact = async (contact: Contact) => {
  try {
    const otherUserId = contact.userId === user.id ? contact.contactUserId : contact.userId
    const ownRow = await getContactByUserIdAndContactUserId(user.id, otherUserId)
    if (ownRow) {
      await updateContact(ownRow.id, { status: 'accepted', updatedAt: Date.now() })
    } else {
      await addContact({
        userId: user.id,
        contactUserId: otherUserId,
        status: 'accepted',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        synced: false,
      })
    }

    await loadUserAndContacts({ silent: true })

    await notifyContactAccepted(contact.userId, user?.displayName || 'A team member')
  } catch {
    Alert.alert('Error', 'Failed to accept request.')
  }
}

const handleRejectContact = async (contact: Contact) => {
  Alert.alert('Decline Request', 'Are you sure you want to decline this request?', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Decline',
      style: 'destructive',
      onPress: async () => {
        try {
          const otherUserId = contact.userId === user.id ? contact.contactUserId : contact.userId
          const ownRow = await getContactByUserIdAndContactUserId(user.id, otherUserId)
          if (ownRow) {
            await updateContact(ownRow.id, { status: 'blocked', updatedAt: Date.now() })
          } else {
            await addContact({
              userId: user.id,
              contactUserId: otherUserId,
              status: 'blocked',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              synced: false,
            })
          }
          await loadUserAndContacts({ silent: true })
          await notifyContactRejected(contact.userId, user?.displayName || 'A team member')
        } catch {
          Alert.alert('Error', 'Failed to decline request.')
        }
      },
    },
  ])
}

  const handleShareQRCode = async () => {
    try {
      await Share.share({
        message: `Connect with me on the Worship Team app.\nMy Recipient ID: ${user?.id}`,
        title: 'Share My Recipient ID',
      })
    } catch (err) {
      console.error('Error sharing:', err)
    }
  }

  const handleScanQRCode = async () => {
    const { status } = await Camera.requestCameraPermissionsAsync()
    if (status === 'granted') {
      setHasPermission(true)
      setScanned(false)
      setScannerVisible(true)
    } else {
            Alert.alert('Permission Required',         'Please enable camera access to scan QR codes.',         [{ text: 'OK' }]      )
    }
  }

  const handleBarCodeScanned = ({ data }: BarcodeScanningResult) => {
    if (scanned) return
    setScanned(true)
    setScannerVisible(false)
    Alert.alert(
      'Member Found',
      `ID: ${data.substring(0, 20)}…\n\nWould you like to send a connection request?`,
      [
        {           text: 'Cancel',           onPress: () => setScanned(false),           style: 'cancel'         },
        {           text: 'Connect',           onPress: () => handleAddContact(data)         },
      ]
    )
  }

  const closeScanner = () => {     setScannerVisible(false); setScanned(false) }

  const pendingContacts = contacts.filter(c => c.status === 'pending')
  const acceptedContacts = contacts.filter(c => c.status === 'accepted')
  const rejectedContacts = contacts.filter(c => c.status === 'blocked')

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={c.text} />
<Text style={styles.loadingText}>Please wait…</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>

      {/* ── QR Scanner Modal ─────────────────────────────────── */}
      <Modal         visible={scannerVisible}         animationType="fade"         onRequestClose={closeScanner}      >
        <View style={styles.scannerContainer}>
          <View style={styles.scannerHeader}>
            <TouchableOpacity onPress={closeScanner} style={styles.closeButton}>
              <Ionicons name="close" size={20} color={c.accentText} />
            </TouchableOpacity>
            <Text style={styles.scannerTitle}>Scan Member Code</Text>
            <View style={{ width: 44 }} />
          </View>

          {hasPermission && (
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
            />
          )}

          <View style={styles.scannerOverlay}>
            <View style={styles.scannerFrame}>
                            <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
          </View>

          <View style={styles.scannerFooter}>
<Ornament style={{ marginBottom: 12 }} />
            <Text style={styles.scannerHint}>Align the code within the frame            </Text>
            {scanned && (
              <TouchableOpacity                 style={styles.rescanButton}                 onPress={() => setScanned(false)}              >
                <Text style={styles.rescanText}>Scan Again</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>

      {/* ── Header ───────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.headerSub}>Worship Team</Text>
        <Text style={styles.headerTitle}>Members</Text>
        <Ornament style={styles.headerOrnament} />
      </View>

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <View style={styles.tabContainer}>
{(['share', 'add', 'contacts'] as TabType[]).map((tab) => (
        <TouchableOpacity
key={tab}
          style={[styles.tab, activeTab === tab && styles.activeTab]}
          onPress={() => setActiveTab(tab)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={
                tab === 'share'
                  ? 'share-social-outline'
                  : tab === 'add'
                  ? 'person-add-outline'
                  : 'people-outline'
              }
              size={16}
              color={activeTab === tab ? c.text : c.iconInactive}
              style={{ marginBottom: 3 }}
            />
          <Text style={[styles.tabText, activeTab === tab && styles.activeTabText]}>
            {tab === 'share' ? 'My Code' : tab === 'add' ? 'Connect' : 'Members'}
          </Text>
{activeTab === tab && <View style={styles.tabUnderline} />}
        </TouchableOpacity>
        ))}
      </View>

      {/* ── Content ──────────────────────────────────────────── */}
      <Animated.ScrollView
style={[styles.scroll, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >

        {/* ═══ SHARE TAB ═══ */}
        {activeTab === 'share' && (
          <View>
            <Text style={styles.sectionTitle}>Share Your Identity</Text>
            <Text style={styles.sectionDesc}>
              Allow fellow team members to find you by sharing your personal QR code or Recipient ID.
            </Text>

            <Ornament style={styles.ornamentSpacing} />

            {user?.id && (
              <View style={styles.qrCard}>
                <View style={styles.qrInner}>
                  <Image
                    source={{
uri: `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(user.id)}&color=1a1a1a&bgcolor=fafafa`,
}}
                    style={styles.qrImage}
                  />
                </View>
<Text style={styles.qrCaption}>Your personal QR code</Text>
              </View>
            )}

            <View style={styles.idCard}>
              <Text style={styles.idCardLabel}>Recipient ID</Text>
<View style={styles.idCardDivider} />
              <Text style={styles.idCardValue}>{generateShortId(user?.id)}</Text>
              <Text style={styles.idCardFull}>{user?.id?.substring(0, 18)}…</Text>
            </View>

            <TouchableOpacity               style={styles.primaryBtn}               onPress={handleShareQRCode} activeOpacity={0.85}            >
              <Ionicons name="share-social-outline" size={17} color={c.accentText} style={{ marginRight: 8 }} />
              <Text style={styles.primaryBtnText}>Share My ID</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ═══ ADD TAB ═══ */}
        {activeTab === 'add' && (
          <View>
            <Text style={styles.sectionTitle}>Connect with a Member</Text>
            <Text style={styles.sectionDesc}>
              Enter a fellow team member's Recipient ID or scan their code to send a connection request.
            </Text>

            <Ornament style={styles.ornamentSpacing} />

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Recipient ID</Text>
              <TextInput
                style={[styles.input, inputFocused && styles.inputFocused]}
                placeholder="Enter member's ID"
placeholderTextColor={c.textMuted}
                value={formData.recipientId}
                onChangeText={(text) => setFormData({ recipientId: text })}
onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                editable={!addingContact}
                autoCapitalize="none"
autoCorrect={false}
              />
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, addingContact && styles.disabledBtn]}
              onPress={() => handleAddContact()}
              disabled={addingContact}
activeOpacity={0.85}
            >
              {addingContact ? (
                <ActivityIndicator color={c.accentText} size="small" />
              ) : (
                <>
                  <Ionicons name="person-add-outline" size={17} color={c.accentText} style={{ marginRight: 8 }} />
                  <Text style={styles.primaryBtnText}>Send Request</Text>
                </>
              )}
            </TouchableOpacity>

<View style={styles.orRow}>
              <View style={styles.orLine} />
              <Text style={styles.orText}>or</Text>
              <View style={styles.orLine} />
            </View>

            <TouchableOpacity               style={styles.outlineBtn}               onPress={handleScanQRCode} activeOpacity={0.8}            >
              <Ionicons name="qr-code-outline" size={17} color={c.textSub} style={{ marginRight: 8 }} />
              <Text style={styles.outlineBtnText}>Scan QR Code</Text>
            </TouchableOpacity>
          </View>
        )}

{/* ═══ CONTACTS TAB ═══ */}
{activeTab === 'contacts' && (
  <View>
    <Text style={styles.sectionTitle}>Team Members</Text>
    <Text style={styles.sectionDesc}>
      Your connected worship team members and pending requests.
    </Text>

    <Ornament style={styles.ornamentSpacing} />

    {contacts.length === 0 ? (
      <View style={styles.emptyState}>
        <View style={styles.emptyIconRing}>
          <Ionicons name="people-outline" size={32} color={c.iconInactive} />
        </View>
        <Text style={styles.emptyTitle}>No Members Yet</Text>
        <Text style={styles.emptyDesc}>
          Connect with your worship team by sharing or scanning member codes.
        </Text>
      </View>
    ) : (
      <>
        {pendingContacts.length > 0 && (
          <View style={styles.group}>
            <Text style={styles.groupLabel}>Awaiting Response</Text>
            {pendingContacts.map((c) => (
              <MemberCard
                key={c.id}
                contact={c}
                isIncoming={c.userId !== user?.id}
                nickname={userProfiles[c.userId === user?.id ? c.contactUserId : c.userId]?.nickname}
                onDelete={handleDeleteContact}
                onAccept={handleAcceptContact}
                onReject={handleRejectContact}
              />
            ))}
          </View>
        )}
        {acceptedContacts.length > 0 && (
          <View style={styles.group}>
            <Text style={styles.groupLabel}>Connected</Text>
            {acceptedContacts.map((c) => (
              <MemberCard
                key={c.id}
                contact={c}
                isIncoming={c.userId !== user?.id}
                nickname={userProfiles[c.userId === user?.id ? c.contactUserId : c.userId]?.nickname}
                onDelete={handleDeleteContact}
                onAccept={handleAcceptContact}
                onReject={handleRejectContact}
              />
            ))}
          </View>
        )}
        {rejectedContacts.length > 0 && (
          <View style={styles.group}>
            <Text style={styles.groupLabel}>Declined</Text>
            {rejectedContacts.map((c) => (
              <MemberCard
                key={c.id}
                contact={c}
                isIncoming={c.userId !== user?.id}
                nickname={userProfiles[c.userId === user?.id ? c.contactUserId : c.userId]?.nickname}
                onDelete={handleDeleteContact}
                onAccept={handleAcceptContact}
                onReject={handleRejectContact}
              />
            ))}
          </View>
        )}
      </>
    )}
  </View>
)}

      </Animated.ScrollView>
    </View>
  )
}

// ─── Member Card ─────────────────────────────────────────────────────────────

function MemberCard({
  contact,
  nickname,
  isIncoming = false,
  onDelete,
  onAccept,
  onReject,
}: {
  contact: Contact
  nickname?: string
  isIncoming: boolean
  onDelete: (id: string) => void
  onAccept: (c: Contact) => void
  onReject: (c: Contact) => void
}) {
  const { colors: c } = useAppTheme()
  const cardStyles = useMemo(() => makeCardStyles(c), [c])

  const isPending = contact.status === 'pending'
  const isAccepted = contact.status === 'accepted'
  const isRejected = contact.status === 'blocked'

  const displayName = nickname || 'Unknown Member'
  const initials = displayName
    .split(' ')
    .map((w: string) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <View
      style={[
        cardStyles.card,
        isAccepted && cardStyles.cardAccepted,
        isRejected && cardStyles.cardMuted,
      ]}
    >
      <View style={[cardStyles.avatar, isRejected && cardStyles.avatarMuted]}>
        <Text style={[cardStyles.initials, isRejected && cardStyles.initialsMuted]}>
          {initials}
        </Text>
      </View>

      <View style={cardStyles.info}>
        <Text
          style={[cardStyles.name, isRejected && cardStyles.nameMuted]}
          numberOfLines={1}
        >
          {displayName}
        </Text>
        <Text style={cardStyles.shortId}>
          {contact.userId !== contact.contactUserId
            ? generateShortId(isIncoming ? contact.userId : contact.contactUserId)
            : ''}
        </Text>

        <View style={[
          cardStyles.pill,
          isAccepted && cardStyles.pillAccepted,
          isRejected && cardStyles.pillMuted,
        ]}>
          <Text style={[
            cardStyles.pillText,
            isAccepted && cardStyles.pillTextAccepted,
            isRejected && cardStyles.pillTextMuted,
          ]}>
            {isPending
              ? (isIncoming ? 'Incoming' : 'Sent')
              : isAccepted ? 'Connected' : 'Declined'}
          </Text>
        </View>
      </View>

      <View style={cardStyles.actions}>
        {/* Only the recipient sees accept/decline — not the sender */}
        {isPending && isIncoming && (
          <>
            <TouchableOpacity
              style={cardStyles.acceptBtn}
              onPress={() => onAccept(contact)}
              activeOpacity={0.8}
            >
              <Ionicons name="checkmark" size={15} color={c.accentText} />
            </TouchableOpacity>
            <TouchableOpacity
              style={cardStyles.declineBtn}
              onPress={() => onReject(contact)}
              activeOpacity={0.8}
            >
              <Ionicons name="close" size={15} color={c.textSub} />
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity
          style={cardStyles.removeBtn}
          onPress={() => onDelete(contact.id)}
          activeOpacity={0.8}
        >
          <Ionicons name="trash-outline" size={15} color={c.iconInactive} />
        </TouchableOpacity>
      </View>
    </View>
  )
}

// ─── Card Styles ─────────────────────────────────────────────────────────────

const makeCardStyles = (c: AppColors) => StyleSheet.create({
  card: {
  flexDirection: 'row',
  alignItems: 'center',
  backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  borderRadius: 8,
  padding: 12,
    marginBottom: 8,
    gap: 12,
    shadowColor: c.shadow,
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
},
cardAccepted: {
  borderColor: c.border,
},
  cardMuted: {
    borderColor: c.hairline,
    backgroundColor: c.surfaceAlt,
  },
avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarMuted: {
    backgroundColor: c.surfaceMuted,
  },
  initials: {
    color: c.accentText,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  initialsMuted: {
    color: c.textMuted,
  },
  info: {
    flex: 1,
    gap: 3,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: c.text,
    letterSpacing: 0.2,
  },
  nameMuted: {
    color: c.iconInactive,
  },
  shortId: {
    fontSize: 11,
    color: c.textMuted,
    fontFamily: 'monospace',
    letterSpacing: 0.3,
  },
  pill: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
backgroundColor: c.surfaceAlt,
  },
  pillAccepted: {
    borderColor: c.accent,
    backgroundColor: c.accent,
  },
  pillMuted: {
    borderColor: c.hairline,
    backgroundColor: 'transparent',
  },
  pillText: {
    fontSize: 10,
    fontWeight: '600',
    color: c.textMuted,
    letterSpacing: 0.3,
  },
  pillTextAccepted: {
    color: c.accentText,
  },
  pillTextMuted: {
    color: c.iconInactive,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
gap: 6,
  },
  acceptBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.accent,
    justifyContent: 'center',
        alignItems: 'center',
},
  declineBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
  alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  removeBtn: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  })

// ─── Screen Styles ────────────────────────────────────────────────────────────

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: {
    flex: 1,
backgroundColor: c.surfaceAlt,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 13,
    color: c.textMuted,
    fontStyle: 'italic',
    letterSpacing: 0.3,
  },

  // Header
  header: {
    backgroundColor: c.accent,
    paddingTop: 56,
    paddingBottom: 20,
    paddingHorizontal: 24,
    alignItems: 'center',
    },
  headerSub: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 3,
    color: c.textMuted,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '300',
    color: c.accentText,
    letterSpacing: 6,
    textTransform: 'uppercase',
    marginBottom: 14,
  },
  headerOrnament: {
    width: 160,
  },

  // Tabs
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    position: 'relative',
  },
  activeTab: {  },
  tabText: {
    fontSize: 11,
    fontWeight: '500',
    color: c.iconInactive,
letterSpacing: 0.3,
  },
  activeTabText: {
    color: c.text,
    fontWeight: '700',
  },
tabUnderline: {
    position: 'absolute',
    bottom: 0,
    left: 20,
    right: 20,
    height: 2,
    backgroundColor: c.accent,
    borderRadius: 1,
  },
  
  // Scroll
  scroll: { flex: 1 },
  scrollContent: {
    padding: 24,
    paddingBottom: 52,
  },

  // Section Header
  sectionTitle: {
    fontSize: 22,
    fontWeight: '300',
    color: c.text,
letterSpacing: 0.5,
    marginBottom: 8,
  },
  sectionDesc: {
    fontSize: 13,
    color: c.textMuted,
        lineHeight: 20,
letterSpacing: 0.2,
  },
  ornamentSpacing: {
    marginVertical: 20,
  },

  // QR Card
  qrCard: {
alignSelf: 'center',
    alignItems: 'center',
    marginBottom: 24,
    backgroundColor: c.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    padding: 20,
    shadowColor: c.shadow,
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  qrInner: {
    padding: 8,
    backgroundColor: c.surfaceAlt,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: c.hairline,
  },
  qrImage: {
    width: 200,
    height: 200,
  },
  qrCaption: {
    marginTop: 12,
    fontSize: 11,
    color: c.iconInactive,
    letterSpacing: 0.5,
    fontStyle: 'italic',
  },

  // ID Card
  idCard: {
    backgroundColor: c.surface,
    borderRadius: 8,
  borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    marginBottom: 20,
    alignItems: 'center',
    shadowColor: c.shadow,
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  idCardLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 2,
    color: c.textMuted,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  idCardDivider: {
    width: 32,
    height: 1,
    backgroundColor: c.border,
    marginBottom: 10,
  },
  idCardValue: {
    fontSize: 22,
    fontWeight: '700',
    color: c.text,
    letterSpacing: 3,
    fontFamily: 'monospace',
    marginBottom: 6,
  },
  idCardFull: {
    fontSize: 10,
    color: c.iconInactive,
    fontFamily: 'monospace',
  letterSpacing: 0.5,
  },
  
  // Buttons
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accent,
    borderRadius: 6,
    paddingVertical: 14,
    paddingHorizontal: 24,
    marginBottom: 12,
  shadowColor: c.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  primaryBtnText: {
    color: c.accentText,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  disabledBtn: {
    opacity: 0.4,
  },
  outlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surface,
    borderWidth: 1.5,
    borderColor: c.border,
    borderRadius: 6,
    paddingVertical: 13,
    paddingHorizontal: 24,
  },
  outlineBtnText: {
    color: c.textSub,
    fontSize: 13,
    fontWeight: '600',
  letterSpacing: 0.5,
  },
  
  // Or Divider
  orRow: {
flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 16,
  },
  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: c.surfaceMuted,
  },
  orText: {
    fontSize: 12,
    color: c.iconInactive,
    fontStyle: 'italic',
  },

  // Field
  fieldGroup: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.textMuted,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  input: {
borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    backgroundColor: c.surface,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 14,
    color: c.text,
    letterSpacing: 0.3,
    shadowColor: c.shadow,
    shadowOpacity: 0.03,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  inputFocused: {
    borderColor: c.accent,
    borderWidth: 1.5,
  },

  // Groups
  group: {
    marginBottom: 8,
  },
  groupLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    color: c.iconInactive,
    textTransform: 'uppercase',
    marginBottom: 10,
    marginTop: 8,
  },
  
  // Empty
  emptyState: {
        alignItems: 'center',
paddingVertical: 56,
    gap: 12,
  },
  emptyIconRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1.5,
    borderColor: c.border,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    backgroundColor: c.surfaceAlt,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: c.textMuted,
    letterSpacing: 0.3,
  },
  emptyDesc: {
    fontSize: 13,
    color: c.iconInactive,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 240,
    fontStyle: 'italic',
  },
  
  // Scanner
  scannerContainer: {
    flex: 1,
backgroundColor: c.accent,
  },
  scannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 16,
    zIndex: 10,
  },
  closeButton: {
    width: 44,
    height: 44,
alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: c.accent,
  },
  scannerTitle: {
    color: c.iconInactive,
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 1,
  },
  camera: {
    flex: 1,
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
},
  scannerFrame: {
    width: 220,
    height: 220,
    position: 'relative',
    marginTop: 60,
  },
  corner: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: c.hairline,
    borderWidth: 2,
  },
  cornerTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 3 },
  cornerTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 3 },
  cornerBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 3 },
  cornerBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 3 },
  scannerFooter: {
    paddingBottom: 52,
    paddingHorizontal: 40,
    alignItems: 'center',
  gap: 14,
  },
  scannerHint: {
    color: c.textSub,
    fontSize: 12,
    letterSpacing: 0.5,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  rescanButton: {
    borderWidth: 1,
    borderColor: c.accent,
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 28,
  },
  rescanText: {
    color: c.textMuted,
    fontSize: 12,
        fontWeight: '500',
  letterSpacing: 0.5,
  },
})
