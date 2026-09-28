// Диалог с пользователем — порт правой панели calling_v2 (ChatPane + MessageList + Composer)
// и логики открытого диалога из app/chat/page.tsx:
//   загрузка GET /api/support/chats/:id, история вверх (?before), отправка REST с clientMsgId,
//   отметка прочтения (REST + support:read), support:subscribe/unsubscribe, «печатает…»,
//   действия «Позвонить» / «Взять себе» / «Закрыть», поллинг 10 с как фолбэк без сокета.
import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useFocusEffect, useIsFocused} from '@react-navigation/native';
import {font, radius, useTheme} from '../theme';
import {Avatar, Badge, EmptyState, ErrorBanner, IconButton} from '../components/ui';
import Icon from '../components/Icon';
import {
  assignChat,
  chatStatusLabel,
  chatStatusTone,
  chatUserName,
  describeSupportError,
  getChat,
  getMessages,
  makeClientMsgId,
  markRead,
  orderAdminUrl,
  sendMessage,
  setChatStatus,
  type SupportChat,
  type SupportMessage,
} from '../api/supportChat';
import {emitSupport, onSupportEvent} from '../realtime/supportSocket';
import {useSupportChat} from '../state/SupportChatContext';
import {useAuth} from '../state/AuthContext';
import {useCall} from '../state/CallContext';
import {formatLoyaltyId, formatTime, groupByDay, mergeMessages} from '../utils/format';
import type {RootStackParamList} from '../navigation/types';

const PAGE_SIZE = 50;
const CHAT_POLL_MS = 10_000;
const TYPING_TTL_MS = 6_000;
const TYPING_IDLE_MS = 3_000;
const MAX_LEN = 4000;

