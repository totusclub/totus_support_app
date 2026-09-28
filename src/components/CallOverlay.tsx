// Экран звонка (порт calling_v2/components/CallModal.tsx) + свёрнутая плашка звонка.
// Входящий: «Отклонить» / «Ответить»; исходящий и разговор: микрофон, динамик, «Завершить».
// На iOS параллельно работает системный CallKit, на Android — CallKeep ConnectionService.
import React from 'react';
import {Modal, Pressable, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {font, radius, toneColors, useTheme} from '../theme';
import {Avatar} from './ui';
import Icon, {type IconName} from './Icon';
import {useCall} from '../state/CallContext';
import {formatDuration, formatLoyaltyId} from '../utils/format';

function stateText(state: string, connection: string | null): string {
  switch (state) {
    case 'calling':
      return 'Вызов…';
    case 'ringing':
      return 'Входящий звонок';
    case 'answered':
      return connection === 'reconnecting' ? 'Восстанавливаем связь…' : 'Разговор';
    case 'ended':
      return 'Звонок завершён';
    case 'rejected':
      return 'Звонок отклонён';
    default:
      return 'Звонок завершён';
  }
}

function RoundButton({
  icon,
  label,
  onPress,
  bg,
  fg,
  size = 64,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  bg: string;
  fg: string;
  size?: number;
}) {
  const {p} = useTheme();
  return (
    <View style={{alignItems: 'center', gap: 8, width: 88}}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({pressed}) => ({
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.8 : 1,
        })}>
        <Icon name={icon} size={Math.round(size * 0.4)} color={fg} />
      </Pressable>
      <Text style={[font.caption, {color: p.textSecondary, textAlign: 'center'}]}>{label}</Text>
    </View>
  );
}

export default function CallOverlay() {
  const {p, isDark} = useTheme();
  const insets = useSafeAreaInsets();
  const c = useCall();
  const active = c.state !== 'idle';

  const isRinging = c.state === 'ringing';
  const isCalling = c.state === 'calling';
  const isAnswered = c.state === 'answered';
  const tone = isCalling ? 'accent' : isRinging || isAnswered ? 'success' : c.state === 'rejected' ? 'error' : 'neutral';
  const badge = toneColors(p, tone);
  const label = isRinging ? 'Вам звонят' : isCalling ? 'Вызываете' : 'Звонок';

  return (
    <>
      {/* Свёрнутый звонок */}
      {active && !c.screenVisible ? (
        <Pressable
          onPress={c.showScreen}
          style={[
            styles.mini,
            {top: insets.top + 6, backgroundColor: isAnswered || isRinging ? p.success : p.accent},
          ]}>
          <Icon name="phone" size={16} color="#fff" />
          <Text style={styles.miniText} numberOfLines={1}>
            {c.callerName || 'Звонок'}
            {isAnswered && c.startedAt ? ` · ${formatDuration(c.seconds)}` : isRinging ? ' · входящий' : ' · вызов…'}
          </Text>
          <Text style={styles.miniText}>Открыть</Text>
        </Pressable>
      ) : null}

      <Modal visible={c.screenVisible} animationType="slide" onRequestClose={c.hideScreen}>
        <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
        <SafeAreaView style={{flex: 1, backgroundColor: p.bg}}>
          <View style={styles.top}>
            <Pressable
              onPress={c.hideScreen}
              accessibilityLabel="Свернуть"
              style={[styles.minimize, {backgroundColor: p.surfaceInset, borderColor: p.border}]}>
              <Icon name="minimize" size={18} color={p.textTertiary} />
            </Pressable>
          </View>

          <View style={styles.center}>
            <Avatar name={c.callerName || '?'} size={112} />
            <Text style={[font.small, {color: p.textTertiary, letterSpacing: 1.2, marginTop: 24}]}>
              {label.toUpperCase()}
            </Text>
            <Text style={[styles.name, {color: p.textPrimary}]} numberOfLines={2}>
              {c.callerName || 'Неизвестный'}
            </Text>
            {c.peerLoyaltyId ? (
              <Text style={[font.caption, {color: p.textTertiary}]}>ID {formatLoyaltyId(c.peerLoyaltyId)}</Text>
            ) : null}
            <View style={[styles.stateBadge, {backgroundColor: badge.bg}]}>
              <Text style={[font.small, {color: badge.fg}]}>{stateText(c.state, c.connectionState)}</Text>
            </View>
            {isAnswered && c.startedAt ? (
              <Text style={[styles.timer, {color: p.accent}]}>{formatDuration(c.seconds)}</Text>
            ) : null}
          </View>

          <View style={[styles.controls, {paddingBottom: Math.max(insets.bottom, 24)}]}>
            {(isAnswered || isCalling) && (
              <View style={styles.row}>
                <RoundButton
                  icon={c.isMuted ? 'micOff' : 'mic'}
                  label={c.isMuted ? 'Микрофон выкл.' : 'Микрофон'}
                  onPress={c.mute}
                  bg={c.isMuted ? p.errorSoft : p.surfaceInset}
                  fg={c.isMuted ? p.error : p.textPrimary}
                />
                <RoundButton
                  icon="volume"
                  label={c.speakerOn ? 'Динамик вкл.' : 'Динамик'}
                  onPress={c.speaker}
                  bg={c.speakerOn ? p.infoSoft : p.surfaceInset}
                  fg={c.speakerOn ? p.info : p.textPrimary}
                />
              </View>
            )}
            <View style={styles.row}>
              {isRinging ? (
                <>
                  <RoundButton icon="phoneOff" label="Отклонить" onPress={c.reject} bg={p.error} fg="#fff" size={72} />
                  <RoundButton icon="phone" label="Ответить" onPress={c.answer} bg={p.success} fg="#fff" size={72} />
                </>
              ) : isAnswered || isCalling ? (
                <RoundButton icon="phoneOff" label="Завершить" onPress={c.hangup} bg={p.error} fg="#fff" size={72} />
              ) : (
                <Pressable
                  onPress={c.hideScreen}
                  style={[styles.close, {borderColor: p.border, backgroundColor: p.surface}]}>
                  <Text style={[font.cardTitle, {color: p.textPrimary}]}>Закрыть</Text>
                </Pressable>
              )}
            </View>
          </View>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  mini: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 1000,
    elevation: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.pill,
  },
  miniText: {color: '#fff', fontWeight: '600', fontSize: 14, flexShrink: 1},
  top: {flexDirection: 'row', justifyContent: 'flex-end', padding: 16},
  minimize: {width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 8},
  name: {fontSize: 28, lineHeight: 34, fontWeight: '600', textAlign: 'center'},
  stateBadge: {paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill, marginTop: 4},
  timer: {fontSize: 40, fontWeight: '600', letterSpacing: 2, marginTop: 12, fontVariant: ['tabular-nums']},
  controls: {gap: 28, paddingHorizontal: 24},
  row: {flexDirection: 'row', justifyContent: 'center', gap: 32},
  close: {paddingHorizontal: 32, paddingVertical: 14, borderRadius: radius.sm, borderWidth: 1},
});
