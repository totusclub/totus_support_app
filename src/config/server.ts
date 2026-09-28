// Адреса backend — те же, что у панели агента calling_v2 (lib/server.ts, lib/http.ts)
// и у клиентского приложения totus_APP (src/config/server.ts).

/** calling_api_v2: звонки (REST + Socket.IO), Support Chat, ICE-серверы. */
export const VOIP_BASE_URL = 'https://voip.totus.club';

/** totus_API: только обновление JWT (POST /api/auth/refresh). */
export const API_BASE_URL = 'https://api.totus.club';

/** Админка — ссылки «Заказ №…» из диалога открываются в браузере. */
export const ADMIN_BASE_URL = 'https://admin.totus.club';
