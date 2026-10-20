// Hintergrund-Sync (expo-background-task: WorkManager bzw. BGTaskScheduler). Holt native
// Ereignisse ab und überträgt die Warteschlange; das System bestimmt den Takt (≥ 15 min).
// Die Netz-Erkennung selbst hängt nicht davon ab (Android: eigener WorkManager-Job im Modul).
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { getCore } from './platform';

export const SYNC_TASK = 'timelog-sync';

TaskManager.defineTask(SYNC_TASK, async () => {
  try {
    const core = await getCore();
    await core.ingestNative();
    const state = await core.sync(true);
    return state.state === 'offline'
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(SYNC_TASK)) return;
  await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: 15 });
}
