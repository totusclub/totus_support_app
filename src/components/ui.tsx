// Базовые примитивы интерфейса на токенах дизайн-системы (src/theme).
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {font, radius, toneColors, useTheme, type Tone} from '../theme';
import {initialOf} from '../utils/format';
import Icon, {type IconName} from './Icon';

export function Avatar({name, size = 44, online}: {name: string | null | undefined; size?: number; online?: boolean}) {
  const {p} = useTheme();
  return (
    <View style={{width: size, height: size}}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: p.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Text style={{color: p.accent, fontSize: Math.round(size * 0.4), fontWeight: '600'}}>{initialOf(name)}</Text>
      </View>
      {online ? (
        <View
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: Math.max(10, size * 0.27),
            height: Math.max(10, size * 0.27),
            borderRadius: 20,
            backgroundColor: p.success,
            borderWidth: 2,
            borderColor: p.surface,
          }}
        />
      ) : null}
    </View>
  );
}

export function Badge({label, tone = 'neutral'}: {label: string; tone?: Tone}) {
  const {p} = useTheme();
  const c = toneColors(p, tone);
  return (
    <View style={{backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3}}>
      <Text style={[font.small, {color: c.fg}]}>{label}</Text>
    </View>
  );
}

export function CountBadge({count}: {count: number}) {
  const {p} = useTheme();
  if (!count) return null;
  return (
    <View
      style={{
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: 10,
        backgroundColor: p.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={{color: p.textOnAccent, fontSize: 12, fontWeight: '700'}}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  kind = 'primary',
  icon,
  disabled,
  loading,
  small,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: ButtonKind;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const {p} = useTheme();
  const palette: Record<ButtonKind, {bg: string; fg: string; border: string}> = {
    primary: {bg: p.accent, fg: p.textOnAccent, border: 'transparent'},
    secondary: {bg: p.surface, fg: p.textPrimary, border: p.border},
    danger: {bg: p.errorSoft, fg: p.error, border: 'transparent'},
    ghost: {bg: 'transparent', fg: p.textSecondary, border: 'transparent'},
  };
  const c = disabled
    ? {bg: p.surfaceInset, fg: p.textDisabled, border: 'transparent'}
    : palette[kind];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({pressed}) => [
        styles.button,
        {
          backgroundColor: c.bg,
          borderColor: c.border,
          paddingVertical: small ? 7 : 12,
          paddingHorizontal: small ? 12 : 18,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={c.fg} size="small" />
      ) : (
        <>
          {icon ? <Icon name={icon} size={small ? 16 : 18} color={c.fg} /> : null}
          <Text style={{color: c.fg, fontSize: small ? 13 : 15, fontWeight: '600'}}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  color,
  size = 22,
  accessibilityLabel,
}: {
  icon: IconName;
  onPress: () => void;
  color?: string;
  size?: number;
  accessibilityLabel: string;
}) {
  const {p} = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={10}
      style={({pressed}) => ({padding: 6, opacity: pressed ? 0.6 : 1})}>
      <Icon name={icon} size={size} color={color || p.textPrimary} />
    </Pressable>
  );
}

export function EmptyState({icon = 'chat', title, hint}: {icon?: IconName; title: string; hint?: string}) {
  const {p} = useTheme();
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={40} color={p.textTertiary} />
      <Text style={[font.cardTitle, {color: p.textSecondary, textAlign: 'center'}]}>{title}</Text>
      {hint ? <Text style={[font.caption, {color: p.textTertiary, textAlign: 'center'}]}>{hint}</Text> : null}
    </View>
  );
}

export function ErrorBanner({text, onRetry}: {text: string; onRetry?: () => void}) {
  const {p} = useTheme();
  return (
    <View style={[styles.banner, {backgroundColor: p.errorSoft}]}>
      <Text style={[font.caption, {color: p.error, flex: 1}]}>{text}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={[font.small, {color: p.error}]}>Повторить</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ConnectionBar({connected}: {connected: boolean}) {
  const {p} = useTheme();
  if (connected) return null;
  return (
    <View style={[styles.banner, {backgroundColor: p.warningSoft}]}>
      <ActivityIndicator size="small" color={p.warning} />
      <Text style={[font.caption, {color: p.warning, flex: 1}]}>
        Нет соединения в реальном времени — обновляем по таймеру
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32},
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
});
