import {Linking, Platform} from 'react-native';

/**
 * Энергосбережение Android. Для сотрудника поддержки важно не пропускать входящие:
 * при первом входе показываем подсказку открыть настройки батареи (один раз за сессию).
 * Сам запрос делает экран «Профиль» → «Не пропускать звонки».
 */
export async function ensureAndroidBatteryOptimizationHandled(): Promise<void> {
  // Решение принимает пользователь в «Профиле» — здесь без системных диалогов.
}

export async function maybePromptAndroidVoipPowerSetup(_reason?: string): Promise<void> {
  // no-op: см. openAndroidBatterySettings()
}

export function openAndroidBatterySettings(): void {
  if (Platform.OS !== 'android') return;
  Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() => {
    Linking.openSettings().catch(() => {});
  });
}
