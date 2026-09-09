import React, { useEffect, useState, useRef, useMemo, useCallback, createContext, useContext } from 'react'
import { StatusBar } from 'expo-status-bar'
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Linking from 'expo-linking'
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Image
} from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import AsyncStorage from '@react-native-async-storage/async-storage'

// Initialize database
import { initializeDatabase } from './db/index'

// Auth
import { onAuthStateChange, getCurrentUser, AuthUser, OFFLINE_GUEST_USER_ID } from './lib/auth'

// Sync
import { stampUserIdOnUnsyncedRows, removeOrphanedUnsyncedRows, subscribeToChanges, fullSync } from './lib/sync'
import { queueDb } from './db/index'
import { startNetworkSync, stopNetworkSync } from './lib/networkSync'
import WebOfflineNotice from './components/WebOfflineNotice'
import { installWebAlert } from './lib/webAlert'

// Notifications
import { NotificationProvider } from './lib/NotificationContext'
import NotificationBell from './components/NotificationBell'

// Screens
import SignInScreen from './screens/SignInScreen'
import SignUpScreen from './screens/SignUpScreen'
import ChordListsHomeScreen from './screens/ChordListsHomeScreen'
import ChordListScreen from './screens/ChordListScreen'
import AddSongScreen from './screens/AddSongScreen'
import NoteDetailScreen from './screens/NoteDetailScreen'
import MetronomeScreen from './screens/MetronomeScreen'
import ManualTransposeScreen from './screens/ManualTransposeScreen'
import PersonalNotesScreen from './screens/PersonalNotesScreen'
import LineupScreen from './screens/LineupScreen'
import ManagementScreen from './screens/ManagementScreen'
import ConversationScreen from './screens/ConversationScreen'
import EditAccountScreen from './screens/EditAccountScreen'
import { useRole } from './lib/useRole'
import CalendarScreen from './screens/CalendarScreen'
import AudioToolsScreen from './screens/AudioToolsScreen'
import TunerScreen from './screens/TunerScreen'
import PadScreen from './screens/PadScreen'
import PadEngine from './components/PadEngine'
import { loadNotificationsFromSupabase } from './lib/notifications'
import { navigationRef } from './lib/notificationNavigation'
import { isOnline } from './lib/networkStatus'

// Components
import CustomDrawerContent from './components/CustomDrawerContent'
import {
  DEFAULT_THEME_ID,
  THEMES,
  THEME_STORAGE_KEY,
  ThemeContext,
  getTheme,
  isThemeId,
  themesOfMode,
  useAppTheme,
  type AppColors,
  type ThemeId,
  type ThemeMode,
} from './lib/theme'
import SongEditorScreen from './screens/SongEditorScreen'

// ── ADDED: Reset Password ─────────────────────────────────────────────────────
import ResetPasswordScreen from './screens/Resetpasswordscreen'
import { supabase } from './lib/supabase'
// ─────────────────────────────────────────────────────────────────────────────

// ─── Drawer geometry and timing ───────────────────────────────────────────────
// The panel covers three quarters of the screen, so that is also how far it has
// to travel to sit fully off-screen.
const DRAWER_WIDTH    = Dimensions.get('window').width * 0.75
const DRAWER_OPEN_MS  = 260
const DRAWER_CLOSE_MS = 220

const Stack = createNativeStackNavigator()
const Tab = createBottomTabNavigator()


// Theme context and palettes live in lib/theme.ts; re-exported here because
// plenty of call sites already import them from the app root.
export { ThemeContext, useAppTheme }

// ─── Theme Toggle Button ──────────────────────────────────────────────────────

function ThemeToggle() {
  const { mode, toggle, colors } = useAppTheme()
  return (
    <TouchableOpacity
      onPress={toggle}
      style={[themeToggleStyles.btn, { borderColor: colors.hairline }]}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Ionicons
        name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'}
        size={17}
        color={colors.icon}
      />
    </TouchableOpacity>
  )
}

const themeToggleStyles = StyleSheet.create({
  btn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
})

// ─── Auth Stack ───────────────────────────────────────────────────────────────

