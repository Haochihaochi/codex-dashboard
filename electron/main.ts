import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  dialog,
  shell,
  Notification,
  session,
  type IpcMainInvokeEvent,
} from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { createStore } from './store';
import { buildState } from './usage';
import { collectAlerts } from './alerts';
import { createDemoState } from '../src/lib/demo';
import type { DashboardState, Settings } from '../src/shared/types';

app.setName('Codex Dashboard');
app.setAppUserModelId('io.haochihaochi.codexdashboard');
const smoke = process.env.CODEX_DASHBOARD_SMOKE === '1';
if (smoke && process.env.CODEX_DASHBOARD_USER_DATA)
  app.setPath('userData', process.env.CODEX_DASHBOARD_USER_DATA);
let main: BrowserWindow | null = null;
let popup: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let state: DashboardState;
let timer: ReturnType<typeof setInterval> | undefined;
let timerPending = false;
let store: ReturnType<typeof createStore>;
const alertKeys = new Set<string>();
let work: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = work.then(fn, fn);
  work = next.catch(() => undefined);
  return next;
}
const indexPath = join(__dirname, '../dist/index.html');
const devUrl =
  !app.isPackaged && process.env.VITE_DEV_SERVER_URL === 'http://127.0.0.1:5174'
    ? process.env.VITE_DEV_SERVER_URL
    : null;
const appUrl = devUrl ?? pathToFileURL(indexPath).href;
const links = {
  codex: 'https://chatgpt.com/codex',
  claude: 'https://claude.ai/settings/usage',
  cursor: 'https://cursor.com/dashboard',
  gemini: 'https://aistudio.google.com/usage',
  github: 'https://github.com/Haochihaochi/codex-dashboard',
};

