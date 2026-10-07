type SettingsApi = import('../preload/local.cjs').Api;
type AppSettings = Awaited<ReturnType<SettingsApi['getSettings']>>['settings'];

const settingsApi = (window as unknown as { api: SettingsApi }).api;
document.documentElement.dataset.platform = settingsApi.platform;
if (settingsApi.platform === 'darwin') {
  for (const el of document.querySelectorAll<HTMLElement>('[data-mac]')) el.textContent = el.dataset.mac ?? '';
}
const fields = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')];
const exceptions = document.getElementById('exceptions') as HTMLTextAreaElement;
let initialHwAccel: boolean | undefined;

function fill(s: AppSettings): void {
  for (const el of fields) {
    const v = s[el.dataset.key as keyof AppSettings];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v as boolean;
    else el.value = String(v);
  }
  if (document.activeElement !== exceptions) exceptions.value = s.adblockExceptions.join('\n');
  initialHwAccel ??= s.hardwareAcceleration;
  document.getElementById('restart')!.classList.toggle('show', s.hardwareAcceleration !== initialHwAccel);
}

for (const el of fields) {
  el.addEventListener('change', () => {
    const key = el.dataset.key as keyof AppSettings;
    const value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : Number(el.value);
    void settingsApi.setSetting(key, value as never).then(fill);
  });
}
exceptions.addEventListener('change', () => {
  void settingsApi.setSetting('adblockExceptions', exceptions.value.split(/[\s,]+/)).then(fill);
});
document.getElementById('clear')!.addEventListener('click', () => void settingsApi.clearData());
document.getElementById('relaunch')!.addEventListener('click', () => void settingsApi.relaunch());

settingsApi.onSettingsChanged(fill);
void settingsApi.getSettings().then(({ settings, version }) => {
  document.getElementById('version')!.textContent = `AnimeOn Desktop (Unofficial) ${version}`;
  fill(settings);
});