function AuthStack() {
  const [showSignUp, setShowSignUp] = useState(false)

  return (
    <Stack.Navigator id="auth-stack" screenOptions={{ headerShown: false }}>
      {showSignUp ? (
        <Stack.Screen name="SignUp">
          {(props: any) => (
            <SignUpScreen
              {...props}
              onSignUpSuccess={() => setShowSignUp(false)}
              onNavigateToSignIn={() => setShowSignUp(false)}
            />
          )}
        </Stack.Screen>
      ) : (
        <Stack.Screen name="SignIn">
          {(props: any) => (
            <SignInScreen
              {...props}
              onSignInSuccess={() => {}}
              onNavigateToSignUp={() => setShowSignUp(true)}
            />
          )}
        </Stack.Screen>
      )}
    </Stack.Navigator>
  )
}

// ─── Chord Lists Stack ────────────────────────────────────────────────────────

function ChordListsStack() {
  const { canManageChords } = useRole()
  const { colors } = useAppTheme()

  return (
    <Stack.Navigator
      id="chord-lists-stack"
      screenOptions={{
        headerShown: false,
        headerTintColor: colors.text,
        headerStyle: { backgroundColor: colors.header },
      }}
    >
      <Stack.Screen name="ChordListsHome" component={ChordListsHomeScreen} options={{ headerShown: false }} />
      <Stack.Screen
        name="ChordList"
        component={ChordListScreen}
        options={{ title: 'Song', headerLeft: () => null, headerShown: false }}
      />
      {canManageChords && (
        <>
          <Stack.Screen
            name="AddSong"
            component={AddSongScreen}
            options={{ title: 'Add Song', headerLeft: () => null, headerShown: false }}
          />
          <Stack.Screen
            name="SongEditor"
            component={SongEditorScreen}
            options={{ title: 'Song', headerLeft: () => null, headerShown: false }}
          />
        </>
      )}
    </Stack.Navigator>
  )
}

// ─── Personal Notes Stack ─────────────────────────────────────────────────────

function PersonalNotesStack() {
  const { colors } = useAppTheme()
  return (
    <Stack.Navigator
      id="personal-notes-stack"
      screenOptions={{
        headerShown: true,
        headerTintColor: colors.text,
        headerStyle: { backgroundColor: colors.header },
      }}
    >
      <Stack.Screen name="PersonalNotesHome" component={PersonalNotesScreen} options={{ headerShown: false }} />
      <Stack.Screen
        name="NoteDetail"
        component={NoteDetailScreen}
        options={{ title: 'Note', headerLeft: () => null, headerShown: false}}
      />
    </Stack.Navigator>
  )
}

// ─── Shared header options factory ───────────────────────────────────────────

function makeHeaderOptions(colors: AppColors) {
  return {
    headerShown: true,
    headerTintColor: colors.text,
    headerStyle: { 
      backgroundColor: colors.header,
    },
    headerShadowVisible: false,
    headerTitleStyle: {
      fontWeight: '700' as const,
      fontSize: 15,
      letterSpacing: 0.3,
      color: colors.text,
    },
  }
}

// ─── Tab Navigator ────────────────────────────────────────────────────────────

function TabsScreen({ setDrawerVisible }: { setDrawerVisible: (v: boolean) => void }) {
  const { colors } = useAppTheme()
  const insets = useSafeAreaInsets()
  const androidBottomInset = Platform.OS === 'android' ? insets.bottom : 0

  const tabIcon = (route: any, focused: boolean, color: string, size: number) => {
    const icons: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
      ChordListsTab:    ['musical-notes',  'musical-notes-outline'],
      PersonalNotesTab: ['shield',          'shield-outline'],
      LineupsTab:       ['list',            'list-outline'],
      ManagementTab:    ['settings',        'settings-outline'],
      ConversationTab:  ['chatbubbles',     'chatbubbles-outline'],
    }
    const [active, inactive] = icons[route.name] ?? ['ellipse', 'ellipse-outline']
    return <Ionicons name={focused ? active : inactive} size={size} color={color} />
  }

  return (
    <Tab.Navigator
      id="main-tabs"
      screenOptions={({ route }) => ({
        ...makeHeaderOptions(colors),
        headerLeft: () => (
          <TouchableOpacity
            onPress={() => setDrawerVisible(true)}
            style={{ marginLeft: 16 }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="menu-outline" size={22} color={colors.icon} />
          </TouchableOpacity>
        ),
        headerRight: () => (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 8 }}>
            {/* <ThemeToggle /> */}
            <NotificationBell />
          </View>
        ),
        tabBarIcon: ({ focused, color, size }) => tabIcon(route, focused, color, size),
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.iconInactive,
        tabBarStyle: {
          backgroundColor: colors.tabBar,
          borderTopColor: colors.hairline,
          borderTopWidth: StyleSheet.hairlineWidth,
          elevation: 0,
          shadowOpacity: 0,
          height: (Platform.OS === 'ios' ? 84 : 60) + androidBottomInset,
          paddingBottom: Platform.OS === 'ios' ? 28 : 10,
          paddingTop: 8,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 1.2,
          textTransform: 'uppercase',
        },
      })}
    >
      <Tab.Screen name="ChordListsTab"    component={ChordListsStack}   options={{ title: 'Chords' }} />
      <Tab.Screen name="PersonalNotesTab" component={PersonalNotesStack} options={{ title: 'Notes' }} />
      <Tab.Screen name="LineupsTab"       component={LineupScreen}      options={{ title: 'Lineups' }} />
      <Tab.Screen name="ManagementTab"    component={ManagementScreen}   options={{ title: 'Manage' }} />
      <Tab.Screen name="ConversationTab"  component={ConversationScreen} options={{ title: 'Chat' }} />
    </Tab.Navigator>
  )
}

