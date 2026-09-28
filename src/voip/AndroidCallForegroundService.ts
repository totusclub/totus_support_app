/**
 * Нативного foreground-сервиса звонка нет: на Android звонок держит ConnectionService
 * react-native-callkeep (foregroundService в настройках CallKeep). Заглушки сохраняют
 * интерфейс VoipService (как в totus_APP).
 */
export async function startAndroidCallForegroundService(
  _callUUID?: string,
  _title?: string,
): Promise<void> {
  // no-op
}

export async function stopAndroidCallForegroundService(): Promise<void> {
  // no-op
}
