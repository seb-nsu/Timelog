package de.timelog.mobile.detect

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** Ziel des PendingIntent aus `registerNetworkCallback`; läuft auch bei beendeter App. */
class NetworkReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val pending = goAsync()
    CoroutineScope(Dispatchers.IO).launch {
      try {
        Detector.evaluate(context.applicationContext, Detector.Reason.CALLBACK)
      } finally {
        pending.finish()
      }
    }
  }

  companion object {
    const val ACTION = "de.timelog.mobile.detect.NETWORK_AVAILABLE"
  }
}

/** Nach Neustart des Handys oder App-Update: Callback und 15-Minuten-Prüfung neu anmelden. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
        val app = context.applicationContext
        Detector.arm(app)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
          try {
            Detector.evaluate(app, Detector.Reason.PERIODIC)
          } finally {
            pending.finish()
          }
        }
      }
    }
  }
}

/** WorkManager-Prüfung (periodisch alle 15 min und einmalig nach „verfügbar“). */
class CheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    Detector.evaluate(applicationContext, Detector.Reason.PERIODIC)
    return Result.success()
  }
}