// ─── App Stack ────────────────────────────────────────────────────────────────

function AppTabs({
  drawerVisible,
  setDrawerVisible,
}: {
  drawerVisible: boolean
  setDrawerVisible: (v: boolean) => void
}) {
  const { colors } = useAppTheme()

  // ── Drawer slide ────────────────────────────────────────────────────────────
  //
  // Modal's own animationType="slide" comes up from the bottom, which is wrong
  // for a side drawer, so the Modal is left unanimated and the panel is driven
  // by hand: it travels its own width in from the left on open and back out on
  // close, with the backdrop fading alongside it.
  //
  // The Modal has to outlive drawerVisible going false, or the close animation
  // would be unmounted before it played - hence drawerMounted, which is cleared
  // only once the panel has finished sliding out.
  const [drawerMounted, setDrawerMounted] = useState(drawerVisible)
  const drawerAnim = useRef(new Animated.Value(drawerVisible ? 1 : 0)).current

  useEffect(() => {
    if (drawerVisible) {
      setDrawerMounted(true)
      Animated.timing(drawerAnim, {
        toValue: 1,
        duration: DRAWER_OPEN_MS,
        easing: Easing.out(Easing.cubic),   // arrives gently, no bounce
        useNativeDriver: true,
      }).start()
      return
    }

    Animated.timing(drawerAnim, {
      toValue: 0,
      duration: DRAWER_CLOSE_MS,            // closing is quicker than opening
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setDrawerMounted(false)
    })
  }, [drawerVisible, drawerAnim])

  const drawerTranslateX = drawerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-DRAWER_WIDTH, 0],        // fully off-screen left, to flush left
  })

  return (
    <>
      <Stack.Navigator id="app-stack" screenOptions={{ headerShown: false }}>
        <Stack.Screen name="TabsStack">
          {() => <TabsScreen setDrawerVisible={setDrawerVisible} />}
        </Stack.Screen>
        <Stack.Screen
          name="Metronome"
          component={MetronomeScreen}
          options={{ title: 'Metronome', headerLeft: () => null, ...makeHeaderOptions(colors) }}
        />
        <Stack.Screen
          name="ManualTranspose"
          component={ManualTransposeScreen}
          options={{ title: 'Transpose Chords', headerLeft: () => null, ...makeHeaderOptions(colors) }}
        />
        <Stack.Screen
          name="AudioTools"
          component={AudioToolsScreen}
          options={{ title: 'Audio Tools', headerLeft: () => null, ...makeHeaderOptions(colors) }}
        />
        <Stack.Screen
          name="Tuner"
          component={TunerScreen}
          options={{ title: 'Tuner', headerLeft: () => null, ...makeHeaderOptions(colors) }}
        />
        <Stack.Screen
          name="Pad"
          component={PadScreen}
          options={{ title: 'Pad', headerLeft: () => null, ...makeHeaderOptions(colors) }}
        />
        <Stack.Screen
          name="Calendar"
          component={CalendarScreen}
          options={{ title: 'Team Calendar', headerLeft: () => null, ...makeHeaderOptions(colors) }}
        />
        <Stack.Screen
          name="EditAccount"
          component={EditAccountScreen}
          options={{ title: 'Edit Profile', headerLeft: () => null, ...makeHeaderOptions(colors) }}
        />
      </Stack.Navigator>

      {/* The pad lives out here, above the navigator, so its sound carries on
          while the user moves between screens - which is the only way a pad
          that plays under a song is any use. */}
      <PadEngine />

      {/* Drawer - slides in from the left, slides back out the same way */}
      <Modal
        visible={drawerMounted}
        transparent
        animationType="none"
        onRequestClose={() => setDrawerVisible(false)}
      >
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <Animated.View
            style={{ width: DRAWER_WIDTH, transform: [{ translateX: drawerTranslateX }] }}
          >
            <CustomDrawerContent visible={drawerVisible} onClose={() => setDrawerVisible(false)} />
          </Animated.View>
          <Animated.View style={{ flex: 1, opacity: drawerAnim }}>
            <TouchableOpacity
              style={{ flex: 1, backgroundColor: colors.overlay }}
              activeOpacity={1}
              onPress={() => setDrawerVisible(false)}
            />
          </Animated.View>
        </View>
      </Modal>
    </>
  )
}