type Row = {kind: 'msg'; key: string; m: SupportMessage} | {kind: 'day'; key: string; label: string};

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen({route, navigation}: Props) {
  const chatId = route.params.chatId;
  const {p} = useTheme();
  const insets = useSafeAreaInsets();
  const {user: me} = useAuth();
  const {refreshSummary, setActiveChatId} = useSupportChat();
  const {call} = useCall();

  const [chat, setChat] = useState<SupportChat | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myTypingOn = useRef(false);
  const initialReq = useRef(0);
  const silentReq = useRef(0);
  const initialLoading = useRef(false);
  const isFocused = useIsFocused();
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  /** id последнего сообщения пользователя, которое ещё не отмечено прочитанным. */
  const pendingReadRef = useRef<number | null>(null);

  const mergeChat = useCallback((c: SupportChat) => {
    setChat(prev => ({...(prev || c), ...c, user: c.user || prev?.user || null}));
  }, []);

  const applyRead = useCallback(
    async (lastMessageId?: number | null) => {
      // Отмечаем прочитанным, только когда сотрудник действительно смотрит диалог
      if (!focusedRef.current || AppState.currentState !== 'active') {
        pendingReadRef.current = lastMessageId || pendingReadRef.current || -1;
        return;
      }
      pendingReadRef.current = null;
      try {
        const res = await markRead(chatId, lastMessageId);
        emitSupport('support:read', {chatId, lastMessageId: lastMessageId || undefined});
        if (res?.chat) mergeChat({...res.chat, staffUnread: 0});
        refreshSummary();
      } catch {
        /* прочтение — не критично */
      }
    },
    [chatId, mergeChat, refreshSummary],
  );

  const load = useCallback(
    async (silent = false) => {
      // Тихое обновление не мешает первичной загрузке и не отменяет её
      if (silent && initialLoading.current) return;
      const id = silent ? ++silentReq.current : ++initialReq.current;
      const isCurrent = () => (silent ? id === silentReq.current : id === initialReq.current);
      if (!silent) {
        initialLoading.current = true;
        setLoading(true);
        setError(null);
      }
      try {
        const res = await getChat(chatId, PAGE_SIZE);
        if (!isCurrent()) return;
        mergeChat(res.chat);
        setMessages(prev => (silent ? mergeMessages(prev, res.messages) : res.messages));
        if (!silent) setHasMore(res.hasMore);
        if (res.chat.staffUnread > 0 || !silent) {
          const last = res.messages.length ? res.messages[res.messages.length - 1].id : res.chat.lastMessageId;
          applyRead(last);
        }
      } catch (e) {
        if (!silent && isCurrent()) setError(describeSupportError(e));
      } finally {
        if (!silent && isCurrent()) {
          initialLoading.current = false;
          setLoading(false);
        }
      }
    },
    [chatId, mergeChat, applyRead],
  );

  // Открытие: загрузка, подписка, поллинг; уход — отписка
  useEffect(() => {
    load();
    emitSupport('support:subscribe', {chatId});
    const timer = setInterval(() => load(true), CHAT_POLL_MS);
    return () => {
      clearInterval(timer);
      emitSupport('support:unsubscribe', {chatId});
      if (myTypingOn.current) emitSupport('support:typing', {chatId, typing: false});
    };
  }, [chatId, load]);

  // Активный диалог (для уведомлений) — только пока экран в фокусе;
  // при возврате фокуса / приложения — дочитать отложенное
  useFocusEffect(
    useCallback(() => {
      setActiveChatId(chatId);
      if (pendingReadRef.current !== null) {
        const last = pendingReadRef.current > 0 ? pendingReadRef.current : null;
        applyRead(last);
      }
      return () => setActiveChatId(null);
    }, [chatId, setActiveChatId, applyRead]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && focusedRef.current && pendingReadRef.current !== null) {
        const last = pendingReadRef.current > 0 ? pendingReadRef.current : null;
        applyRead(last);
      }
    });
    return () => sub.remove();
  }, [applyRead]);

  // Realtime
  useEffect(() => {
    const offConn = onSupportEvent('support:connection', ok => {
      if (ok) {
        emitSupport('support:subscribe', {chatId});
        load(true);
      }
    });
    const offMsg = onSupportEvent('support:message', ({chat: c, message}) => {
      if (c.id !== chatId) return;
      setMessages(prev => mergeMessages(prev, [message]));
      mergeChat(c);
      if (message.senderRole === 'user') {
        setTyping(false);
        applyRead(message.id);
      }
    });
    const offUpd = onSupportEvent('support:chat-updated', ({chat: c}) => {
      if (c.id === chatId) mergeChat(c);
    });
    const offRead = onSupportEvent('support:read', ({chatId: id, by, lastMessageId, chat: c}) => {
      if (id !== chatId) return;
      if (c) mergeChat(c);
      if (by === 'user') {
        const now = new Date().toISOString();
        setMessages(prev =>
          prev.map(m =>
            m.senderRole !== 'user' && !m.readAt && (!lastMessageId || m.id <= lastMessageId)
              ? {...m, readAt: now}
              : m,
          ),
        );
      }
    });
    const offTyping = onSupportEvent('support:typing', ({chatId: id, from, typing: on}) => {
      if (from !== 'user' || id !== chatId) return;
      setTyping(on);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (on) typingTimer.current = setTimeout(() => setTyping(false), TYPING_TTL_MS);
    });
    const offStatus = onSupportEvent('user-status', ({loyaltyId, online}) => {
      setChat(prev => {
        if (!prev?.user?.loyaltyId) return prev;
        const a = String(prev.user.loyaltyId).replace(/\s+/g, '');
        const b = String(loyaltyId || '').replace(/\s+/g, '');
        return a === b ? {...prev, user: {...prev.user, online}} : prev;
      });
    });
    return () => {
      offConn();
      offMsg();
      offUpd();
      offRead();
      offTyping();
      offStatus();
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [chatId, load, mergeChat, applyRead]);

  const name = chatUserName(chat);
  const user = chat?.user || null;
  const isMine = !!me && chat?.assignedId === me.id && chat?.assignedRole === 'agent';
  const closed = chat?.status === 'closed';
  const canCall = !!user?.loyaltyId;

  const handleCall = useCallback(() => {
    if (!user?.loyaltyId) return;
    call({loyaltyId: user.loyaltyId, name});
  }, [call, user, name]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name,
      headerRight: () => (
        <View style={{flexDirection: 'row', gap: 4}}>
          <IconButton
            icon="phone"
            accessibilityLabel="Позвонить пользователю"
            color={canCall ? p.accent : p.textDisabled}
            onPress={() =>
              canCall ? handleCall() : Alert.alert('Звонок', 'У пользователя нет loyalty ID')
            }
          />
        </View>
      ),
    });
  }, [navigation, name, canCall, handleCall, p]);

  const loadHistory = async () => {
    if (loadingHistory || !hasMore || messages.length === 0) return;
    setLoadingHistory(true);
    try {
      const res = await getMessages(chatId, {before: messages[0].id, limit: PAGE_SIZE});
      setMessages(prev => mergeMessages(prev, res.messages));
      setHasMore(res.hasMore);
    } catch (e) {
      setError(describeSupportError(e));
    } finally {
      setLoadingHistory(false);
    }
  };

  const stopMyTyping = () => {
    if (myTypingTimer.current) clearTimeout(myTypingTimer.current);
    if (myTypingOn.current) {
      myTypingOn.current = false;
      emitSupport('support:typing', {chatId, typing: false});
    }
  };

  const onChangeDraft = (text: string) => {
    setDraft(text);
    if (sendError) setSendError(null);
    if (!text.trim()) {
      stopMyTyping();
      return;
    }
    if (!myTypingOn.current) {
      myTypingOn.current = true;
      emitSupport('support:typing', {chatId, typing: true});
    }
    if (myTypingTimer.current) clearTimeout(myTypingTimer.current);
    myTypingTimer.current = setTimeout(stopMyTyping, TYPING_IDLE_MS);
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    if (body.length > MAX_LEN) {
      setSendError('Сообщение слишком длинное (до 4000 символов)');
      return;
    }
    setSending(true);
    setSendError(null);
    stopMyTyping();
    try {
      const res = await sendMessage(chatId, body, makeClientMsgId());
      setMessages(prev => mergeMessages(prev, [res.message]));
      mergeChat(res.chat);
      setDraft('');
      refreshSummary();
    } catch (e) {
      setSendError(describeSupportError(e));
    } finally {
      setSending(false);
    }
  };

  const runAction = async (fn: () => Promise<{ok: boolean; chat: SupportChat}>) => {
    setBusy(true);
    try {
      const res = await fn();
      mergeChat(res.chat);
      refreshSummary();
    } catch (e) {
      Alert.alert('Действие не выполнено', describeSupportError(e));
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo<Row[]>(() => {
    const flat: Row[] = [];
    groupByDay(messages).forEach(g => {
      flat.push({kind: 'day', key: `day-${g.key}`, label: g.label});
      g.messages.forEach(m => flat.push({kind: 'msg', key: `m-${m.id}`, m}));
    });
    return flat.reverse(); // inverted FlatList: новые снизу
  }, [messages]);

  const renderRow = ({item}: {item: Row}) => {
    if (item.kind === 'day') {
      return (
        <View style={styles.dayWrap}>
          <Text style={[font.small, styles.day, {color: p.textTertiary, backgroundColor: p.surfaceInset}]}>
            {item.label}
          </Text>
        </View>
      );
    }
    const m = item.m;
    if (m.senderRole === 'system') {
      return (
        <View style={styles.dayWrap}>
          <Text style={[font.caption, {color: p.textTertiary, textAlign: 'center'}]}>{m.body}</Text>
        </View>
      );
    }
    const fromUser = m.senderRole === 'user';
    const bubbleBg = fromUser ? p.bubbleUser : p.bubbleStaff;
    const fg = fromUser ? p.textPrimary : p.textOnAccent;
    const sub = fromUser ? p.textTertiary : 'rgba(255,255,255,0.8)';
    const mineMsg = !fromUser && me && m.senderId === me.id && m.senderRole === 'agent';
    return (
      <View style={[styles.msgRow, {justifyContent: fromUser ? 'flex-start' : 'flex-end'}]}>
        <View style={[styles.bubble, {backgroundColor: bubbleBg}, fromUser ? styles.bubbleIn : styles.bubbleOut]}>
          {!fromUser && !mineMsg && m.senderName ? (
            <Text style={[font.small, {color: sub, marginBottom: 2}]}>{m.senderName}</Text>
          ) : null}
          {m.meta?.orderId ? (
            <Pressable
              onPress={() => Linking.openURL(orderAdminUrl(m.meta!.orderId as string))}
              style={[styles.meta, {borderColor: fromUser ? p.border : 'rgba(255,255,255,0.4)'}]}>
              <Text style={[font.small, {color: fromUser ? p.accent : fg}]}>
                {m.meta.orderTitle || `Заказ № ${m.meta.orderId}`}
              </Text>
              {m.meta.orderSubtitle ? (
                <Text style={[font.caption, {color: sub}]}>{m.meta.orderSubtitle}</Text>
              ) : null}
            </Pressable>
          ) : null}
          {m.meta?.topic ? <Text style={[font.small, {color: sub, marginBottom: 2}]}>Тема: {m.meta.topic}</Text> : null}
          <Text selectable style={[font.body, {color: fg}]}>
            {m.body}
          </Text>
          <View style={styles.msgFoot}>
            <Text style={{color: sub, fontSize: 11}}>{formatTime(m.createdAt)}</Text>
            {!fromUser ? <Icon name={m.readAt ? 'checks' : 'check'} size={14} color={sub} /> : null}
          </View>
        </View>
      </View>
    );
  };

  if (loading && !chat) {
    return (
      <View style={{flex: 1, backgroundColor: p.bg, justifyContent: 'center'}}>
        <ActivityIndicator color={p.accent} />
      </View>
    );
  }
  if (!chat) {
    return (
      <View style={{flex: 1, backgroundColor: p.bg}}>
        <EmptyState title={error || 'Диалог не найден'} />
      </View>
    );
  }

  const contacts: string[] = [];
  if (user?.phone) contacts.push(user.phone);
  if (user?.email) contacts.push(user.email);
  if (user?.loyaltyId) contacts.push(`ID ${formatLoyaltyId(user.loyaltyId)}`);

  return (
    <KeyboardAvoidingView
      style={{flex: 1, backgroundColor: p.bg}}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      {/* Шапка диалога */}
      <View style={[styles.header, {backgroundColor: p.surface, borderBottomColor: p.border}]}>
        <View style={{flexDirection: 'row', gap: 12, alignItems: 'center'}}>
          <Avatar name={name} online={user?.online} />
          <View style={{flex: 1, gap: 4}}>
            <View style={styles.tags}>
              <Badge label={chatStatusLabel(chat.status)} tone={chatStatusTone(chat.status)} />
              <Badge label={user?.online ? 'Онлайн' : 'Офлайн'} tone={user?.online ? 'success' : 'neutral'} />
              {chat.assignedName ? (
                <Badge label={isMine ? 'Ваш диалог' : `Ведёт: ${chat.assignedName}`} />
              ) : null}
            </View>
            {contacts.length ? (
              <Text style={[font.caption, {color: p.textTertiary}]} selectable numberOfLines={2}>
                {contacts.join(' • ')}
              </Text>
            ) : null}
            {chat.orderId ? (
              <Text
                style={[font.caption, {color: p.accent}]}
                onPress={() => Linking.openURL(orderAdminUrl(chat.orderId as string))}>
                Заказ № {chat.orderId}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={styles.actions}>
          <ActionChip
            icon="phone"
            label="Позвонить"
            onPress={handleCall}
            disabled={!canCall}
            primary
          />
          <ActionChip
            icon="user"
            label={isMine ? 'Снять' : 'Взять себе'}
            onPress={() => runAction(() => assignChat(chatId, isMine))}
            disabled={busy}
          />
          <ActionChip
            icon={closed ? 'refresh' : 'close'}
            label={closed ? 'Открыть заново' : 'Закрыть'}
            onPress={() => runAction(() => setChatStatus(chatId, closed ? 'open' : 'closed'))}
            disabled={busy}
            danger={!closed}
          />
        </View>
      </View>

      {error ? <ErrorBanner text={error} onRetry={() => load()} /> : null}

      <FlatList
        style={{flex: 1}}
        data={rows}
        inverted
        keyExtractor={r => r.key}
        renderItem={renderRow}
        onEndReached={loadHistory}
        onEndReachedThreshold={0.3}
        contentContainerStyle={{paddingVertical: 12}}
        ListHeaderComponent={
          typing ? (
            <Text style={[font.caption, {color: p.textTertiary, paddingHorizontal: 16, paddingVertical: 4}]}>
              {name} печатает…
            </Text>
          ) : null
        }
        ListFooterComponent={
          loadingHistory ? (
            <ActivityIndicator style={{margin: 12}} color={p.accent} />
          ) : hasMore ? (
            <Pressable onPress={loadHistory} style={{padding: 12, alignItems: 'center'}}>
              <Text style={[font.small, {color: p.accent}]}>Показать ранние сообщения</Text>
            </Pressable>
          ) : null
        }
      />

      {closed ? (
        <Text
          style={[
            font.caption,
            {color: p.textTertiary, backgroundColor: p.surfaceInset, paddingHorizontal: 16, paddingVertical: 8},
          ]}>
          Диалог закрыт. Ваш ответ переведёт его в «Ждёт пользователя», новое сообщение пользователя откроет заново.
        </Text>
      ) : null}

      {sendError ? <ErrorBanner text={sendError} /> : null}

      <View
        style={[
          styles.composer,
          {borderTopColor: p.border, backgroundColor: p.surface, paddingBottom: Math.max(insets.bottom, 8)},
        ]}>
        <TextInput
          value={draft}
          onChangeText={onChangeDraft}
          placeholder="Ответ пользователю…"
          placeholderTextColor={p.textTertiary}
          multiline
          maxLength={MAX_LEN + 100}
          style={[
            font.body,
            styles.input,
            {color: p.textPrimary, backgroundColor: p.surfaceInset, borderColor: p.border},
          ]}
        />
        <Pressable
          onPress={send}
          disabled={!draft.trim() || sending}
          accessibilityLabel="Отправить"
          style={[styles.sendBtn, {backgroundColor: draft.trim() ? p.accent : p.surfaceInset}]}>
          {sending ? (
            <ActivityIndicator color={p.textOnAccent} size="small" />
          ) : (
            <Icon name="send" size={20} color={draft.trim() ? p.textOnAccent : p.textDisabled} />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function ActionChip({
  icon,
  label,
  onPress,
  disabled,
  primary,
  danger,
}: {
  icon: 'phone' | 'user' | 'close' | 'refresh';
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const {p} = useTheme();
  const bg = disabled ? p.surfaceInset : primary ? p.accent : danger ? p.errorSoft : p.surface;
  const fg = disabled ? p.textDisabled : primary ? p.textOnAccent : danger ? p.error : p.textPrimary;
  const border = primary || danger || disabled ? 'transparent' : p.border;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({pressed}) => [
        styles.chip,
        {backgroundColor: bg, borderColor: border, opacity: pressed ? 0.8 : 1},
      ]}>
      <Icon name={icon} size={16} color={fg} />
      <Text style={[font.small, {color: fg}]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {padding: 16, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth},
  tags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  dayWrap: {alignItems: 'center', paddingVertical: 8, paddingHorizontal: 16},
  day: {paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden'},
  msgRow: {flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 3},
  bubble: {maxWidth: '82%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.lg},
  bubbleIn: {borderBottomLeftRadius: 4},
  bubbleOut: {borderBottomRightRadius: 4},
  msgFoot: {flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 2},
  meta: {borderWidth: 1, borderRadius: radius.sm, padding: 8, marginBottom: 6},
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 42,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
  },
  sendBtn: {width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center'},
});
