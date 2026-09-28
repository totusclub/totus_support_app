/**
 * Totus Support — приложение службы поддержки Totus Club.
 * Сотрудник (роль agent) видит диалоги пользователей, отвечает в реальном времени,
 * принимает и совершает VoIP-звонки. Backend — calling_api_v2 (voip.totus.club).
 */
import React, {useEffect} from 'react';
import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {AuthProvider} from './src/state/AuthContext';
import {SupportChatProvider} from './src/state/SupportChatContext';
import {CallProvider} from './src/state/CallContext';
import RootNavigator from './src/navigation/RootNavigator';
import {subscribeForegroundNotificationEvents} from './src/push/localNotifications';
import {useTheme} from './src/theme';

function ThemedStatusBar() {
  const {p, isDark} = useTheme();
  return <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={p.surface} />;
}

export default function App() {
  useEffect(() => subscribeForegroundNotificationEvents(), []);
  return (
    <SafeAreaProvider>
      <ThemedStatusBar />
      <AuthProvider>
        <SupportChatProvider>
          <CallProvider>
            <RootNavigator />
          </CallProvider>
        </SupportChatProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
