// Export teilen: Datei in den Cache schreiben und das System-Teilen-Menü öffnen (keine
// Speicherberechtigung nötig). Ungeprüft auf Gerät.
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new Error('read_failed'));
    };
    reader.readAsDataURL(blob);
  });
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function shareFile(name: string, mime: string, data: Blob | string): Promise<void> {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  await file.write(typeof data === 'string' ? data : await bytesOf(data));
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: name });
}
