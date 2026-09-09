import React, { useEffect, useState , useMemo} from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Image,
  Switch,
  Modal,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import * as ImagePicker from 'expo-image-picker'
import { getCurrentUser } from '../lib/auth'
import { getUserProfileByUserId, createUserProfile, updateUserProfile } from '../db/queries'
import { UserProfile } from '../db/models'
import { uploadAvatar } from '../lib/uploadAvatar'
import { supabase } from '../lib/supabase'
import { onTableChange } from '../lib/sync'
import { usePullToRefresh } from '../lib/usePullToRefresh'

const ROLES = [
  'Vocals',
  'Drums',
  'Keyboard',
  'Bass',
  'Electric Guitar',
  'Acoustic Guitar',
  'Song Leader',
]

// Monochrome palette - Formal & Professional

interface FormData {
  nickname: string
  bio: string
  avatarUrl: string
  roles: string
  isPrivate: boolean
}

interface PasswordForm {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

export default function EditAccountScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [user, setUser] = useState<any>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [formData, setFormData] = useState<FormData>({
    nickname: '',
    bio: '',
    avatarUrl: '',
    roles: '',
    isPrivate: false,
  })

  // Change Password Modal state
  const [passwordModalVisible, setPasswordModalVisible] = useState(false)
  const [passwordForm, setPasswordForm] = useState<PasswordForm>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  })
  const [passwordError, setPasswordError] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const hasLoadedOnceRef = React.useRef(false)

  useEffect(() => {
    void loadUserProfile()
  }, [])

  useEffect(() => {
    const unsubLocal = onTableChange('user_profiles', () => {
      void loadUserProfile({ silent: true })
    })

    const userProfilesChannel = supabase
      .channel('edit-account-user-profiles')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_profiles' }, () => {
        void loadUserProfile({ silent: true })
      })
      .subscribe()

    return () => {
      unsubLocal()
      supabase.removeChannel(userProfilesChannel)
    }
  }, [])

  const loadUserProfile = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true)
      const currentUser = await getCurrentUser()
      if (currentUser) {
        setUser(currentUser)
        const userProfile = await getUserProfileByUserId(currentUser.id)
        if (userProfile) {
          setProfile(userProfile)
          const rawBio = userProfile.bio || ''
          const isPrivate = rawBio.startsWith('[private]')
          const cleanBio = rawBio.replace('[private]', '').trim()
          setFormData({
            nickname: userProfile.nickname || '',
            bio: cleanBio,
            avatarUrl: userProfile.avatarUrl || '',
            roles: userProfile.instruments || '',
            isPrivate,
          })
        } else {
          const newProfile = await createUserProfile({
            userId: currentUser.id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            synced: false,
          })
          setProfile(newProfile)
        }
      }
    } catch (err) {
      console.error('Error loading profile:', err)
      Alert.alert('Error', 'Failed to load profile')
    } finally {
      hasLoadedOnceRef.current = true
      if (!silent) setLoading(false)
    }
  }

  const { refreshing, onRefresh } = usePullToRefresh(() => loadUserProfile({ silent: true }))

  const handleSaveProfile = async () => {
    if (!user) return
    try {
      setSaving(true)
      const bioToSave = formData.isPrivate
        ? `[private]${formData.bio}`
        : formData.bio

      await updateUserProfile(user.id, {
        nickname: formData.nickname,
        bio: bioToSave,
        avatarUrl: formData.avatarUrl,
        instruments: formData.roles,
        updatedAt: Date.now(),
        synced: false,
      })
      Alert.alert('Success', 'Profile updated successfully')
    } catch (err) {
      console.error('Error saving profile:', err)
      Alert.alert('Error', 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  const handlePickImage = async () => {
    if (!user) return
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.7,
      })

      if (!result.canceled && result.assets[0]) {
        const localUri = result.assets[0].uri
        setSaving(true)
        const publicUrl = await uploadAvatar(user.id, localUri)
        if (publicUrl) {
          const bustedUrl = `${publicUrl}?t=${Date.now()}`
          await updateUserProfile(user.id, { avatarUrl: bustedUrl })
          setFormData({ ...formData, avatarUrl: bustedUrl })
        } else {
          Alert.alert('Error', 'Failed to upload avatar')
        }
        setSaving(false)
      }
    } catch (err) {
      console.error('Error picking image:', err)
      Alert.alert('Error', 'Failed to pick image')
      setSaving(false)
    }
  }

  // ── Change Password ──────────────────────────────────────────────────────────

  const openPasswordModal = () => {
    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
    setPasswordError('')
    setShowCurrent(false)
    setShowNew(false)
    setShowConfirm(false)
    setPasswordModalVisible(true)
  }

  const closePasswordModal = () => {
    setPasswordModalVisible(false)
  }

  const handleChangePassword = async () => {
    const { currentPassword, newPassword, confirmPassword } = passwordForm
    setPasswordError('')

    // Client-side validation
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('All fields are required.')
      return
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.')
      return
    }
    if (currentPassword === newPassword) {
      setPasswordError('New password must differ from current password.')
      return
    }

    try {
      setChangingPassword(true)

      // Step 1: Re-authenticate with current password to verify it's correct
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      })

      if (signInError) {
        setPasswordError('Current password is incorrect.')
        return
      }

      // Step 2: Update to new password
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      })

      if (updateError) {
        setPasswordError(updateError.message || 'Failed to update password.')
        return
      }

      closePasswordModal()
      Alert.alert('Success', 'Password changed successfully.')
    } catch (err) {
      console.error('Error changing password:', err)
      setPasswordError('An unexpected error occurred. Please try again.')
    } finally {
      setChangingPassword(false)
    }
  }

  // ── Delete Account ───────────────────────────────────────────────────────────

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account and all data. This action cannot be undone.',
      [
        { text: 'Cancel' },
        {
          text: 'Delete',
          onPress: () => {
            Alert.alert('Confirm Delete', 'Type your email to confirm deletion:', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete My Account',
                onPress: () => {
                  Alert.alert(
                    'Account Deletion',
                    'Account deletion would require backend implementation.\n\nPlease contact support to delete your account.'
                  )
                },
                style: 'destructive',
              },
            ])
          },
          style: 'destructive',
        },
      ]
    )
  }

  const toggleInstrument = (instrument: string) => {
    const instruments = formData.roles.split(',').map(i => i.trim()).filter(i => i)
    if (instruments.includes(instrument)) {
      setFormData({ ...formData, roles: instruments.filter(i => i !== instrument).join(', ') })
    } else {
      setFormData({ ...formData, roles: [...instruments, instrument].join(', ') })
    }
  }

  const selectedInstruments = formData.roles.split(',').map(i => i.trim()).filter(i => i)

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={c.info} />
      </View>
    )
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Avatar Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Profile Picture</Text>
          <View style={styles.avatarPreviewContainer}>
            {formData.avatarUrl ? (
              <Image source={{ uri: formData.avatarUrl }} style={styles.avatarPreview} />
            ) : (
              <View style={[styles.avatarPreview, styles.avatarPlaceholder]}>
                <Ionicons name="person" size={64} color={c.textSub} />
              </View>
            )}
          </View>
          <TouchableOpacity style={styles.uploadButton} onPress={handlePickImage}>
            <Ionicons name="image" size={20} color={c.accentText} />
            <Text style={styles.uploadButtonText}>Choose Photo</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>Tap to select an image from your device</Text>
        </View>

        {/* Nickname Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Nickname</Text>
          <TextInput
            style={styles.input}
            placeholder="Your nickname"
            value={formData.nickname}
            onChangeText={text => setFormData({ ...formData, nickname: text })}
            maxLength={30}
          />
          <Text style={styles.hint}>{formData.nickname.length}/30 characters</Text>
        </View>

        {/* Bio Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Bio</Text>
          <TextInput
            style={[styles.input, styles.bioInput]}
            placeholder="Tell others about yourself..."
            value={formData.bio}
            onChangeText={text => setFormData({ ...formData, bio: text })}
            multiline
            numberOfLines={4}
            maxLength={200}
          />
          <Text style={styles.hint}>{formData.bio.length}/200 characters</Text>
        </View>

        {/* Roles Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your Roles</Text>
          <Text style={styles.hint}>Select all roles you have in your worship team</Text>
          <View style={styles.instrumentsGrid}>
            {ROLES.map(role => (
              <TouchableOpacity
                key={role}
                style={[
                  styles.instrumentButton,
                  selectedInstruments.includes(role) && styles.instrumentButtonActive,
                ]}
                onPress={() => toggleInstrument(role)}
              >
                <Text
                  style={[
                    styles.instrumentButtonText,
                    selectedInstruments.includes(role) && styles.instrumentButtonTextActive,
                  ]}
                >
                  {role}
                </Text>
                {selectedInstruments.includes(role) && (
                  <Ionicons name="checkmark" size={16} color={c.accentText} style={styles.instrumentCheck} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Privacy Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Privacy</Text>
          <View style={styles.privacyRow}>
            <View style={styles.privacyInfo}>
              <View style={styles.privacyLabelRow}>
                <Ionicons
                  name={formData.isPrivate ? 'lock-closed' : 'lock-open'}
                  size={18}
                  color={c.text}
                />
                <Text style={styles.privacyLabel}>
                  {formData.isPrivate ? 'Private Profile' : 'Public Profile'}
                </Text>
              </View>
              <Text style={styles.privacyDescription}>
                {formData.isPrivate
                  ? 'Only your name and photo are visible to others. Bio and roles are hidden.'
                  : 'Your full profile (bio, roles) is visible to everyone in the community.'}
              </Text>
            </View>
            <Switch
              value={formData.isPrivate}
              onValueChange={val => setFormData({ ...formData, isPrivate: val })}
              trackColor={{ false: c.border, true: c.accent }}
              thumbColor={formData.isPrivate ? c.surface : c.surface}
            />
          </View>

          {/* Visual preview */}
          <View style={styles.privacyPreview}>
            <Text style={styles.privacyPreviewLabel}>What others see:</Text>
            <View style={styles.privacyPreviewCard}>
              <View style={styles.privacyPreviewAvatar}>
                {formData.avatarUrl ? (
                  <Image source={{ uri: formData.avatarUrl }} style={styles.privacyPreviewImg} />
                ) : (
                  <View style={[styles.privacyPreviewImg, styles.privacyPreviewAvatarFallback]}>
                    <Ionicons name="person" size={22} color={c.textSub} />
                  </View>
                )}
              </View>
              <View style={styles.privacyPreviewText}>
                <Text style={styles.privacyPreviewName}>
                  {formData.nickname || 'Your Name'}
                </Text>
                {formData.isPrivate ? (
                  <View style={styles.privacyHiddenBadge}>
                    <Ionicons name="lock-closed" size={10} color={c.textSub} />
                    <Text style={styles.privacyHiddenText}>Profile hidden</Text>
                  </View>
                ) : (
                  <>
                    {formData.bio ? (
                      <Text style={styles.privacyPreviewBio} numberOfLines={2}>
                        {formData.bio}
                      </Text>
                    ) : null}
                    {selectedInstruments.length > 0 && (
                      <Text style={styles.privacyPreviewRoles} numberOfLines={1}>
                        {selectedInstruments.join(' · ')}
                      </Text>
                    )}
                  </>
                )}
              </View>
            </View>
          </View>
        </View>

        {/* Save Button */}
        <TouchableOpacity
          style={[styles.primaryButton, saving && styles.disabledButton]}
          onPress={handleSaveProfile}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={c.accentText} />
          ) : (
            <>
              <Ionicons name="save" size={20} color={c.accentText} />
              <Text style={styles.primaryButtonText}>Save Profile</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Account Actions Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <TouchableOpacity style={styles.actionButton} onPress={openPasswordModal}>
            <Ionicons name="lock-closed" size={20} color={c.text} />
            <Text style={styles.actionButtonText}>Change Password</Text>
            <Ionicons name="chevron-forward" size={20} color={c.iconInactive} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={handleDeleteAccount}>
            <Ionicons name="trash" size={20} color={c.text} />
            <Text style={[styles.actionButtonText, styles.deleteText]}>Delete Account</Text>
            <Ionicons name="chevron-forward" size={20} color={c.iconInactive} />
          </TouchableOpacity>
        </View>

        {/* Account Info */}
        <View style={styles.infoSection}>
          <Text style={styles.infoLabel}>Email:</Text>
          <Text style={styles.infoValue}>{user?.email}</Text>
        </View>

        <View style={styles.spacer} />
      </ScrollView>

      {/* ── Change Password Modal ──────────────────────────────────────────────── */}
      <Modal
        visible={passwordModalVisible}
        animationType="slide"
        transparent
        onRequestClose={closePasswordModal}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalContainer}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Change Password</Text>
              <TouchableOpacity onPress={closePasswordModal} style={styles.modalCloseButton}>
                <Ionicons name="close" size={22} color={c.textSub} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              Enter your current password, then choose a new one.
            </Text>

            {/* Current Password */}
            <Text style={styles.modalFieldLabel}>Current Password</Text>
            <View style={styles.passwordInputRow}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Enter current password"
                placeholderTextColor={c.textMuted}
                secureTextEntry={!showCurrent}
                value={passwordForm.currentPassword}
                onChangeText={text => setPasswordForm({ ...passwordForm, currentPassword: text })}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                onPress={() => setShowCurrent(v => !v)}
                style={styles.eyeButton}
              >
                <Ionicons
                  name={showCurrent ? 'eye-off' : 'eye'}
                  size={20}
                  color={c.textSub}
                />
              </TouchableOpacity>
            </View>

            {/* New Password */}
            <Text style={styles.modalFieldLabel}>New Password</Text>
            <View style={styles.passwordInputRow}>
              <TextInput
                style={styles.passwordInput}
                placeholder="At least 8 characters"
                placeholderTextColor={c.textMuted}
                secureTextEntry={!showNew}
                value={passwordForm.newPassword}
                onChangeText={text => setPasswordForm({ ...passwordForm, newPassword: text })}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                onPress={() => setShowNew(v => !v)}
                style={styles.eyeButton}
              >
                <Ionicons
                  name={showNew ? 'eye-off' : 'eye'}
                  size={20}
                  color={c.textSub}
                />
              </TouchableOpacity>
            </View>

            {/* Confirm New Password */}
            <Text style={styles.modalFieldLabel}>Confirm New Password</Text>
            <View style={styles.passwordInputRow}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Repeat new password"
                placeholderTextColor={c.textMuted}
                secureTextEntry={!showConfirm}
                value={passwordForm.confirmPassword}
                onChangeText={text => setPasswordForm({ ...passwordForm, confirmPassword: text })}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                onPress={() => setShowConfirm(v => !v)}
                style={styles.eyeButton}
              >
                <Ionicons
                  name={showConfirm ? 'eye-off' : 'eye'}
                  size={20}
                  color={c.textSub}
                />
              </TouchableOpacity>
            </View>

            {/* Inline error */}
            {passwordError ? (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle" size={15} color={c.danger} />
                <Text style={styles.errorText}>{passwordError}</Text>
              </View>
            ) : null}

            {/* Actions */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={closePasswordModal}
                disabled={changingPassword}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalConfirmButton, changingPassword && styles.disabledButton]}
                onPress={handleChangePassword}
                disabled={changingPassword}
              >
                {changingPassword ? (
                  <ActivityIndicator color={c.accentText} size="small" />
                ) : (
                  <Text style={styles.modalConfirmText}>Update Password</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.surfaceAlt,
  },
  container: {
    flex: 1,
    backgroundColor: c.surfaceAlt,
  },
  section: {
    backgroundColor: c.surface,
    marginVertical: 10,
    marginHorizontal: 0,
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: c.text,
    marginBottom: 14,
    letterSpacing: 0.2,
  },
  input: {
    borderWidth: 1.5,
    borderColor: c.border,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: c.surfaceAlt,
    marginBottom: 8,
    color: c.text,
    fontWeight: '500',
  },
  bioInput: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  hint: {
    fontSize: 12,
    color: c.textSub,
    marginBottom: 12,
    fontWeight: '400',
  },
  avatarPreviewContainer: {
    alignItems: 'center',
    marginBottom: 20,
    paddingVertical: 12,
  },
  avatarPreview: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: c.surfaceAlt,
    borderWidth: 2,
    borderColor: c.accent,
  },
  avatarPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accent,
    borderRadius: 6,
    paddingVertical: 13,
    marginBottom: 10,
    gap: 8,
    elevation: 2,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
  },
  uploadButtonText: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  instrumentsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 8,
  },
  instrumentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: c.accent,
    backgroundColor: c.surface,
  },
  instrumentButtonActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  instrumentButtonText: {
    fontSize: 13,
    color: c.text,
    fontWeight: '600',
  },
  instrumentButtonTextActive: {
    color: c.accentText,
  },
  instrumentCheck: {
    marginLeft: 6,
  },
  privacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
    gap: 14,
  },
  privacyInfo: {
    flex: 1,
  },
  privacyLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 5,
  },
  privacyLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
  },
  privacyDescription: {
    fontSize: 12,
    color: c.textSub,
    lineHeight: 17,
  },
  privacyPreview: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 8,
    padding: 14,
    borderWidth: 1.5,
    borderColor: c.border,
  },
  privacyPreviewLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: c.textSub,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  privacyPreviewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.surface,
    padding: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.border,
  },
  privacyPreviewAvatar: {},
  privacyPreviewImg: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  privacyPreviewAvatarFallback: {
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
  },
  privacyPreviewText: {
    flex: 1,
  },
  privacyPreviewName: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
    marginBottom: 3,
  },
  privacyPreviewBio: {
    fontSize: 12,
    color: c.textSub,
    lineHeight: 16,
    marginBottom: 3,
  },
  privacyPreviewRoles: {
    fontSize: 11,
    color: c.text,
    fontWeight: '600',
  },
  privacyHiddenBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: c.surfaceAlt,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: c.border,
  },
  privacyHiddenText: {
    fontSize: 11,
    color: c.textSub,
    fontWeight: '500',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accent,
    borderRadius: 6,
    paddingVertical: 15,
    marginHorizontal: 16,
    marginVertical: 18,
    gap: 10,
    elevation: 3,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  disabledButton: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: c.accentText,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    paddingHorizontal: 14,
    backgroundColor: c.surfaceAlt,
    borderRadius: 6,
    marginBottom: 9,
    gap: 12,
    borderWidth: 1,
    borderColor: c.hairline,
  },
  actionButtonText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: c.text,
  },
  deleteText: {
    color: c.text,
  },
  infoSection: {
    backgroundColor: c.surface,
    marginVertical: 10,
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  infoLabel: {
    fontSize: 11,
    color: c.textSub,
    marginBottom: 6,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  infoValue: {
    fontSize: 15,
    color: c.text,
    fontWeight: '600',
  },
  spacer: {
    height: 40,
  },

  // ── Modal styles ─────────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: c.accent,
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: c.text,
    letterSpacing: 0.2,
  },
  modalCloseButton: {
    padding: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    color: c.textSub,
    marginBottom: 20,
    lineHeight: 18,
  },
  modalFieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textSub,
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  passwordInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: c.border,
    borderRadius: 6,
    backgroundColor: c.surfaceAlt,
    marginBottom: 14,
    paddingRight: 10,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: c.text,
    fontWeight: '500',
  },
  eyeButton: {
    padding: 4,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.dangerBg,
    borderRadius: 6,
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
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: c.border,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: c.textSub,
  },
  modalConfirmButton: {
    flex: 2,
    paddingVertical: 13,
    borderRadius: 6,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalConfirmText: {
    fontSize: 15,
    fontWeight: '700',
    color: c.accentText,
    letterSpacing: 0.2,
  },
})