package club.totus.support

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

// Экран входящего звонка поверх блокировки показывает системный UI ConnectionService (CallKeep),
// поэтому само приложение (с перепиской пользователей) поверх экрана блокировки не открывается.
class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "TotusSupport"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
