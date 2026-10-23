package de.timelog.mobile.detect.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.Button
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import de.timelog.mobile.detect.Detector
import de.timelog.mobile.detect.DetectorStore
import de.timelog.mobile.detect.R

/** Zustand für das Widget; Texte liefert die App fertig übersetzt (aus @timelog/rules berechnet). */
data class WidgetData(
  val running: Boolean,
  val title: String,
  val subtitle: String,
  val startLabel: String,
  val stopLabel: String,
  val inWorkNetwork: Boolean,
)

fun widgetData(context: Context): WidgetData {
  val store = DetectorStore(context)
  val o = store.widget()
  return WidgetData(
    running = o?.optBoolean("running", false) ?: false,
    title = o?.optString("title")?.ifEmpty { null } ?: context.getString(R.string.timelog_widget_label),
    subtitle = o?.optString("subtitle") ?: "",
    startLabel = o?.optString("startLabel")?.ifEmpty { null } ?: context.getString(R.string.timelog_widget_start),
    stopLabel = o?.optString("stopLabel")?.ifEmpty { null } ?: context.getString(R.string.timelog_widget_stop),
    inWorkNetwork = store.state().connected,
  )
}

class TimelogWidget : GlanceAppWidget() {
  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val data = widgetData(context)
    val network = context.getString(R.string.timelog_widget_in_network)
    provideContent {
      GlanceTheme {
        Content(data, network)
      }
    }
  }

  @Composable
  private fun Content(data: WidgetData, networkText: String) {
    val summary = listOf(data.title, data.subtitle, if (data.inWorkNetwork) networkText else "")
      .filter { it.isNotEmpty() }
      .joinToString(", ")
    Column(
      modifier = GlanceModifier
        .fillMaxSize()
        .background(GlanceTheme.colors.widgetBackground)
        .padding(12.dp)
        .semantics { contentDescription = summary },
    ) {
      Text(
        text = data.title,
        style = TextStyle(
          fontWeight = FontWeight.Bold,
          fontSize = 16.sp,
          color = GlanceTheme.colors.onSurface,
        ),
      )
      if (data.subtitle.isNotEmpty()) {
        Text(text = data.subtitle, style = TextStyle(fontSize = 14.sp, color = GlanceTheme.colors.onSurface))
      }
      if (data.inWorkNetwork) {
        Text(text = networkText, style = TextStyle(fontSize = 13.sp, color = GlanceTheme.colors.onSurfaceVariant))
      }
      Spacer(GlanceModifier.height(8.dp))
      Button(
        text = if (data.running) data.stopLabel else data.startLabel,
        onClick = actionRunCallback<ToggleWorkAction>(),
      )
    }
  }

  companion object {
    suspend fun refresh(context: Context) {
      TimelogWidget().updateAll(context)
    }
  }
}

class TimelogWidgetReceiver : GlanceAppWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = TimelogWidget()
}

/** Start/Stopp vom Homescreen: Ereignis sofort speichern, die App überträgt es später. */
class ToggleWorkAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    val store = DetectorStore(context)
    val running = store.widget()?.optBoolean("running", false) ?: false
    val now = DetectorStore.nowIso()
    store.manual(if (running) "manual_end" else "manual_start", now, DetectorStore.timezone())
    // Anzeige sofort umschalten; die App berechnet beim nächsten Start den echten Stand.
    val next = (store.widget() ?: org.json.JSONObject()).put("running", !running)
    if (!running) next.put("since", now) else next.remove("since")
    next.put("subtitle", context.getString(if (running) R.string.timelog_widget_stopped else R.string.timelog_widget_started))
    store.saveWidget(next.toString())
    Detector.listener?.invoke()
    TimelogWidget().update(context, glanceId)
  }
}
