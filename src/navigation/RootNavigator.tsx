import React, {useEffect} from 'react';
import {ActivityIndicator, View} from 'react-native';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {useTheme} from '../theme';
import Icon, {type IconName} from '../components/Icon';
import {CountBadge} from '../components/ui';
import CallOverlay from '../components/CallOverlay';
import {useAuth} from '../state/AuthContext';
import {useSupportChat} from '../state/SupportChatContext';
import {setNotificationPressHandler} from '../push/localNotifications';
import LoginScreen from '../screens/LoginScreen';
import ChatsScreen from '../screens/ChatsScreen';
import ChatScreen from '../screens/ChatScreen';
import UsersScreen from '../screens/UsersScreen';
import CallsScreen from '../screens/CallsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import type {MainTabParamList, RootStackParamList} from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

const TAB_ICONS: Record<keyof MainTabParamList, IconName> = {
  Chats: 'chat',
  Users: 'users',
  Calls: 'history',
  Profile: 'user',
};

function MainTabs() {
  const {p} = useTheme();
  const {unreadTotal} = useSupportChat();
  return (
    <Tabs.Navigator
      screenOptions={({route}) => ({
        headerStyle: {backgroundColor: p.surface},
        headerTintColor: p.textPrimary,
        headerShadowVisible: false,
        tabBarActiveTintColor: p.accent,
        tabBarInactiveTintColor: p.textTertiary,
        tabBarStyle: {backgroundColor: p.surface, borderTopColor: p.border},
        tabBarIcon: ({color, size}) => (
          <View>
            <Icon name={TAB_ICONS[route.name]} size={size} color={color} />
            {route.name === 'Chats' && unreadTotal > 0 ? (
              <View style={{position: 'absolute', top: -6, right: -14}}>
                <CountBadge count={unreadTotal} />
              </View>
            ) : null}
          </View>
        ),
      })}>
      <Tabs.Screen name="Chats" component={ChatsScreen} options={{title: 'Чаты'}} />
      <Tabs.Screen name="Users" component={UsersScreen} options={{title: 'Пользователи'}} />
      <Tabs.Screen name="Calls" component={CallsScreen} options={{title: 'Звонки'}} />
      <Tabs.Screen name="Profile" component={ProfileScreen} options={{title: 'Профиль'}} />
    </Tabs.Navigator>
  );
}

export default function RootNavigator() {
  const {p, isDark} = useTheme();
  const {status} = useAuth();

  // Тап по локальному уведомлению: сообщение → диалог, пропущенный → «Звонки»
  useEffect(() => {
    if (status !== 'signedIn') {
      setNotificationPressHandler(null);
      return;
    }
    const go = (data: Record<string, string>) => {
      const tryNav = (attempt = 0) => {
        if (!navigationRef.isReady()) {
          if (attempt < 20) setTimeout(() => tryNav(attempt + 1), 150);
          return;
        }
        if (data.chatId) navigationRef.navigate('Chat', {chatId: Number(data.chatId)});
        else if (data.route === 'calls') navigationRef.navigate('Main' as any, {screen: 'Calls'} as any);
      };
      tryNav();
    };
    setNotificationPressHandler(go);
    return () => setNotificationPressHandler(null);
  }, [status]);

  const navTheme = isDark
    ? {...DarkTheme, colors: {...DarkTheme.colors, background: p.bg, card: p.surface, primary: p.accent, border: p.border, text: p.textPrimary}}
    : {...DefaultTheme, colors: {...DefaultTheme.colors, background: p.bg, card: p.surface, primary: p.accent, border: p.border, text: p.textPrimary}};

  if (status === 'loading') {
    return (
      <View style={{flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.bg}}>
        <ActivityIndicator color={p.accent} />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: {backgroundColor: p.surface},
          headerTintColor: p.textPrimary,
          headerShadowVisible: false,
          headerBackTitle: 'Назад',
        }}>
        {status === 'signedIn' ? (
          <>
            <Stack.Screen name="Main" component={MainTabs} options={{headerShown: false}} />
            <Stack.Screen name="Chat" component={ChatScreen} options={({route}) => ({title: route.params.title || 'Диалог'})} />
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} options={{headerShown: false}} />
        )}
      </Stack.Navigator>
      {status === 'signedIn' ? <CallOverlay /> : null}
    </NavigationContainer>
  );
}
