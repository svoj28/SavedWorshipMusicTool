import { createContext, useContext } from 'react'

export type ThemeMode = 'light' | 'dark'
export type ThemeId = 'paper' | 'charcoal' | 'midnight' | 'sunset' | 'forest'

export type AppColors = {
  bg: string
  text: string
  textSub: string
  textMuted: string
  header: string
  surface: string
  surfaceAlt: string
  surfaceMuted: string
  card: string
  panel: string
  border: string
  hairline: string
  overlay: string
  tabBar: string
  accent: string
  accentText: string
  icon: string
  iconInactive: string
  primary: string
  secondary: string
  success: string
  successBg: string
  danger: string
  dangerBg: string
  warning: string
  warningBg: string
  info: string
  infoBg: string
  shadow: string
  statusBar: 'dark' | 'light'
}

export type AppTheme = {
  id: ThemeId
  name: string
  description: string
  mode: ThemeMode
  colors: AppColors
}

export type AppThemeValue = {
  themeId: ThemeId
  mode: ThemeMode
  colors: AppColors
  setThemeId: (id: ThemeId) => void
  toggle: () => void
}

export const DEFAULT_THEME_ID: ThemeId = 'paper'
export const THEME_STORAGE_KEY = 'saved-worship-theme-id'

export const THEMES: AppTheme[] = [
  {
    id: 'paper',
    name: 'Paper',
    description: 'Warm neutral tones for everyday worship planning.',
    mode: 'light',
    colors: {
      bg: '#F6F3EE',
      text: '#1C1C1E',
      textSub: '#6F7168',
      textMuted: '#8A877F',
      header: '#FBF9F4',
      surface: '#FFFDFB',
      surfaceAlt: '#F0EDE8',
      surfaceMuted: '#EAE3D9',
      card: '#FFFDFB',
      panel: '#F9F6F3',
      border: '#DDD5CB',
      hairline: '#E7E1D6',
      overlay: 'rgba(18, 16, 14, 0.36)',
      tabBar: '#F8F5F2',
      accent: '#B2714D',
      accentText: '#FFF9F2',
      icon: '#3F3B38',
      iconInactive: '#7E796F',
      primary: '#5C79A3',
      secondary: '#B2714D',
      success: '#4E8E6F',
      successBg: '#E8F4ED',
      danger: '#C35D4D',
      dangerBg: '#FBEAE8',
      warning: '#C98A38',
      warningBg: '#F9F0DB',
      info: '#5A7AA5',
      infoBg: '#EAF1F8',
      shadow: 'rgba(16, 15, 13, 0.12)',
      statusBar: 'dark',
    },
  },
  {
    id: 'charcoal',
    name: 'Charcoal',
    description: 'Balanced dark contrast for stage and evening use.',
    mode: 'dark',
    colors: {
      bg: '#171A1C',
      text: '#F2F5F7',
      textSub: '#B9C4CB',
      textMuted: '#8E9AA3',
      header: '#1E2327',
      surface: '#232A2F',
      surfaceAlt: '#1A2024',
      surfaceMuted: '#2A3238',
      card: '#1F2529',
      panel: '#20262B',
      border: '#3A434C',
      hairline: '#2F393F',
      overlay: 'rgba(4, 7, 9, 0.46)',
      tabBar: '#1B1F23',
      accent: '#7CC8FF',
      accentText: '#07151F',
      icon: '#E2EAEE',
      iconInactive: '#8F9BA3',
      primary: '#8AB7FF',
      secondary: '#7CC8FF',
      success: '#63C79B',
      successBg: '#1A312A',
      danger: '#F08E82',
      dangerBg: '#3A2220',
      warning: '#EDB55A',
      warningBg: '#382F20',
      info: '#8BB8F2',
      infoBg: '#1A2940',
      shadow: 'rgba(0, 0, 0, 0.28)',
      statusBar: 'light',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep blue-tinted dark mode for late-night sessions.',
    mode: 'dark',
    colors: {
      bg: '#0B1020',
      text: '#EAF2FF',
      textSub: '#A5B8D6',
      textMuted: '#8191B0',
      header: '#111A2C',
      surface: '#121D33',
      surfaceAlt: '#0F1830',
      surfaceMuted: '#1C2944',
      card: '#101B2E',
      panel: '#131D30',
      border: '#2B3B5A',
      hairline: '#1D2A42',
      overlay: 'rgba(3, 7, 14, 0.52)',
      tabBar: '#111B2D',
      accent: '#7CB8FF',
      accentText: '#061321',
      icon: '#EAF2FF',
      iconInactive: '#8BA0C7',
      primary: '#7CB8FF',
      secondary: '#8BD1C4',
      success: '#58C28D',
      successBg: '#112B23',
      danger: '#F0887A',
      dangerBg: '#311F1F',
      warning: '#EDB75E',
      warningBg: '#352C1E',
      info: '#8CB4F0',
      infoBg: '#182A42',
      shadow: 'rgba(0, 0, 0, 0.3)',
      statusBar: 'light',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm sunset hues for cozy worship planning.',
    mode: 'dark',
    colors: {
      bg: '#1D1412',
      text: '#FFF1EA',
      textSub: '#E7BDA5',
      textMuted: '#C58E78',
      header: '#2B1B18',
      surface: '#35221D',
      surfaceAlt: '#261815',
      surfaceMuted: '#4A2E2A',
      card: '#2E201D',
      panel: '#2F211D',
      border: '#623F38',
      hairline: '#4D312D',
      overlay: 'rgba(24, 12, 10, 0.5)',
      tabBar: '#2A1C18',
      accent: '#FF9C6B',
      accentText: '#2A110B',
      icon: '#FFECE1',
      iconInactive: '#D7A086',
      primary: '#FFB183',
      secondary: '#FF7D6A',
      success: '#70C39D',
      successBg: '#1E352E',
      danger: '#F38B8A',
      dangerBg: '#3D2323',
      warning: '#F0C264',
      warningBg: '#43301D',
      info: '#F8B489',
      infoBg: '#49372D',
      shadow: 'rgba(0, 0, 0, 0.28)',
      statusBar: 'light',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Earthy greens for a calm, grounded vibe.',
    mode: 'dark',
    colors: {
      bg: '#111915',
      text: '#F2F7F1',
      textSub: '#C7D9CC',
      textMuted: '#9EB6A5',
      header: '#17231D',
      surface: '#1B2C24',
      surfaceAlt: '#14221A',
      surfaceMuted: '#263D35',
      card: '#182820',
      panel: '#1B2C24',
      border: '#365347',
      hairline: '#243C34',
      overlay: 'rgba(10, 18, 15, 0.46)',
      tabBar: '#16241F',
      accent: '#86D39B',
      accentText: '#0A1711',
      icon: '#F2F7F1',
      iconInactive: '#A0B9A8',
      primary: '#8BD6A9',
      secondary: '#A1D8B7',
      success: '#67C38E',
      successBg: '#1B3328',
      danger: '#E68E7C',
      dangerBg: '#362722',
      warning: '#E0BE64',
      warningBg: '#352F20',
      info: '#99CDB5',
      infoBg: '#1E352F',
      shadow: 'rgba(0, 0, 0, 0.28)',
      statusBar: 'light',
    },
  },
]

const THEME_MAP: Record<ThemeId, AppTheme> = THEMES.reduce((acc, theme) => {
  acc[theme.id] = theme
  return acc
}, {} as Record<ThemeId, AppTheme>)

export const ThemeContext = createContext<AppThemeValue | undefined>(undefined)

export function getTheme(id: ThemeId): AppTheme {
  return THEME_MAP[id] ?? THEME_MAP[DEFAULT_THEME_ID]
}

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return typeof value === 'string' && value in THEME_MAP
}

export function themesOfMode(mode: ThemeMode): AppTheme[] {
  return THEMES.filter(theme => theme.mode === mode)
}

export function useAppTheme(): AppThemeValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useAppTheme must be used within a ThemeContext.Provider')
  }
  return context
}
