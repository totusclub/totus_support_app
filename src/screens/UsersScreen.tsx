// Пользователи платформы — порт блока «Пользователи» главной страницы calling_v2 (app/page.tsx):
// GET /api/users (обновление каждые 10 с + статус user-status из сокета), звонок по loyaltyId,
// доступ «Доступ / Заблок.» (PATCH /api/users/:id/access), переход в диалог пользователя.
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {font, radius, useTheme} from '../theme';
import {Avatar, Badge, EmptyState, ErrorBanner} from '../components/ui';
import Icon from '../components/Icon';
import {
  getAllUsers,
  getUserDisplayName,
  hasAccess,
  normalizeLoyaltyId,
  updateUserAccess,
  type PlatformUser,
} from '../api/users';
import {chatUserName, findChatForUser, describeSupportError} from '../api/supportChat';
import {onSupportEvent} from '../realtime/supportSocket';
import {useAuth} from '../state/AuthContext';
import {useCall} from '../state/CallContext';
import {formatLoyaltyId} from '../utils/format';
import type {RootStackParamList} from '../navigation/types';

const REFRESH_MS = 10_000;
type Filter = 'all' | 'online' | 'voip';

export default function UsersScreen() {
  const {p} = useTheme();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {user: me} = useAuth();
  const {call} = useCall();
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [opening, setOpening] = useState<number | null>(null);

  const load = useCallback(async (mode: 'initial' | 'silent' | 'pull' = 'silent') => {
    if (mode === 'initial') setLoading(true);
    if (mode === 'pull') setRefreshing(true);
    try {
      const list = await getAllUsers();
      setUsers(list);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить список пользователей');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load('initial');
    const t = setInterval(() => load('silent'), REFRESH_MS);
    const off = onSupportEvent('user-status', ({loyaltyId, online}) => {
      const norm = normalizeLoyaltyId(loyaltyId);
      setUsers(prev => prev.map(u => (normalizeLoyaltyId(u.loyaltyId) === norm ? {...u, online} : u)));
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, [load]);

  const myLoyalty = normalizeLoyaltyId(me?.loyaltyId);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\s+/g, '');
    return users
      .filter(u => normalizeLoyaltyId(u.loyaltyId) !== myLoyalty)
      .filter(u => (filter === 'online' ? u.online : filter === 'voip' ? u.online || u.hasVoipToken : true))
      .filter(u => {
        if (!q) return true;
        return (
          getUserDisplayName(u).toLowerCase().includes(q) ||
          (u.email || '').toLowerCase().includes(q) ||
          (u.phone || '').replace(/\s+/g, '').includes(qDigits) ||
          normalizeLoyaltyId(u.loyaltyId).includes(qDigits)
        );
      })
      .sort((a, b) => Number(b.online) - Number(a.online));
  }, [users, query, filter, myLoyalty]);

  const onlineCount = useMemo(() => users.filter(u => u.online).length, [users]);

  const toggleAccess = async (u: PlatformUser) => {
    const blockNow = hasAccess(u);
    const apply = async () => {
      try {
        await updateUserAccess(u.id, blockNow);
        setUsers(prev => prev.map(x => (x.id === u.id ? {...x, access: blockNow ? 1 : 0} : x)));
      } catch (e: any) {
        Alert.alert('Доступ', e?.message || 'Не удалось обновить доступ');
      }
    };
    if (blockNow) {
      Alert.alert('Заблокировать пользователя?', getUserDisplayName(u), [
        {text: 'Отмена', style: 'cancel'},
        {text: 'Заблокировать', style: 'destructive', onPress: apply},
      ]);
    } else {
      apply();
    }
  };

  const openChat = async (u: PlatformUser) => {
    setOpening(u.id);
    try {
      const chat = await findChatForUser(u);
      if (chat) nav.navigate('Chat', {chatId: chat.id, title: chatUserName(chat)});
      else
        Alert.alert(
          'Диалога нет',
          'Пользователь ещё не писал в поддержку. Диалог создаётся, когда пользователь отправит первое сообщение из приложения или с сайта. Можно позвонить.',
        );
    } catch (e) {
      Alert.alert('Чат', describeSupportError(e));
    } finally {
      setOpening(null);
    }
  };

  const doCall = (u: PlatformUser) => {
    if (!hasAccess(u)) {
      Alert.alert('Звонок', 'Пользователь заблокирован');
      return;
    }
    if (!u.online && !u.hasVoipToken) {
      Alert.alert('Звонок', 'Пользователь не в сети и не может принимать звонки');
      return;
    }
    call({loyaltyId: u.loyaltyId, name: getUserDisplayName(u)});
  };

  const renderItem = ({item: u}: {item: PlatformUser}) => {
    const name = getUserDisplayName(u);
    const access = hasAccess(u);
    const callable = access && (u.online || u.hasVoipToken);
    return (
      <View style={[styles.row, {backgroundColor: p.surface, borderBottomColor: p.border}]}>
        <Avatar name={name} online={u.online} />
        <View style={{flex: 1, minWidth: 0, gap: 4}}>
          <Text numberOfLines={1} style={[font.cardTitle, {color: p.textPrimary}]}>
            {name}
          </Text>
          <Text numberOfLines={2} selectable style={[font.caption, {color: p.textTertiary}]}>
            ID {formatLoyaltyId(u.loyaltyId)}
            {u.phone ? ` • ${u.phone}` : ''}
            {u.email ? ` • ${u.email}` : ''}
          </Text>
          <View style={styles.tags}>
            {u.online ? (
              <Badge label="Онлайн" tone="success" />
            ) : (
              <Badge label={u.hasVoipToken ? 'Офлайн • VoIP' : 'Офлайн'} />
            )}
            <View style={styles.access}>
              <Switch
                value={access}
                onValueChange={() => toggleAccess(u)}
                trackColor={{true: p.success, false: p.error}}
                style={{transform: [{scale: 0.75}]}}
                accessibilityLabel={access ? 'Заблокировать доступ' : 'Открыть доступ'}
              />
              <Text style={[font.small, {color: access ? p.success : p.error}]}>{access ? 'Доступ' : 'Заблок.'}</Text>
            </View>
          </View>
        </View>
        <View style={{gap: 8}}>
          <Pressable
            onPress={() => doCall(u)}
            accessibilityLabel={`Позвонить ${name}`}
            style={[styles.round, {backgroundColor: callable ? p.accent : p.surfaceInset}]}>
            <Icon name="phone" size={18} color={callable ? p.textOnAccent : p.textDisabled} />
          </Pressable>
          <Pressable
            onPress={() => openChat(u)}
            accessibilityLabel={`Открыть чат с ${name}`}
            style={[styles.round, {backgroundColor: p.surfaceInset}]}>
            {opening === u.id ? (
              <ActivityIndicator size="small" color={p.accent} />
            ) : (
              <Icon name="chat" size={18} color={p.textPrimary} />
            )}
          </Pressable>
        </View>
      </View>
    );
  };

  const chips: {key: Filter; label: string}[] = [
    {key: 'all', label: `Все · ${Math.max(0, users.length - (myLoyalty ? 1 : 0))}`},
    {key: 'online', label: `Онлайн · ${onlineCount}`},
    {key: 'voip', label: 'Доступны для звонка'},
  ];

  return (
    <View style={{flex: 1, backgroundColor: p.bg}}>
      <View style={[styles.searchBox, {backgroundColor: p.surfaceInset, borderColor: p.border}]}>
        <Icon name="search" size={18} color={p.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Имя, e-mail, телефон или ID"
          placeholderTextColor={p.textTertiary}
          style={[font.body, {flex: 1, color: p.textPrimary, paddingVertical: 8}]}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      <View style={styles.filters}>
        {chips.map(c => {
          const active = c.key === filter;
          return (
            <Pressable
              key={c.key}
              onPress={() => setFilter(c.key)}
              style={[
                styles.chip,
                {backgroundColor: active ? p.accentSoft : p.surface, borderColor: active ? p.accentBorder : p.border},
              ]}>
              <Text style={[font.small, {color: active ? p.accent : p.textSecondary}]}>{c.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <ErrorBanner text={error} onRetry={() => load('initial')} /> : null}
      {loading && users.length === 0 ? (
        <ActivityIndicator style={{marginTop: 40}} color={p.accent} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={u => String(u.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} tintColor={p.accent} />}
          ListEmptyComponent={<EmptyState icon="users" title="Пользователи не найдены" />}
          contentContainerStyle={visible.length === 0 ? {flexGrow: 1} : undefined}
          initialNumToRender={20}
          windowSize={10}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  filters: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 12},
  chip: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tags: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6},
  access: {flexDirection: 'row', alignItems: 'center', gap: 0},
  round: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
});
