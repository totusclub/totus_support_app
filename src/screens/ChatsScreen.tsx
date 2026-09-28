// Список диалогов поддержки — порт левой колонки calling_v2/app/chat/page.tsx + DialogList.
// Данные: GET /api/support/chats (непрочитанные — первыми), realtime: support:message /
// support:chat-updated / support:read, фолбэк — поллинг каждые 30 с.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {font, radius, useTheme} from '../theme';
import {Avatar, Badge, ConnectionBar, CountBadge, EmptyState, ErrorBanner} from '../components/ui';
import Icon from '../components/Icon';
import {
  chatStatusLabel,
  chatStatusTone,
  chatUserName,
  describeSupportError,
  listChats,
  type ListChatsParams,
  type SupportChat,
} from '../api/supportChat';
import {onSupportEvent} from '../realtime/supportSocket';
import {useSupportChat} from '../state/SupportChatContext';
import {useAuth} from '../state/AuthContext';
import {listTime} from '../utils/format';
import type {RootStackParamList} from '../navigation/types';

type Filter = 'all' | 'open' | 'pending' | 'mine' | 'closed';

const FILTERS: {key: Filter; label: string}[] = [
  {key: 'all', label: 'Все'},
  {key: 'open', label: 'Ждут ответа'},
  {key: 'pending', label: 'Ждут пользователя'},
  {key: 'mine', label: 'Мои'},
  {key: 'closed', label: 'Закрытые'},
];

const PAGE_SIZE = 50;
const LIST_POLL_MS = 30_000;