// ─── Loading Screen ───────────────────────────────────────────────────────────

function LoadingScreen({ colors }: { colors: AppColors }) {
  return (
    <View style={[loadStyles.root, { backgroundColor: colors.bg }]}>
      <Image
        source={require('./assets/SavedLOGO.png')}
        style={loadStyles.logo}
        resizeMode="contain"
      />
      <View style={[loadStyles.wordmarkRow]}>
        <Text style={[loadStyles.wordmark, { color: colors.text }]}>S A V E D</Text>
        <Text style={[loadStyles.wordmarkLight, { color: colors.textSub }]}>WORSHIP</Text>
      </View>
      <View style={[loadStyles.spinnerWrap, { borderColor: colors.hairline }]}>
        <ActivityIndicator size="small" color={colors.text} />
      </View>
    </View>
  )
}

const loadStyles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 32,
  },
  wordmarkRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  wordmark: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 5,
  },
  wordmarkLight: {
    fontSize: 22,
    fontWeight: '300',
    letterSpacing: 5,
  },
  spinnerWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logo: {
    width: 80,
    height: 80,
    borderRadius: 20,
  },
})

// ─── Root ─────────────────────────────────────────────────────────────────────

function AppContent() {
  const { mode, colors } = useAppTheme()

  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [dbError, setDbError] = useState<string | null>(null)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [dbReady, setDbReady] = useState(false)
  // ── ADDED ─────────────────────────────────────────────────────────────────
  const [showResetPassword, setShowResetPassword] = useState(false)
  // ─────────────────────────────────────────────────────────────────────────
  const periodicSyncCleanupRef = useRef<(() => void) | null>(null)
  const realtimeCleanupRef = useRef<(() => void) | null>(null)
  const syncStartedRef = useRef(false)

  useEffect(() => {
    let isMounted = true

    const splashTimeout = setTimeout(() => {
      if (isMounted) setLoading(false)
    }, 1200)

    void initializeDatabase()
      .then(() => {
        if (isMounted) setDbReady(true)
      })
      .catch((err) => {
        if (!isMounted) return
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        setDbError(errorMsg)
      })

    void (async () => {
      try {
        const authUser = await getCurrentUser()
        if (isMounted) setUser(authUser)
      } catch (err) {
        if (!isMounted) return
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        setDbError(errorMsg)
      } finally {
        if (isMounted) setLoading(false)
      }
    })()

    const unsubscribe = onAuthStateChange(setUser)
    return () => {
      isMounted = false
      clearTimeout(splashTimeout)
      unsubscribe()
    }
  }, [])

  // ── ADDED: Deep link handler for password reset ───────────────────────────
  useEffect(() => {
    const handleDeepLink = (url: string) => {
      if (url.includes('reset-password')) {
        const parsed = Linking.parse(url)
        const access_token = parsed.queryParams?.access_token as string
        const refresh_token = parsed.queryParams?.refresh_token as string

        if (access_token && refresh_token) {
          supabase.auth.setSession({ access_token, refresh_token })
        }

        setShowResetPassword(true)
      }
    }

    // App was closed and opened via the reset link
    Linking.getInitialURL().then(url => {
      if (url) handleDeepLink(url)
    })

    // App was already open when link was tapped
    const sub = Linking.addEventListener('url', ({ url }) => handleDeepLink(url))

    return () => sub.remove()
  }, [])
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!user || !dbReady || user.id === OFFLINE_GUEST_USER_ID) {
      periodicSyncCleanupRef.current?.()
      periodicSyncCleanupRef.current = null
      realtimeCleanupRef.current?.()
      realtimeCleanupRef.current = null
      stopNetworkSync()
      syncStartedRef.current = false  
      return
    }

    if (syncStartedRef.current) return
    syncStartedRef.current = true

    const startSync = async () => {
      try {
        await removeOrphanedUnsyncedRows(user.id)
        await stampUserIdOnUnsyncedRows(user.id)

        const online = await isOnline()
        if (online) {
          fullSync(user.id).catch(err => console.error('Initial sync failed:', err))
          await loadNotificationsFromSupabase(user.id)
        }

        startNetworkSync()

        const syncInterval = setInterval(async () => {
          if (!(await isOnline())) return
          await fullSync(user.id)
        }, 10000)
        periodicSyncCleanupRef.current = () => clearInterval(syncInterval)

        realtimeCleanupRef.current?.()
        realtimeCleanupRef.current = null
        const unsubscribeRealtime = subscribeToChanges(user.id, async () => {
          if (await isOnline()) {
            await loadNotificationsFromSupabase(user.id)
          }
        })
        realtimeCleanupRef.current = unsubscribeRealtime
      } catch (err) {
        console.error('Sync start failed:', err)
        syncStartedRef.current = false
      }
    }

    startSync()

    return () => {
      periodicSyncCleanupRef.current?.()
      periodicSyncCleanupRef.current = null
      realtimeCleanupRef.current?.()
      realtimeCleanupRef.current = null
      stopNetworkSync()
    }
  }, [user, dbReady])

  const navTheme = mode === 'dark'
    ? {
        ...DarkTheme,
        colors: { ...DarkTheme.colors, background: colors.bg, card: colors.header, border: colors.hairline, text: colors.text },
      }
    : {
        ...DefaultTheme,
        colors: { ...DefaultTheme.colors, background: colors.bg, card: colors.header, border: colors.hairline, text: colors.text },
      }

  if (dbError) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />
  }

  if (loading) {
    return <LoadingScreen colors={colors} />
  }

  return (
    <NotificationProvider userId={user?.id ?? null}>
      <View style={{ flex: 1, backgroundColor: colors.header }}>
        <WebOfflineNotice />
        <NavigationContainer
          ref={navigationRef}
          theme={navTheme}
        >
          <StatusBar style={colors.statusBar} />
          {/* ── ADDED: Reset password takes priority over everything ── */}
          {showResetPassword ? (
            <ResetPasswordScreen
              onResetSuccess={() => setShowResetPassword(false)}
            />
          ) : user ? (
            <AppTabs drawerVisible={drawerVisible} setDrawerVisible={setDrawerVisible} />
          ) : (
            <AuthStack />
          )}
          {/* ──────────────────────────────────────────────────────── */}
        </NavigationContainer>
      </View>
    </NotificationProvider>
  )
}

