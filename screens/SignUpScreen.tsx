import React, { useState, useRef, useEffect , useMemo} from 'react'
import {
  View,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Text,
  ActivityIndicator,
  Alert,
Animated,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Dimensions,
  Image,
  Modal
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Svg, { Circle, Line } from 'react-native-svg'
import Ionicons from '@expo/vector-icons/Ionicons'
import { signUpWithEmail } from '../lib/auth'

const { width, height } = Dimensions.get('window')

interface Props {
  onSignUpSuccess: () => void
  onNavigateToSignIn: () => void
}

interface FieldConfig {
  key: string
  label: string
  placeholder: string
  icon: keyof typeof Ionicons.glyphMap
  secure?: boolean
  keyboard?: 'default' | 'email-address'
  autoCapitalize?: 'none' | 'words'
}

const FIELDS: FieldConfig[] = [
  { key: 'displayName', label: 'DISPLAY NAME', placeholder: 'Your name', icon: 'person-outline', autoCapitalize: 'words' },
  { key: 'email', label: 'EMAIL', placeholder: 'your@email.com', icon: 'mail-outline', keyboard: 'email-address', autoCapitalize: 'none' },
  { key: 'password', label: 'PASSWORD', placeholder: '•••••••• (min. 6 chars)', icon: 'lock-closed-outline', secure: true, autoCapitalize: 'none' },
  { key: 'confirmPassword', label: 'CONFIRM PASSWORD', placeholder: '••••••••', icon: 'shield-checkmark-outline', secure: true, autoCapitalize: 'none' },
]
const guideSections = [
  {
    title: 'Getting Started',
    items: [
      'Sign in or create an account to unlock sync, private notes, chat, and profile settings.',
      'Your drawer shows your profile, recipient ID, and QR code for sharing your account with other users.',
      'Use the tabs at the bottom to move between Chords, Notes, Manage, and Chat.',
    ],
  },
  {
    title: 'Chord Lists',
    items: [
      'Browse shared chord lists from the Chords tab.',
      'Open a song to view lyrics and chords together, or use transpose tools to shift the key.',
      'If you have permissions, you can add or edit songs from the chord list flow.',
    ],
  },
  {
    title: 'Notes and Private Lists',
    items: [
      'Use the Notes tab for personal chord lists that stay private to your account.',
      'Create, open, and manage note entries without exposing them to other users.',
    ],
  },
  {
    title: 'Tools',
    items: [
      'Metronome gives you BPM control and tap-tempo support for practice and rehearsal.',
      'Manual Transpose helps you shift chords quickly without editing the original song.',
      'Audio Tools groups extra playback and utility features in one place.',
    ],
  },
  {
    title: 'Chat and Management',
    items: [
      'Chat is for real-time messages and connection with other users.',
      'Manage is where app-level settings, administration, or workflow controls live.',
      'Edit Profile from the drawer to update your display name, bio, avatar, and instruments.',
    ],
  },
  {
    title: 'System Information',
    items: [
      'The app uses an offline-first local database so your content remains available even without network.',
      'Supabase handles authentication, cloud sync, and realtime updates when you are signed in.',
      'Changes are synchronized in the background so local edits reach the server and other devices.',
    ],
  },
  {
    title: 'Tips',
    items: [
      'If something does not update immediately, reopen the screen or wait for sync to complete.',
      'Use the drawer QR code and recipient ID when connecting with other members.',
      'Keep your profile information current so sharing and collaboration stay consistent.',
    ],
  },
]

const GUIDE_HEIGHT = Dimensions.get('window').height * 0.88
function Background() {
  const { colors: c } = useAppTheme()

  return (
    <Svg
      width={width}
      height={height}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      {/* Top-left arc */}
      <Circle cx={-30} cy={-30} r={170} fill="none" stroke={c.iconInactive} strokeWidth={1} />
      <Circle cx={-30} cy={-30} r={115} fill="none" stroke={c.accentText} strokeWidth={1} />
      <Circle cx={-30} cy={-30} r={62} fill={c.surfaceMuted} opacity={0.6} />

      {/* Bottom-right arc */}
      <Circle cx={width + 30} cy={height + 30} r={200} fill="none" stroke={c.iconInactive} strokeWidth={1} />
      <Circle cx={width + 30} cy={height + 30} r={140} fill="none" stroke={c.accentText} strokeWidth={1} />
      <Circle cx={width + 30} cy={height + 30} r={78} fill={c.surfaceAlt} opacity={0.65} />

      {/* Staff lines — top right */}
      {[0, 1, 2, 3, 4].map(i => (
        <Line
          key={i}
          x1={width * 0.45}
          y1={60 + i * 12}
          x2={width}
          y2={60 + i * 12}
          stroke={c.iconInactive}
          strokeWidth={1}
        />
      ))}

      {/* Music note — top right */}
      <Circle cx={width * 0.45 - 10} cy={84} r={7} fill={c.border} />
      <Line
        x1={width * 0.45 - 3}
        y1={84}
        x2={width * 0.45 - 3}
        y2={45}
        stroke={c.iconInactive}
        strokeWidth={1.5}
      />

      {/* Dot grid — bottom left */}
      {[...Array(4)].map((_, row) =>
        [...Array(4)].map((_, col) => (
          <Circle
            key={`${row}-${col}`}
            cx={24 + col * 18}
            cy={height - 110 + row * 18}
            r={1.5}
            fill={c.border}
          />
        ))
      )}
    </Svg>
  )
}

export default function SignUpScreen({ onSignUpSuccess, onNavigateToSignIn }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [values, setValues] = useState({ displayName: '', email: '', password: '', confirmPassword: '' })
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
const [focused, setFocused] = useState<string | null>(null)
const [showGuideModal, setShowGuideModal] = useState(false)

  const fadeAnim = useRef(new Animated.Value(0)).current
  const slideAnim = useRef(new Animated.Value(24)).current

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start()
  }, [])

  const handleChange = (key: string, val: string) =>
    setValues(prev => ({ ...prev, [key]: val }))

  const handleSignUp = async () => {
const { displayName, email, password, confirmPassword } = values
    if (!displayName.trim() || !email.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please fill in all fields.')
      return
    }
    if (password !== confirmPassword) {
      Alert.alert('Password Mismatch', 'Your passwords do not match.')
      return
    }
    if (password.length < 6) {
      Alert.alert('Password Too Short', 'Password must be at least 6 characters.')
      return
    }
    setLoading(true)
    const { user, error } = await signUpWithEmail(email, password, displayName)
    setLoading(false)
    if (error)       Alert.alert('Sign Up Failed', error.message)
  }

  const isSecure = (key: string) => {
    if (key === 'password') return !showPassword
    if (key === 'confirmPassword') return !showConfirmPassword
    return false
  }

  const toggleSecure = (key: string) => {
    if (key === 'password') setShowPassword(p => !p)
    if (key === 'confirmPassword') setShowConfirmPassword(p => !p)
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={c.surfaceAlt} />
      <Background />

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>

            {/* Header row */}
            <View style={styles.headerRow}>
          <TouchableOpacity onPress={onNavigateToSignIn} style={styles.backBtn} activeOpacity={0.7}>
            <Ionicons               name="arrow-back"               size={18}               color={c.text}             />
          </TouchableOpacity>
<View style={styles.logoBoxSmall}>
                <Image
                    source={require('../assets/SavedLOGOnobg.png')}
                    style={{ width: 90, height: 90, borderRadius: 6 }}
                    resizeMode="contain"
                  />
              </View>
        </View>

        {/* Heading */}
            <Text style={styles.heading}>Create account</Text>
            <Text style={styles.subheading}>Fill the inputs below</Text>

            {/* Fields */}
            <View style={styles.fieldsCard}>
              {FIELDS.map((field, idx) => (
                <View key={field.key} style={[styles.fieldGroup, idx < FIELDS.length - 1 && styles.fieldBorder]}>
                  <Text style={styles.label}>{field.label}</Text>
                  <View style={[styles.inputRow, focused === field.key && styles.inputRowFocused]}>
                    <Ionicons
                      name={field.icon}
                      size={16}
                      color={focused === field.key ? c.text : c.textMuted}
                      style={styles.icon}
                    />
          <TextInput
            style={[styles.input, field.secure && { flex: 1 }]}
            placeholder={field.placeholder}
            placeholderTextColor={c.textMuted}
                      keyboardType={field.keyboard || 'default'}
                      autoCapitalize={field.autoCapitalize || 'none'}
                      secureTextEntry={field.secure ? isSecure(field.key) : false}
            value={values[field.key as keyof typeof values]}
            onChangeText={val => handleChange(field.key, val)}
                      onFocus={() => setFocused(field.key)}
                      onBlur={() => setFocused(null)}
            editable={!loading}
          />
{field.secure && (
          <TouchableOpacity onPress={() => toggleSecure(field.key)}             style={styles.eyeBtn}          >
            <Ionicons
              name={isSecure(field.key) ? 'eye-outline' : 'eye-off-outline'}
              size={16}
              color={c.textMuted}
            />
          </TouchableOpacity>
)}
                  </View>
                </View>
              ))}
        </View>

<Text style={styles.terms}>
              By signing up, you agree to our Terms of Service and Privacy Policy.
            </Text>

            {/* Sign Up */}
        <TouchableOpacity
          style={[styles.primaryBtn, loading && styles.disabledBtn]}
          onPress={handleSignUp}
          disabled={loading}
activeOpacity={0.8}
        >
          {loading
? <ActivityIndicator color={c.accentText} />
: <Text style={styles.primaryBtnText}>Create Account</Text>
}
        </TouchableOpacity>

        <TouchableOpacity onPress={onNavigateToSignIn} style={styles.bottomLink}>
          <Text style={styles.bottomLinkText}>
Already have an account?{'  '}<Text style={styles.bottomLinkBold}>Sign In</Text>
</Text>
        </TouchableOpacity>
      
          </Animated.View>
    </ScrollView>
</KeyboardAvoidingView>

{/* Floating Guide Button */}
<TouchableOpacity
  style={styles.guideFloatBtn}
  onPress={() => setShowGuideModal(true)}
  activeOpacity={0.75}
>
  <Ionicons name="information-circle-outline" size={22} color={c.accentText} />
</TouchableOpacity>

{/* ── App Guide Modal ─────────────────────────────────────── */}
<Modal
  visible={showGuideModal}
  animationType="fade"
  transparent
  onRequestClose={() => setShowGuideModal(false)}
>
  <View style={styles.guideOverlay}>
    <TouchableOpacity
      style={StyleSheet.absoluteFill}
      onPress={() => setShowGuideModal(false)}
      activeOpacity={1}
    />
    <View style={styles.guideContent}>
      <View style={styles.guideHeader}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.guideEyebrow}>App Guide</Text>
          <Text style={styles.guideTitle}>How Saved Worship Works</Text>
        </View>
        <TouchableOpacity onPress={() => setShowGuideModal(false)} style={{ padding: 4 }}>
          <Ionicons name="close" size={24} color={c.textSub} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flexShrink: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.guideBody}
      >
        <Text style={styles.guideIntro}>
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
            Your content works offline first, then syncs when the connection is available.
          </Text>
        </View>
      </ScrollView>
    </View>
  </View>
