import { app, BrowserWindow, Menu, shell, dialog, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { appendFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import {
  ensureUserConfigFile,
  loadUserConfig,
  generateAuthToken,
  findFreePort,
  buildServerEnv,
} from "./serverConfig.js";
import { spawnServer, waitForHealth, ServerStartError } from "./serverProcess.js";

const PREFERRED_PORT = 8787;
const HEALTH_TIMEOUT_MS = 20_000;
const REPO_URL = "https://github.com/solmasta/CodeJustWrite";

// A second launch (double-clicking the icon again, a shell opening it) would otherwise spawn a
// second backend fighting over the same workspace dir and a second port — send it to the
// existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let serverChild: ChildProcess | null = null;
let serverBaseUrl = "";

const userDataDir = () => app.getPath("userData");
const configPath = () => path.join(userDataDir(), "config.env");
const workspacesDir = () => path.join(userDataDir(), "workspaces");
const logPath = () => path.join(userDataDir(), "server.log");

/** dist/server/index.js and dist/web (this app's own extraResources) in a packaged build;
 *  the sibling workspace packages' own build output when running from source in dev. */
function serverEntryPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "server", "index.js");
  return path.join(app.getAppPath(), "..", "server", "dist", "index.js");
}

function webDistPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "web");
  return path.join(app.getAppPath(), "..", "web", "dist");
}

function appendLog(line: string): void {
  try {
    appendFileSync(logPath(), line + "\n");
  } catch {
    // Logging is best-effort — a full disk or permissions issue here shouldn't crash the app.
  }
}

async function startServer(): Promise<void> {
  ensureUserConfigFile(configPath());
  const userConfig = loadUserConfig(configPath());
  const port = await findFreePort(PREFERRED_PORT);
  const authToken = generateAuthToken();
  const env = buildServerEnv(process.env, {
    port,
    authToken,
    workspacesDir: workspacesDir(),
    webDistDir: webDistPath(),
    userConfig,
  });

  serverChild = spawnServer({
    entryPath: serverEntryPath(),
    env,
    execPath: process.execPath,
    onLog: (line) => appendLog(line),
    onExit: (code, signal) => {
      serverChild = null;
      // A clean shutdown (we killed it ourselves to restart/quit) exits 0/null — anything else
      // means the server crashed on its own, which the window would otherwise just show as a
      // silently dead connection with no explanation.
      if (code !== 0 && code !== null && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox(
          "CodeJustWrite server stopped",
          `The local server exited unexpectedly (code ${code}, signal ${signal ?? "none"}). ` +
            `Check ${logPath()} for details, then use CodeJustWrite > Restart Server.`
        );
      }
    },
  });

  serverBaseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(serverBaseUrl, HEALTH_TIMEOUT_MS);

  // The token rides in the URL fragment, never sent over the network — the app's own sign-in
  // flow (built for the Termux one-tap shortcut) reads it, saves it, and strips it from the
  // address bar, so there's no sign-in screen here either.
  const url = `${serverBaseUrl}/#token=${authToken}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(url);
  } else {
    createWindow(url);
  }
}

function stopServer(): void {
  if (serverChild && !serverChild.killed) {
    serverChild.kill();
  }
  serverChild = null;
}

async function restartServer(): Promise<void> {
  stopServer();
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox(
      "Couldn't restart the server",
      err instanceof Error ? err.message : String(err)
    );
  }
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "CodeJustWrite",
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(url);
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: "CodeJustWrite",
          submenu: [
            { role: "about" },
            { type: "separator" },
            { label: "Restart Server", click: () => void restartServer() },
            { label: "Open Settings File…", click: () => void shell.openPath(configPath()) },
            { label: "Open Workspaces Folder", click: () => void shell.openPath(workspacesDir()) },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [
        {
          label: "File",
          submenu: [
            { label: "Restart Server", click: () => void restartServer() },
            { label: "Open Settings File…", click: () => void shell.openPath(configPath()) },
            { label: "Open Workspaces Folder", click: () => void shell.openPath(workspacesDir()) },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "View on GitHub", click: () => void shell.openExternal(REPO_URL) },
        { label: "Report an Issue", click: () => void shell.openExternal(`${REPO_URL}/issues`) },
        { label: "View Server Logs", click: () => void shell.openPath(logPath()) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  buildMenu();
  try {
    await startServer();
  } catch (err) {
    const message = err instanceof ServerStartError ? err.message : String(err);
    dialog.showErrorBox("CodeJustWrite couldn't start", message);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void startServer();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopServer();
});