// Alert.alert is an empty function in react-native-web; give it a real one
// before any screen has a chance to call it.
installWebAlert()

export default function App() {
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME_ID)

  // Remembering the choice matters more than it sounds: someone who has set the
  // app to Black for a dark stage does not want it flashing white on next launch.
  useEffect(() => {
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then(stored => { if (isThemeId(stored)) setThemeIdState(stored) })
      .catch(err => console.error('Error loading theme:', err))
  }, [])

  const setThemeId = useCallback((id: ThemeId) => {
    setThemeIdState(id)
    AsyncStorage.setItem(THEME_STORAGE_KEY, id).catch(err =>
      console.error('Error saving theme:', err)
    )
  }, [])

  const theme = getTheme(themeId)

  // The header button flips between families. It returns to the theme last used
  // on the other side rather than a fixed default, so someone who prefers Snow
  // and Black lands back on those instead of Paper and Charcoal every time.
  const lastOfMode = useRef<Record<ThemeMode, ThemeId>>({ dark: 'charcoal', light: 'paper' })
  lastOfMode.current[theme.mode] = themeId

  const toggle = useCallback(() => {
    const target: ThemeMode = getTheme(themeId).mode === 'dark' ? 'light' : 'dark'
    setThemeId(lastOfMode.current[target])
  }, [themeId, setThemeId])

  const value = useMemo(
    () => ({ themeId, mode: theme.mode, colors: theme.colors, setThemeId, toggle }),
    [themeId, theme, setThemeId, toggle]
  )

  return (
    <SafeAreaProvider>
      <ThemeContext.Provider value={value}>
        <AppContent />
      </ThemeContext.Provider>
    </SafeAreaProvider>
  )
}