function trusted(event: IpcMainInvokeEvent) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const url = new URL(event.senderFrame?.url ?? 'about:blank');
  url.search = '';
  url.hash = '';
  const expected = new URL(appUrl);
  expected.search = '';
  expected.hash = '';
  if (
    !owner ||
    (owner !== main && owner !== popup) ||
    event.senderFrame !== event.sender.mainFrame ||
    url.href !== expected.href
  )
    throw new Error('Untrusted application request.');
}
function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(`dashboard:${name}`, (event, ...args) => {
    trusted(event);
    return fn(...args);
  });
}
function applyLogin(settings: Settings) {
  if (app.isPackaged && process.platform === 'win32')
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      path: process.execPath,
      args: ['--hidden'],
    });
}
function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (timerPending) return;
    timerPending = true;
    void serial(refresh)
      .catch(() => undefined)
      .finally(() => {
        timerPending = false;
      });
  }, store.getSettings().refreshSeconds * 1000);
}
async function refresh() {
  const settings = store.getSettings();
  state = settings.demoMode
    ? createDemoState(settings)
    : await buildState(settings, store.getManualUsage());
  for (const window of [main, popup])
    if (window && !window.isDestroyed()) window.webContents.send('dashboard:changed', state);
  const selected = state.providers.find((p) => p.id === settings.selectedProvider);
  const quota = selected?.windows.find((w) => w.resetsAt && Date.parse(w.resetsAt) > Date.now());
  tray?.setToolTip(
    `Codex Dashboard${settings.demoMode ? ' · Sample data' : ''}\n${selected?.name ?? 'Codex'}${quota ? ` · ${Math.round(100 - quota.usedPercent)}% left (${quota.label})` : ' · Open for usage'}`,
  );
  if (!smoke && Notification.isSupported())
    for (const alert of collectAlerts(state, alertKeys)) {
      const n = new Notification(alert);
      n.on('click', showMain);
      n.show();
    }
  return state;
}
function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}
function createWindow(compact: boolean) {
  const window = new BrowserWindow({
    width: compact ? 450 : 520,
    height: compact ? 760 : 900,
    minWidth: compact ? 450 : 440,
    minHeight: 540,
    show: false,
    frame: !compact,
    resizable: !compact,
    maximizable: !compact,
    skipTaskbar: compact,
    alwaysOnTop: compact,
    backgroundColor: '#101114',
    title: 'Codex Dashboard',
    icon: join(__dirname, '../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  secureWindow(window);
  void window.loadURL(`${appUrl}${compact ? '?tray=1' : ''}`);
  return window;
}
function showMain() {
  if (!main) return;
  popup?.hide();
  main.show();
  if (main.isMinimized()) main.restore();
  main.focus();
}
function togglePopup() {
  if (!popup || !tray) return;
  if (popup.isVisible()) {
    popup.hide();
    return;
  }
  const bounds = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const height = Math.min(760, area.height - 16);
  const width = Math.min(450, area.width - 16);
  const x = Math.max(
    area.x + 8,
    Math.min(bounds.x + bounds.width / 2 - width / 2, area.x + area.width - width - 8),
  );
  const y = bounds.y > area.y + area.height / 2 ? area.y + area.height - height - 8 : area.y + 8;
  popup.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  popup.show();
  popup.focus();
}
async function boot() {
  store = createStore(app.getPath('userData'));
  if (smoke)
    store.updateSettings({
      codexPath: process.env.CODEX_DASHBOARD_FIXTURES ?? app.getPath('userData'),
      claudePath: app.getPath('userData'),
      notifications: false,
      launchAtLogin: false,
    });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  handle('state', () => serial(async () => state ?? (await refresh())));
  handle('refresh', () => serial(refresh));
  handle('settings', (patch: Partial<Settings>) =>
    serial(async () => {
      if (
        patch &&
        patch.launchAtLogin === true &&
        (!app.isPackaged || process.platform !== 'win32')
      )
        throw new Error('Launch at login is available after installing the Windows app.');
      const next = store.updateSettings(patch);
      nativeTheme.themeSource = next.theme;
      applyLogin(next);
      schedule();
      return refresh();
    }),
  );
  handle('manual', (usage: unknown) =>
    serial(async () => {
      store.saveManualUsage(usage);
      return refresh();
    }),
  );
  handle('directory', async (provider: unknown) => {
    if (provider !== 'codex' && provider !== 'claude') throw new Error('Choose Codex or Claude.');
    const result = await dialog.showOpenDialog(main!, {
      title: `Choose ${provider === 'codex' ? '.codex' : '.claude'} folder`,
      properties: ['openDirectory', 'showHiddenFiles'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('export', async () => {
    const snapshot = await serial(async () => state ?? (await refresh()));
    const result = await dialog.showSaveDialog(main!, {
      title: 'Export usage summary',
      defaultPath: `codex-dashboard-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(
      result.filePath,
      JSON.stringify(
        {
          version: snapshot.version,
          exportedAt: new Date().toISOString(),
          demo: snapshot.settings.demoMode,
          providers: snapshot.providers,
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    return true;
  });
  handle('external', async (target: string) => {
    if (!Object.hasOwn(links, target)) throw new Error('Unsupported link.');
    await shell.openExternal(links[target as keyof typeof links]);
  });
  handle('show', async () => showMain());
  nativeTheme.themeSource = store.getSettings().theme;
  main = createWindow(false);
  popup = createWindow(true);
  main.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      main?.hide();
    }
  });
  popup.on('blur', () => {
    if (!smoke) popup?.hide();
  });
  const icon = nativeImage
    .createFromPath(join(__dirname, '../build/icon.png'))
    .resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.on('click', togglePopup);
  tray.on('double-click', showMain);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Codex Dashboard', click: showMain },
      {
        label: 'Refresh usage',
        click: () => {
          void serial(refresh).catch(() => undefined);
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  await serial(refresh);
  schedule();
  if (!smoke) {
    applyLogin(store.getSettings());
    if (!process.argv.includes('--hidden')) showMain();
  }
  if (smoke) await runSmoke();
}
async function runSmoke() {
  if (!main || !popup) throw new Error('Windows missing.');
  for (const win of [main, popup]) {
    if (win.webContents.isLoading())
      await new Promise<void>((resolve) =>
        win.webContents.once('did-finish-load', () => resolve()),
      );
    await win.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(document.querySelector('button')&&window.codexDashboard){clearInterval(t);resolve(true)}else if(++n>100){clearInterval(t);reject(new Error('UI did not render'))}},50)})`,
    );
  }
  const result = await main.webContents.executeJavaScript(`(async()=>{
    const api=window.codexDashboard; const live=await api.getState();
    if(live.providers.length!==4||live.settings.demoMode) throw new Error('Live state unavailable');
    const fixture=live.providers.find(p=>p.id==='codex');
    if(!fixture.windows.length || fixture.windows[0].usedPercent!==25) throw new Error('Local fixture not read');
    let rejected=false;try{await api.updateSettings({refreshSeconds:1})}catch{rejected=true}if(!rejected)throw new Error('Invalid setting accepted');
    rejected=false;try{await api.openExternal('file:///etc/passwd')}catch{rejected=true}if(!rejected)throw new Error('External URL accepted');
    await api.saveManualUsage({provider:'cursor',usedPercent:42,resetsAt:new Date(Date.now()+86400000).toISOString(),windowLabel:'Monthly',plan:'Pro'});
    const changed=await api.updateSettings({demoMode:true});if(!changed.settings.demoMode)throw new Error('Demo switch failed');
    return {providers:live.providers.length,liveSource:fixture.source,manual: true,validation:true};
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (process.env.CODEX_DASHBOARD_SCREENSHOTS) {
    const target = process.env.CODEX_DASHBOARD_SCREENSHOTS;
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'dashboard.png'), (await main.webContents.capturePage()).toPNG());
    await writeFile(join(target, 'tray.png'), (await popup.webContents.capturePage()).toPNG());
    await main.webContents.executeJavaScript('window.scrollTo(0,document.body.scrollHeight)');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await writeFile(join(target, 'activity.png'), (await main.webContents.capturePage()).toPNG());
  }
  await main.webContents.executeJavaScript(`(async()=>{
    const wait=async(fn)=>{for(let n=0;n<100;n++){if(fn())return;await new Promise(r=>setTimeout(r,30))}throw new Error('UI action timed out')};
    const click=(label)=>{const b=document.querySelector('button[aria-label="'+label+'"]');if(!b)throw new Error('Button missing: '+label);b.click()};
    click('Open settings');await wait(()=>document.body.textContent.includes('PREFERENCES'));
    click('light theme');await wait(()=>document.documentElement.dataset.theme==='light');
    click('dark theme');await wait(()=>document.documentElement.dataset.theme==='dark');
    click('Demo mode');await wait(()=>!document.body.textContent.includes('Exit demo'));
    click('Back to dashboard');await wait(()=>!!document.querySelector('.provider-tabs'));
    [...document.querySelectorAll('.provider-tabs button')].find(b=>b.textContent.includes('Cursor')).click();
    await wait(()=>!!document.querySelector('.manual-update'));
    document.querySelector('.manual-update').click();await wait(()=>!!document.querySelector('[role="dialog"]'));
    const input=document.querySelector('input[type="number"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'43');input.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,30));document.querySelector('button[type="submit"]').click();
    await wait(()=>!document.querySelector('[role="dialog"]'));
    const current=await window.codexDashboard.getState();
    if(current.providers.find(p=>p.id==='cursor').windows[0].usedPercent!==43)throw new Error('Manual editor did not save');
  })()`);
  console.log(`CODEX_DASHBOARD_SMOKE_OK ${JSON.stringify(result)}`);
  app.quit();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showMain);
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      console.error('Codex Dashboard failed to start:', error.message);
      quitting = true;
      app.exit(1);
    });
  app.on('activate', showMain);
  app.on('window-all-closed', () => {
    /* Tray keeps the application running. */
  });
  app.on('before-quit', () => {
    quitting = true;
    if (timer) clearInterval(timer);
    tray?.destroy();
  });
}