</Modal>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.surfaceAlt },
  scrollContent: { flexGrow: 1, paddingVertical: 56 },
  content: { paddingHorizontal: 28 },

  // ── Guide Modal ────────────────────────────────────────────
guideFloatBtn: {
  alignSelf: 'flex-end',
  width: 36,
  height: 36,
  borderRadius: 18,
  backgroundColor: c.surfaceMuted,
  justifyContent: 'center',
  alignItems: 'center',
  marginBottom: 16,
},
guideOverlay: {
  flex: 1,
  justifyContent: 'center',
  alignItems: 'center',
  backgroundColor: c.accent,
  paddingHorizontal: 16,
},
guideContent: {
  width: '100%',
  maxWidth: 420,
  height: GUIDE_HEIGHT,
  backgroundColor: c.surface,
  borderRadius: 18,
  overflow: 'hidden',
  elevation: 10,
  shadowColor: c.shadow,
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.25,
  shadowRadius: 8,
},
guideHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  paddingHorizontal: 20,
  paddingTop: 18,
  paddingBottom: 14,
  borderBottomWidth: 1,
  borderBottomColor: c.hairline,
},
guideEyebrow: {
  fontSize: 9,
  letterSpacing: 2.2,
  textTransform: 'uppercase',
  color: c.textMuted,
  marginBottom: 4,
  fontWeight: '700',
},
guideTitle: {
  fontSize: 18,
  fontWeight: '800',
  color: c.text,
  letterSpacing: 0.2,
},
guideBody: {
  paddingHorizontal: 20,
  paddingVertical: 18,
  paddingBottom: 28,
  gap: 12,
},
guideIntro: {
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

  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 32,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center', alignItems: 'center',
  },
  logoBoxSmall: {
    width: 40, height: 40, borderRadius: 12,
    
    justifyContent: 'center', alignItems: 'center',
  },

  heading: { fontSize: 26, fontWeight: '700', color: c.text, marginBottom: 4 },
  subheading: { fontSize: 14, color: c.textMuted, marginBottom: 28 },

  fieldsCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  fieldGroup: { paddingVertical: 16 },
  fieldBorder: { borderBottomWidth: 1, borderBottomColor: c.hairline },
  label: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 1.5, marginBottom: 8 },

  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surfaceAlt,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'transparent',
    paddingHorizontal: 12,
  },
  inputRowFocused: {
    borderColor: c.accent,
    backgroundColor: c.surface,
  },
  icon: { marginRight: 8 },
  input: {
flex: 1,
    paddingVertical: 12,
fontSize: 15,
color: c.text,
},
  eyeBtn: { padding: 4 },

  terms: {
    fontSize: 12,
    color: c.iconInactive,
    lineHeight: 18,
    marginBottom: 24,
  },

  primaryBtn: {
    backgroundColor: c.accent,
    borderRadius: 12,
    paddingVertical: 15,
alignItems: 'center',
marginBottom: 20,
},
  primaryBtnText: { fontSize: 15, fontWeight: '700', color: c.accentText, letterSpacing: 0.3 },
  disabledBtn: { opacity: 0.4 },
  
  bottomLink: { alignItems: 'center' },
  bottomLinkText: { fontSize: 14, color: c.textMuted },
  bottomLinkBold: { color: c.text, fontWeight: '700' },
})
