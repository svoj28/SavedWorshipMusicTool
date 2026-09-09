import React, { useEffect, useRef , useMemo} from 'react'
import { View, Text, Animated, StyleSheet } from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'

interface ProgressBarProps {
  progress: number // 0–1
  height?: number
  showLabel?: boolean
  label?: string
}

export default function ProgressBar({
  progress,
  height = 3,
  showLabel = false,
  label,
}: ProgressBarProps) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const clampedProgress = Math.max(0, Math.min(1, progress))
  const animatedWidth = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: clampedProgress,
      duration: 400,
      useNativeDriver: false,
    }).start()
  }, [clampedProgress])

  const widthInterpolated = animatedWidth.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  })

  const percent = Math.round(clampedProgress * 100)

  return (
    <View style={styles.wrapper}>
      {showLabel && (
        <View style={styles.labelRow}>
          {label ? (
            <Text style={styles.labelText}>{label}</Text>
          ) : (
            <View />
          )}
          <Text style={styles.percentText}>{percent}%</Text>
        </View>
      )}

      {/* Track */}
      <View style={[styles.track, { height }]}>
        {/* Fill */}
        <Animated.View
          style={[
            styles.fill,
            {
              height,
              width: widthInterpolated,
            },
          ]}
        />

        {/* Shimmer line at leading edge */}
        {clampedProgress > 0 && clampedProgress < 1 && (
          <Animated.View
            style={[
              styles.leadingEdge,
              {
                height,
                left: widthInterpolated,
              },
            ]}
          />
        )}
      </View>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  wrapper: {
    width: '100%',
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  labelText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    color: c.accentText,
    textTransform: 'uppercase',
  },
  percentText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: c.accentText,
  },
  track: {
    width: '100%',
    backgroundColor: c.surface,
    borderRadius: 1,
    overflow: 'visible',
    position: 'relative',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    backgroundColor: c.surface,
    borderRadius: 1,
  },
  leadingEdge: {
    position: 'absolute',
    top: 0,
    width: 2,
    backgroundColor: c.surface,
    borderRadius: 1,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
    elevation: 4,
  },
})