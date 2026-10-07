// Title bar + splash + offline screen shown behind the site view.
type ShellApi = import('../preload/local.cjs').Api;
type State = Awaited<ReturnType<ShellApi['getShellState']>>;

const shellApi = (window as unknown as { api: ShellApi }).api;
document.documentElement.dataset.platform = shellApi.platform;
const AUTO_RETRY_MS = 15_000;
let kind: State['kind'] = 'loading';
let retryTimer: number | undefined;

function render(s: State): void {
  kind = s.kind;
  document.body.dataset.kind = s.kind;
  document.getElementById('detail')!.textContent = s.message ?? '';
  window.clearInterval(retryTimer);
  if (s.kind === 'error') retryTimer = window.setInterval(() => shellApi.retry(), AUTO_RETRY_MS);
}

shellApi.onShellState(render);
void shellApi.getShellState().then(render);
document.getElementById('retry')!.addEventListener('click', () => shellApi.retry());
window.addEventListener('online', () => kind === 'error' && shellApi.retry());