export default function ChatsScreen() {
  const {p} = useTheme();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {summary, connected} = useSupportChat();
  const {user: me} = useAuth();
  const myId = me?.id ?? null;

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [chats, setChats] = useState<SupportChat[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const params = useCallback(
    (offset: number): ListChatsParams => ({
      status: filter === 'mine' ? 'all' : filter,
      assigned: filter === 'mine' ? 'me' : undefined,
      q: debounced || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [filter, debounced],
  );

  const load = useCallback(
    async (mode: 'initial' | 'silent' | 'pull' = 'initial') => {
      const id = ++reqRef.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'pull') setRefreshing(true);
      try {
        const res = await listChats(params(0));
        if (id !== reqRef.current) return;
        setChats(prev => {
          if (mode !== 'silent' || prev.length <= res.data.length) return res.data;
          const ids = new Set(res.data.map(c => c.id));
          return [...res.data, ...prev.slice(res.data.length).filter(c => !ids.has(c.id))];
        });
        setTotal(res.total);
        setError(null);
      } catch (e) {
        if (id === reqRef.current) setError(describeSupportError(e));
      } finally {
        if (id === reqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [params],
  );

  useEffect(() => {
    load('initial');
    const timer = setInterval(() => load('silent'), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const loadMore = async () => {
    if (loadingMore || loading || chats.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await listChats(params(chats.length));
      setChats(prev => {
        const ids = new Set(prev.map(c => c.id));
        return [...prev, ...res.data.filter(c => !ids.has(c.id))];
      });
      setTotal(res.total);
    } catch (e) {
      setError(describeSupportError(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const matchesFilter = useCallback(
    (c: SupportChat) => {
      if (filter === 'open' || filter === 'pending' || filter === 'closed') return c.status === filter;
      if (filter === 'mine') return myId !== null && c.assignedId === myId && c.assignedRole === 'agent';
      return true;
    },
    [filter, myId],
  );

  const upsert = useCallback(
    (chat: SupportChat, toTop = false) => {
      setChats(prev => {
        const idx = prev.findIndex(c => c.id === chat.id);
        if (idx === -1) {
          if (!toTop || !matchesFilter(chat) || debounced) return prev;
          return [chat, ...prev];
        }
        const merged = {...prev[idx], ...chat, user: chat.user || prev[idx].user};
        if (!matchesFilter(merged)) return prev.filter(c => c.id !== chat.id);
        if (!toTop) {
          const next = prev.slice();
          next[idx] = merged;
          return next;
        }
        return [merged, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
    },
    [matchesFilter, debounced],
  );

  useEffect(() => {
    const offMsg = onSupportEvent('support:message', ({chat}) => upsert(chat, true));
    const offUpd = onSupportEvent('support:chat-updated', ({chat}) => upsert(chat));
    const offRead = onSupportEvent('support:read', ({chat}) => chat && upsert(chat));
    const offConn = onSupportEvent('support:connection', ok => ok && load('silent'));
    const offStatus = onSupportEvent('user-status', ({loyaltyId, online}) => {
      const norm = String(loyaltyId || '').replace(/\s+/g, '');
      setChats(prev =>
        prev.map(c =>
          c.user && String(c.user.loyaltyId || '').replace(/\s+/g, '') === norm
            ? {...c, user: {...c.user, online}}
            : c,
        ),
      );
    });
    return () => {
      offMsg();
      offUpd();
      offRead();
      offConn();
      offStatus();
    };
  }, [upsert, load]);

  const renderItem = ({item}: {item: SupportChat}) => {
    const name = chatUserName(item);
    const unread = item.staffUnread > 0;
    return (
      <Pressable
        onPress={() => nav.navigate('Chat', {chatId: item.id, title: name})}
        style={({pressed}) => [
          styles.row,
          {backgroundColor: pressed ? p.surfaceHover : p.surface, borderBottomColor: p.border},
        ]}>
        <Avatar name={name} online={item.user?.online} />
        <View style={{flex: 1, minWidth: 0, gap: 3}}>
          <View style={styles.rowTop}>
            <Text
              numberOfLines={1}
              style={[font.cardTitle, {color: p.textPrimary, flex: 1, fontWeight: unread ? '700' : '600'}]}>
              {name}
            </Text>
            <Text style={[font.caption, {color: unread ? p.accent : p.textTertiary}]}>
              {listTime(item.lastMessageAt)}
            </Text>
          </View>
          <View style={styles.rowTop}>
            <Text
              numberOfLines={2}
              style={[font.caption, {color: unread ? p.textPrimary : p.textTertiary, flex: 1}]}>
              {item.lastMessagePreview || 'Нет сообщений'}
            </Text>
            <CountBadge count={item.staffUnread} />
          </View>
          <View style={styles.tags}>
            <Badge label={chatStatusLabel(item.status)} tone={chatStatusTone(item.status)} />
            {item.orderId ? <Badge label={`Заказ № ${item.orderId}`} tone="info" /> : null}
            {item.assignedName ? <Badge label={item.assignedName} /> : null}
          </View>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={{flex: 1, backgroundColor: p.bg}}>
      <ConnectionBar connected={connected} />
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
          clearButtonMode="while-editing"
        />
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {FILTERS.map(f => {
            const active = f.key === filter;
            const count =
              f.key === 'open' ? summary?.openCount : f.key === 'pending' ? summary?.pendingCount : undefined;
            return (
              <Pressable
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? p.accentSoft : p.surface,
                    borderColor: active ? p.accentBorder : p.border,
                  },
                ]}>
                <Text style={[font.small, {color: active ? p.accent : p.textSecondary}]}>
                  {f.label}
                  {count ? ` · ${count}` : ''}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      {error ? <ErrorBanner text={error} onRetry={() => load('initial')} /> : null}
      {loading && chats.length === 0 ? (
        <ActivityIndicator style={{marginTop: 40}} color={p.accent} />
      ) : (
        <FlatList
          data={chats}
          keyExtractor={c => String(c.id)}
          renderItem={renderItem}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load('pull')} tintColor={p.accent} />
          }
          ListEmptyComponent={
            <EmptyState
              title={debounced ? 'Ничего не найдено' : 'Диалогов нет'}
              hint={debounced ? 'Попробуйте другой запрос' : 'Новые обращения пользователей появятся здесь'}
            />
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator style={{margin: 16}} color={p.accent} /> : null}
          contentContainerStyle={chats.length === 0 ? {flexGrow: 1} : undefined}
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
  filters: {paddingHorizontal: 16, paddingVertical: 12, gap: 8},
  chip: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1},
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  tags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2},
});
