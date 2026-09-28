// История звонков сотрудника (журнал на устройстве — см. src/history/callHistory.ts):
// входящие / исходящие / пропущенные, длительность, «перезвонить», переход в диалог.
import React, {useEffect, useMemo, useState} from 'react';
import {Alert, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {font, radius, useTheme} from '../theme';
import {EmptyState} from '../components/ui';
import Icon, {type IconName} from '../components/Icon';
import {
  clearCallHistory,
  getCallHistory,
  outcomeLabel,
  subscribeCallHistory,
  type CallRecord,
} from '../history/callHistory';
import {chatUserName, describeSupportError, findChatForUser} from '../api/supportChat';
import {useCall} from '../state/CallContext';
import {dayLabel, formatDuration, formatTime} from '../utils/format';
import type {RootStackParamList} from '../navigation/types';

type Filter = 'all' | 'missed' | 'incoming' | 'outgoing';

export default function CallsScreen() {
  const {p} = useTheme();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {call, state} = useCall();
  const [list, setList] = useState<CallRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    getCallHistory().then(setList);
    return subscribeCallHistory(setList);
  }, []);

  const visible = useMemo(
    () =>
      list.filter(r =>
        filter === 'missed'
          ? r.outcome === 'missed'
          : filter === 'incoming'
          ? r.direction === 'incoming'
          : filter === 'outgoing'
          ? r.direction === 'outgoing'
          : true,
      ),
    [list, filter],
  );

  const callBack = (r: CallRecord) => {
    if (!r.peerLoyaltyId) {
      Alert.alert('Звонок', 'Не удалось определить номер (loyalty ID) собеседника');
      return;
    }
    if (state !== 'idle') {
      Alert.alert('Звонок', 'Сначала завершите текущий звонок');
      return;
    }
    call({loyaltyId: r.peerLoyaltyId, name: r.peerName});
  };

  const openChat = async (r: CallRecord) => {
    if (!r.peerLoyaltyId) return;
    try {
      const chat = await findChatForUser({loyaltyId: r.peerLoyaltyId});
      if (chat) nav.navigate('Chat', {chatId: chat.id, title: chatUserName(chat)});
      else Alert.alert('Диалога нет', 'Пользователь ещё не писал в поддержку');
    } catch (e) {
      Alert.alert('Чат', describeSupportError(e));
    }
  };

  const confirmClear = () =>
    Alert.alert('Очистить историю?', 'Журнал звонков на этом устройстве будет удалён', [
      {text: 'Отмена', style: 'cancel'},
      {text: 'Очистить', style: 'destructive', onPress: () => clearCallHistory()},
    ]);

  const renderItem = ({item: r, index}: {item: CallRecord; index: number}) => {
    const prev = visible[index - 1];
    const showDay = !prev || dayLabel(prev.startedAt) !== dayLabel(r.startedAt);
    const missed = r.outcome === 'missed';
    const icon: IconName = missed ? 'phoneMissed' : r.direction === 'incoming' ? 'phoneIncoming' : 'phoneOutgoing';
    const iconColor = missed || r.outcome === 'rejected' ? p.error : r.outcome === 'answered' ? p.success : p.textTertiary;
    return (
      <View>
        {showDay ? (
          <Text style={[font.small, {color: p.textTertiary, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6}]}>
            {dayLabel(r.startedAt)}
          </Text>
        ) : null}
        <Pressable
          onPress={() => openChat(r)}
          style={({pressed}) => [
            styles.row,
            {backgroundColor: pressed ? p.surfaceHover : p.surface, borderBottomColor: p.border},
          ]}>
          <View style={[styles.iconWrap, {backgroundColor: missed ? p.errorSoft : p.surfaceInset}]}>
            <Icon name={icon} size={18} color={iconColor} />
          </View>
          <View style={{flex: 1, minWidth: 0, gap: 2}}>
            <Text numberOfLines={1} style={[font.cardTitle, {color: missed ? p.error : p.textPrimary}]}>
              {r.peerName}
            </Text>
            <Text style={[font.caption, {color: p.textTertiary}]}>
              {outcomeLabel(r)} · {formatTime(r.startedAt)}
              {r.outcome === 'answered' && r.durationSec ? ` · ${formatDuration(r.durationSec)}` : ''}
            </Text>
          </View>
          <Pressable
            onPress={() => callBack(r)}
            hitSlop={8}
            accessibilityLabel={`Перезвонить ${r.peerName}`}
            style={[styles.round, {backgroundColor: r.peerLoyaltyId ? p.accentSoft : p.surfaceInset}]}>
            <Icon name="phone" size={18} color={r.peerLoyaltyId ? p.accent : p.textDisabled} />
          </Pressable>
        </Pressable>
      </View>
    );
  };

  const chips: {key: Filter; label: string}[] = [
    {key: 'all', label: 'Все'},
    {key: 'missed', label: `Пропущенные · ${list.filter(r => r.outcome === 'missed').length}`},
    {key: 'incoming', label: 'Входящие'},
    {key: 'outgoing', label: 'Исходящие'},
  ];

  return (
    <View style={{flex: 1, backgroundColor: p.bg}}>
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
        {list.length ? (
          <Pressable onPress={confirmClear} style={[styles.chip, {borderColor: 'transparent'}]}>
            <Text style={[font.small, {color: p.textTertiary}]}>Очистить</Text>
          </Pressable>
        ) : null}
      </View>
      <FlatList
        data={visible}
        keyExtractor={r => r.callId}
        renderItem={renderItem}
        ListEmptyComponent={
          <EmptyState
            icon="history"
            title="Звонков пока нет"
            hint="Здесь появятся входящие и исходящие звонки, сделанные в этом приложении"
          />
        }
        contentContainerStyle={visible.length === 0 ? {flexGrow: 1} : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  filters: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 12},
  chip: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
  round: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
});
