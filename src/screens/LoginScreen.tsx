// Вход сотрудника поддержки (учётка с ролью agent, как в панели calling_v2).
import React, {useState} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {font, radius, useTheme} from '../theme';
import {Button} from '../components/ui';
import Icon from '../components/Icon';
import {useAuth} from '../state/AuthContext';

export default function LoginScreen() {
  const {p} = useTheme();
  const {login, notice} = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) {
      setError('Введите e-mail и пароль');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
    } catch (e: any) {
      setError(e?.message || 'Не удалось войти');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = [
    styles.input,
    {borderColor: p.border, backgroundColor: p.surface, color: p.textPrimary},
  ];

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: p.bg}}>
      <KeyboardAvoidingView style={{flex: 1}} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={[styles.logo, {backgroundColor: p.accentSoft}]}>
            <Icon name="phone" size={32} color={p.accent} />
          </View>
          <Text style={[font.pageTitle, {color: p.textPrimary, textAlign: 'center'}]}>Totus Support</Text>
          <Text style={[font.body, {color: p.textTertiary, textAlign: 'center', marginBottom: 24}]}>
            Чат и звонки пользователей Totus Club. Вход для сотрудников поддержки.
          </Text>

          {notice ? (
            <Text style={[font.caption, {color: p.warning, textAlign: 'center', marginBottom: 12}]}>{notice}</Text>
          ) : null}

          <Text style={[font.caption, {color: p.textSecondary, marginBottom: 6}]}>E-mail</Text>
          <TextInput
            style={inputStyle}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
            placeholder="agent@totus.club"
            placeholderTextColor={p.textTertiary}
            returnKeyType="next"
          />
          <Text style={[font.caption, {color: p.textSecondary, marginTop: 14, marginBottom: 6}]}>Пароль</Text>
          <TextInput
            style={inputStyle}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            placeholder="••••••••"
            placeholderTextColor={p.textTertiary}
            returnKeyType="go"
            onSubmitEditing={submit}
          />

          {error ? <Text style={[font.caption, {color: p.error, marginTop: 12}]}>{error}</Text> : null}

          <Button title="Войти" onPress={submit} loading={loading} style={{marginTop: 24}} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flexGrow: 1, justifyContent: 'center', padding: 24, gap: 4},
  logo: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
});
