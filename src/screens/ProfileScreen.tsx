// Профиль сотрудника: карточка агента, состояние подключений (чат / звонки), сводка по диалогам,
// проверка STUN/TURN (как в calling_v2), настройки Android для надёжных входящих, выход.
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Alert, Linking, Platform, ScrollView, StyleSheet, Text, View} from 'react-native';
import {font, radius, useTheme} from '../theme';
import {Avatar, Badge, Button} from '../components/ui';
import {agentDisplayName} from '../api/auth';
import {useAuth} from '../state/AuthContext';
import {useSupportChat} from '../state/SupportChatContext';
import {checkAllServersStatus, type ServerStatus} from '../voip/diagnostics';
import {getCurrentDeviceId} from '../voip/VoipService';
import {openAndroidBatterySettings} from '../voip/AndroidPowerManager';
import {formatLoyaltyId} from '../utils/format';

export default function ProfileScreen() {
  const {p} = useTheme();
  const {user, logout} = useAuth();
  const {summary, connected} = useSupportChat();
  const [deviceId, setDeviceId] = useState<string | null>(getCurrentDeviceId());
  const [checking, setChecking] = useState(false);
  const [servers, setServers] = useState<ServerStatus[] | null>(null);
  const [iceMode, setIceMode] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setDeviceId(getCurrentDeviceId()), 2000);
    return () => clearInterval(t);
  }, []);

  const name = agentDisplayName(user);

  const check = async () => {
    setChecking(true);
    try {
      const r = await checkAllServersStatus();
      setServers(r.results);
      setIceMode(r.mode);
    } catch (e: any) {
      Alert.alert('Проверка серверов', e?.message || 'Ошибка проверки');
    } finally {
      setChecking(false);
    }
  };

  const confirmLogout = () =>
    Alert.alert(
      'Выйти?',
      'Устройство перестанет получать звонки для этой учётной записи',
      [
        {text: 'Отмена', style: 'cancel'},
        {text: 'Выйти', style: 'destructive', onPress: () => logout()},
      ],
    );

  const card = [styles.card, {backgroundColor: p.surface, borderColor: p.border}];

  return (
    <ScrollView style={{backgroundColor: p.bg}} contentContainerStyle={{padding: 16, gap: 16}}>
      <View style={[card, {flexDirection: 'row', alignItems: 'center', gap: 16}]}>
        <Avatar name={name} size={56} />
        <View style={{flex: 1, gap: 4}}>
          <Text style={[font.sectionTitle, {color: p.textPrimary}]}>{name}</Text>
          {user?.email ? <Text style={[font.caption, {color: p.textTertiary}]}>{user.email}</Text> : null}
          <Text style={[font.caption, {color: p.textTertiary}]} selectable>
            ID <Text style={{color: p.accent, fontWeight: '600'}}>{formatLoyaltyId(user?.loyaltyId)}</Text>
          </Text>
        </View>
        <Badge label="Агент" tone="success" />
      </View>

      <View style={card}>
        <Text style={[font.cardTitle, {color: p.textPrimary, marginBottom: 8}]}>Подключения</Text>
        <Row label="Чат (реальное время)" value={connected ? 'Подключён' : 'Нет соединения'} ok={connected} />
        <Row
          label={Platform.OS === 'ios' ? 'Звонки (VoIP-токен)' : 'Звонки (FCM-токен)'}
          value={deviceId ? 'Устройство зарегистрировано' : 'Регистрация…'}
          ok={!!deviceId}
        />
        {summary ? (
          <>
            <Row label="Ждут ответа" value={String(summary.openCount)} />
            <Row label="Ждут пользователя" value={String(summary.pendingCount)} />
            <Row label="Непрочитанных сообщений" value={String(summary.unreadTotal)} />
          </>
        ) : null}
      </View>

      <View style={card}>
        <Text style={[font.cardTitle, {color: p.textPrimary}]}>Статус STUN/TURN серверов</Text>
        <Text style={[font.caption, {color: p.textTertiary, marginBottom: 12}]}>
          Проверка доступности серверов для WebRTC
          {iceMode ? ` · режим: ${iceMode}` : ''}
        </Text>
        <Button title={checking ? 'Проверка…' : 'Проверить серверы'} kind="secondary" icon="server" onPress={check} disabled={checking} />
        {checking ? <ActivityIndicator style={{marginTop: 12}} color={p.accent} /> : null}
        {servers?.map(s => (
          <View key={s.url} style={[styles.server, {backgroundColor: p.surfaceInset}]}>
            <View style={{flex: 1, gap: 4}}>
              <Text style={{fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, color: p.textPrimary}} numberOfLines={1}>
                {s.url}
              </Text>
              <View style={{flexDirection: 'row', gap: 6, alignItems: 'center'}}>
                <Badge label={s.type.toUpperCase()} />
                {s.latency ? <Text style={[font.caption, {color: p.textTertiary}]}>{s.latency} мс</Text> : null}
              </View>
            </View>
            <Badge
              label={s.status === 'available' ? 'Доступен' : s.status === 'unavailable' ? 'Недоступен' : 'Ошибка'}
              tone={s.status === 'available' ? 'success' : 'error'}
            />
          </View>
        ))}
      </View>

      <View style={card}>
        <Text style={[font.cardTitle, {color: p.textPrimary, marginBottom: 4}]}>Не пропускать звонки</Text>
        <Text style={[font.caption, {color: p.textTertiary, marginBottom: 12}]}>
          {Platform.OS === 'android'
            ? 'Разрешите приложению работать без ограничений батареи и показывать уведомления — так входящие звонки придут, даже когда приложение закрыто.'
            : 'Разрешите уведомления и не выгружайте приложение из памяти в течение смены — входящие звонки приходят через CallKit.'}
        </Text>
        <View style={{gap: 8}}>
          {Platform.OS === 'android' ? (
            <Button title="Настройки батареи" kind="secondary" onPress={openAndroidBatterySettings} />
          ) : null}
          <Button title="Настройки приложения" kind="secondary" onPress={() => Linking.openSettings()} />
        </View>
      </View>

      <Button title="Выйти" kind="danger" icon="logout" onPress={confirmLogout} />
      <Text style={[font.caption, {color: p.textDisabled, textAlign: 'center'}]}>Totus Support · voip.totus.club</Text>
    </ScrollView>
  );
}

function Row({label, value, ok}: {label: string; value: string; ok?: boolean}) {
  const {p} = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[font.body, {color: p.textSecondary, flex: 1}]}>{label}</Text>
      <Text
        style={[
          font.body,
          {color: ok === undefined ? p.textPrimary : ok ? p.success : p.warning, fontWeight: '600'},
        ]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {padding: 16, borderRadius: radius.lg, borderWidth: 1},
  row: {flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 12},
  server: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    marginTop: 10,
  },
});
