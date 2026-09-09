import React, { useState, useRef, useEffect , useMemo} from 'react'
import {
  View,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Text,
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Dimensions,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Svg, { Circle, Line } from 'react-native-svg'
import Ionicons from '@expo/vector-icons/Ionicons'
import { supabase } from '../lib/supabase'

const { width, height } = Dimensions.get('window')

interface Props {
  onResetSuccess: () => void // navigate to sign in after success
}

function Background() {
  const { colors: c } = useAppTheme()

  return (
    <Svg
      width={width}
      height={height}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      <Circle cx={width + 20} cy={-20} r={160} fill="none" stroke={c.iconInactive} strokeWidth={1} />
      <Circle cx={width + 20} cy={-20} r={110} fill="none" stroke={c.accentText} strokeWidth={1} />
      <Circle cx={width + 20} cy={-20} r={60} fill={c.surfaceAlt} opacity={0.7} />
      <Circle cx={-40} cy={height + 30} r={180} fill="none" stroke={c.iconInactive} strokeWidth={1} />
      <Circle cx={-40} cy={height + 30} r={120} fill="none" stroke={c.accentText} strokeWidth={1} />
      <Circle cx={-40} cy={height + 30} r={65} fill={c.surfaceMuted} opacity={0.6} />
      {[0, 1, 2, 3, 4].map(i => (
        <Line
          key={i}
          x1={0}
          y1={height - 80 + i * 12}
          x2={width * 0.55}
          y2={height - 80 + i * 12}
          stroke={c.iconInactive}
          strokeWidth={1}
        />
      ))}
      <Circle cx={width * 0.55 + 10} cy={height - 56} r={7} fill={c.border} />
      <Line
        x1={width * 0.55 + 17}
        y1={height - 56}
        x2={width * 0.55 + 17}
        y2={height - 95}
        stroke={c.iconInactive}
        strokeWidth={1.5}
      />
      {[...Array(4)].map((_, row) =>
        [...Array(4)].map((_, col) => (
          <Circle
            key={`${row}-${col}`}
            cx={24 + col * 18}
            cy={100 + row * 18}
            r={1.5}
            fill={c.border}
          />
        ))
      )}
    </Svg>
  )
}

type ScreenState = 'form' | 'success' | 'error'

export default function ResetPasswordScreen({ onResetSuccess }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [newFocused, setNewFocused] = useState(false)
  const [confirmFocused, setConfirmFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [fieldError, setFieldError] = useState('')
  const [screenState, setScreenState] = useState<ScreenState>('form')

  const fadeAnim = useRef(new Animated.Value(0)).current
  const slideAnim = useRef(new Animated.Value(24)).current

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start()
  }, [])

  // Password strength helper
  const getStrength = (pwd: string): { label: string; color: string; bars: number } => {
    if (pwd.length === 0) return { label: '', color: c.iconInactive, bars: 0 }
    if (pwd.length < 6) return { label: 'Too short', color: c.danger, bars: 1 }
    if (pwd.length < 8) return { label: 'Weak', color: c.warning, bars: 2 }
    const hasUpper = /[A-Z]/.test(pwd)
    const hasNumber = /[0-9]/.test(pwd)
    const hasSymbol = /[^A-Za-z0-9]/.test(pwd)
    const extras = [hasUpper, hasNumber, hasSymbol].filter(Boolean).length
    if (extras === 0) return { label: 'Fair', color: c.warning, bars: 2 }
    if (extras === 1) return { label: 'Good', color: c.success, bars: 3 }
    return { label: 'Strong', color: c.success, bars: 4 }
  }

  const strength = getStrength(newPassword)

  const handleUpdatePassword = async () => {
    setFieldError('')

    if (!newPassword || !confirmPassword) {
      setFieldError('Both fields are required.')
      return
    }
    if (newPassword.length < 8) {
      setFieldError('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setFieldError('Passwords do not match.')
      return
    }

    try {
      setLoading(true)
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) {
        setFieldError(error.message || 'Failed to update password. Please try again.')
        return
      }
      setScreenState('success')
    } catch (err) {
      console.error('Reset password error:', err)
      setFieldError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
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

            {/* Logo */}
            <View style={styles.logoArea}>
              <View style={styles.logoBox}>
                <Ionicons name="musical-notes" size={28} color={c.text} />
              </View>
              <Text style={styles.appName}>S A V E D  W O R S H I P</Text>
              <Text style={styles.appSub}>MUSIC TOOL</Text>
            </View>

            {screenState === 'form' && (
              <>
                <Text style={styles.heading}>Set New Password</Text>
                <Text style={styles.subheading}>Choose a strong password for your account.</Text>

                {/* New Password */}
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>NEW PASSWORD</Text>
                  <View style={[styles.inputRow, newFocused && styles.inputRowFocused]}>
                    <Ionicons
                      name="lock-closed-outline"
                      size={16}
                      color={newFocused ? c.text : c.textMuted}
                      style={styles.icon}
                    />
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      placeholder="At least 8 characters"
                      placeholderTextColor={c.textMuted}
                      secureTextEntry={!showNew}
                      value={newPassword}
                      onChangeText={text => {
                        setNewPassword(text)
                        setFieldError('')
                      }}
                      onFocus={() => setNewFocused(true)}
                      onBlur={() => setNewFocused(false)}
                      editable={!loading}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity onPress={() => setShowNew(v => !v)} style={styles.eyeBtn}>
                      <Ionicons name={showNew ? 'eye-off-outline' : 'eye-outline'} size={16} color={c.textMuted} />
                    </TouchableOpacity>
                  </View>

                  {/* Strength meter */}
                  {newPassword.length > 0 && (
                    <View style={styles.strengthContainer}>
                      <View style={styles.strengthBars}>
                        {[1, 2, 3, 4].map(bar => (
                          <View
                            key={bar}
                            style={[
                              styles.strengthBar,
                              { backgroundColor: bar <= strength.bars ? strength.color : c.iconInactive },
                            ]}
                          />
                        ))}
                      </View>
                      {strength.label ? (
                        <Text style={[styles.strengthLabel, { color: strength.color }]}>
                          {strength.label}
                        </Text>
                      ) : null}
                    </View>
                  )}
                </View>

                {/* Confirm Password */}
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>CONFIRM PASSWORD</Text>
                  <View style={[styles.inputRow, confirmFocused && styles.inputRowFocused]}>
                    <Ionicons
                      name="lock-closed-outline"
                      size={16}
                      color={confirmFocused ? c.text : c.textMuted}
                      style={styles.icon}
                    />
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      placeholder="Repeat new password"
                      placeholderTextColor={c.textMuted}
                      secureTextEntry={!showConfirm}
                      value={confirmPassword}
                      onChangeText={text => {
                        setConfirmPassword(text)
                        setFieldError('')
                      }}
                      onFocus={() => setConfirmFocused(true)}
                      onBlur={() => setConfirmFocused(false)}
                      editable={!loading}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity onPress={() => setShowConfirm(v => !v)} style={styles.eyeBtn}>
                      <Ionicons name={showConfirm ? 'eye-off-outline' : 'eye-outline'} size={16} color={c.textMuted} />
                    </TouchableOpacity>
                  </View>

                  {/* Match indicator */}
                  {confirmPassword.length > 0 && (
                    <View style={styles.matchRow}>
                      <Ionicons
                        name={newPassword === confirmPassword ? 'checkmark-circle' : 'close-circle'}
                        size={14}
                        color={newPassword === confirmPassword ? c.success : c.danger}
                      />
                      <Text style={[
                        styles.matchText,
                        { color: newPassword === confirmPassword ? c.success : c.danger }
                      ]}>
                        {newPassword === confirmPassword ? 'Passwords match' : 'Passwords do not match'}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Inline error */}
                {fieldError ? (
                  <View style={styles.errorRow}>
                    <Ionicons name="alert-circle" size={14} color={c.danger} />
                    <Text style={styles.errorText}>{fieldError}</Text>
                  </View>
                ) : null}

                {/* Submit */}
                <TouchableOpacity
                  style={[styles.primaryBtn, loading && styles.disabledBtn]}
                  onPress={handleUpdatePassword}
                  disabled={loading}
                  activeOpacity={0.8}
                >
                  {loading
                    ? <ActivityIndicator color={c.accentText} />
                    : <Text style={styles.primaryBtnText}>Update Password</Text>
                  }
                </TouchableOpacity>
              </>
            )}

            {screenState === 'success' && (
              <View style={styles.successContainer}>
                <View style={styles.successIconCircle}>
                  <Ionicons name="checkmark" size={32} color={c.text} />
                </View>
                <Text style={styles.heading}>Password Updated</Text>
                <Text style={styles.successBody}>
                  Your password has been changed successfully. You can now sign in with your new password.
                </Text>
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={onResetSuccess}
                  activeOpacity={0.8}
                >
                  <Text style={styles.primaryBtnText}>Back to Sign In</Text>
                </TouchableOpacity>
              </View>
            )}

          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.surfaceAlt },
  scrollContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: 60 },
  content: { paddingHorizontal: 28 },

  logoArea: { alignItems: 'center', marginBottom: 40 },
  logoBox: {
    width: 60, height: 60, borderRadius: 18,
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 12,
  },
  appName: { fontSize: 20, fontWeight: '700', color: c.text, letterSpacing: 0.5 },
  appSub: { fontSize: 10, color: c.textMuted, letterSpacing: 3.5, marginTop: 3 },

  heading: { fontSize: 26, fontWeight: '700', color: c.text, marginBottom: 4 },
  subheading: { fontSize: 14, color: c.textMuted, marginBottom: 32 },

  fieldGroup: { marginBottom: 20 },
  label: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 1.5, marginBottom: 8 },

  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surfaceMuted,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'transparent',
    paddingHorizontal: 14,
  },
  inputRowFocused: {
    borderColor: c.accent,
    backgroundColor: c.surface,
  },
  icon: { marginRight: 10 },
  input: {
    paddingVertical: 14,
    fontSize: 15,
    color: c.text,
  },
  eyeBtn: { padding: 4 },

  // Strength meter
  strengthContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 8,
  },
  strengthBars: {
    flexDirection: 'row',
    gap: 4,
  },
  strengthBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  strengthLabel: {
    fontSize: 11,
    fontWeight: '600',
  },

  // Match indicator
  matchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  matchText: {
    fontSize: 12,
    fontWeight: '500',
  },

  // Error
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.dangerBg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: c.danger,
  },
  errorText: {
    fontSize: 13,
    color: c.danger,
    fontWeight: '500',
    flex: 1,
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

  // Success
  successContainer: {
    alignItems: 'center',
  },
  successIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  successBody: {
    fontSize: 14,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 36,
    marginTop: 8,
  },
})
