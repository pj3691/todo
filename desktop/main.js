/* ============================================================
   GitStatus 桌宠 Windows 桌面版
   - 透明、无边框、置顶覆盖主显示器工作区，加载后端 /pages/desktop-pet.html
   - 透明区域点击穿透，桌宠与气泡区域可交互
   - 桌宠在覆盖层内拖动，位置由桌宠组件写入 localStorage
   ============================================================ */
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell } = require("electron");
const fs = require("fs");
const path = require("path");

// 桌宠常年不聚焦：允许提醒音自动播放，并关闭后台节流
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
// 透明置顶层会遮住下面的待办窗口，关闭原生遮挡计算，避免被判定不可见后停止绘制
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const trayIconPath = path.join(__dirname, "tray.png");

function readServerUrl() {
    let value = process.env.GITSTATUS_URL || "http://localhost:30012";
    try {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
        if (config && typeof config.serverUrl === "string" && config.serverUrl.trim()) {
            value = config.serverUrl.trim();
        }
    } catch {
        /* 没有配置文件时使用默认地址 */
    }
    return value.replace(/\/+$/, "");
}

const serverUrl = readServerUrl();
const petUrl = `${serverUrl}/pages/desktop-pet.html`;
const loginUrl = `${serverUrl}/pages/desktop-login.html`;

let petWin = null;
let loginWin = null;
let todoWin = null;
let tray = null;
let hiding = false;
let hideTimer = null;
let allowQuit = false;
let petDisplayId = 0;

function openExternal(value) {
    try {
        const url = new URL(String(value || ""));
        if (url.protocol === "http:" || url.protocol === "https:") {
            void shell.openExternal(url.href);
        }
    } catch {
        /* 非法地址忽略 */
    }
}

// Windows 下透明置顶窗在焦点切换后可能被普通窗口压下去，这里反复重新置顶
function keepPetOnTop() {
    if (!petWin || petWin.isDestroyed()) return;
    petWin.setAlwaysOnTop(true, "screen-saver");
    petWin.moveTop();
}

function displayStateFile() {
    return path.join(app.getPath("userData"), "display-state.json");
}

function readDisplayState() {
    try {
        const state = JSON.parse(fs.readFileSync(displayStateFile(), "utf8"));
        if (state && Number.isFinite(state.displayId)) return state.displayId;
    } catch {
        /* 首次启动或状态文件损坏 */
    }
    return null;
}

function saveDisplayState() {
    try {
        fs.mkdirSync(path.dirname(displayStateFile()), { recursive: true });
        fs.writeFileSync(displayStateFile(), JSON.stringify({ displayId: petDisplayId }), "utf8");
    } catch {
        /* 状态保存失败不影响运行 */
    }
}

function getSelectedDisplay() {
    const displays = screen.getAllDisplays();
    return displays.find((display) => display.id === petDisplayId) || screen.getPrimaryDisplay();
}

// 覆盖所有显示器组成的虚拟桌面，桌宠才能直接跨屏拖动
function getVirtualBounds() {
    const displays = screen.getAllDisplays();
    const left = Math.min(...displays.map((display) => display.bounds.x));
    const top = Math.min(...displays.map((display) => display.bounds.y));
    const right = Math.max(
        ...displays.map((display) => display.bounds.x + display.bounds.width)
    );
    const bottom = Math.max(
        ...displays.map((display) => display.bounds.y + display.bounds.height)
    );
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
    };
}

// 统一生成主屏 / 副屏名称，托盘菜单和设置面板共用
function describeDisplays() {
    const primaryId = screen.getPrimaryDisplay().id;
    let secondaryIndex = 0;
    return screen.getAllDisplays().map((display) => {
        const primary = display.id === primaryId;
        const name = primary ? "主显示器" : `副显示器 ${++secondaryIndex}`;
        return {
            id: display.id,
            primary,
            label: `${name} · ${display.workArea.width}×${display.workArea.height}`,
            display
        };
    });
}

function movePetToDisplay(displayId) {
    const target = screen.getAllDisplays().find((display) => display.id === Number(displayId));
    if (!target) return;
    petDisplayId = target.id;
    saveDisplayState();
    if (petWin && !petWin.isDestroyed()) {
        // 覆盖层不移动，只让页面把桌宠放到目标显示器右下角
        petWin.webContents.send("pet:event", "display-changed");
    }
    updateTrayMenu();
}

function handleDisplaysChanged() {
    if (!petWin || petWin.isDestroyed()) return;
    const current = screen.getAllDisplays().find((display) => display.id === petDisplayId);
    if (!current) {
        // 当前显示器被拔掉时回到主屏
        petDisplayId = screen.getPrimaryDisplay().id;
        saveDisplayState();
        resizePetWindow();
        petWin.webContents.send("pet:event", "display-changed");
    } else {
        resizePetWindow();
    }
    updateTrayMenu();
}

function updateTrayMenu() {
    if (!tray) return;
    const visible = Boolean(petWin && !petWin.isDestroyed() && petWin.isVisible());
    const displays = describeDisplays();
    tray.setContextMenu(
        Menu.buildFromTemplate([
            {
                label: visible ? "隐藏桌宠" : "显示桌宠",
                click: () => {
                    if (visible) hidePet();
                    else showPet();
                }
            },
            ...(displays.length > 1
                ? [
                      {
                          label: "显示器",
                          submenu: displays.map((item) => ({
                              label: item.label,
                              type: "radio",
                              checked: item.id === petDisplayId,
                              click: () => movePetToDisplay(item.id)
                          }))
                      }
                  ]
                : []),
            {
                label: "打开待办",
                click: () => openTodoWindow(false)
            },
            { type: "separator" },
            {
                label: "退出桌宠",
                click: () => app.quit()
            }
        ])
    );
}

function createTray() {
    if (tray) return;
    const icon = nativeImage.createFromPath(trayIconPath);
    tray = new Tray(icon);
    tray.setToolTip("GitStatus 桌宠");
    tray.on("click", () => {
        if (petWin && !petWin.isDestroyed() && petWin.isVisible()) hidePet();
        else showPet();
    });
    updateTrayMenu();
}

// 关闭 = 先让页面播报再见小气泡，再把透明覆盖层藏到托盘
function hidePet() {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible() || hiding) return;
    hiding = true;
    petWin.webContents.send("pet:event", "before-hide");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        hideTimer = null;
        finishHide();
    }, 1600);
}

function finishHide() {
    if (!hiding) return;
    hiding = false;
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    if (petWin && !petWin.isDestroyed()) petWin.hide();
    updateTrayMenu();
}

function showPet() {
    if (!petWin || petWin.isDestroyed()) return;
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    hiding = false;
    petWin.showInactive();
    petWin.setIgnoreMouseEvents(true, { forward: true });
    setTimeout(keepPetOnTop, 30);
    petWin.webContents.send("pet:event", "after-show");
    updateTrayMenu();
}

function createPetWindow() {
    const savedDisplayId = readDisplayState();
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const display = displays.find((item) => item.id === savedDisplayId) || primary;
    petDisplayId = display.id;
    saveDisplayState();
    const virtual = getVirtualBounds();

    petWin = new BrowserWindow({
        x: virtual.x,
        y: virtual.y,
        width: virtual.width,
        height: virtual.height,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: true,
        enableLargerThanScreen: true,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        title: "GitStatus 桌宠",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // 桌宠常年不聚焦，关闭后台节流，保证提醒轮询和动画正常
            backgroundThrottling: false
        }
    });

    petWin.setMenuBarVisibility(false);
    petWin.setBounds({
        x: virtual.x,
        y: virtual.y,
        width: virtual.width,
        height: virtual.height
    });
    petWin.setAlwaysOnTop(true, "screen-saver");
    petWin.setIgnoreMouseEvents(true, { forward: true });
    keepPetOnTop();

    petWin.on("focus", keepPetOnTop);
    petWin.on("blur", () => {
        // 让出焦点后稍等一拍再置顶，避免被刚刚激活的窗口压住
        setTimeout(keepPetOnTop, 80);
    });
    petWin.on("show", () => {
        setTimeout(keepPetOnTop, 30);
    });
    petWin.on("restore", () => {
        setTimeout(keepPetOnTop, 30);
    });
    // 某些窗口操作会把置顶标记复位，发现被改掉就立刻补回来
    petWin.on("always-on-top-changed", (_event, isAlwaysOnTop) => {
        if (!isAlwaysOnTop) setTimeout(keepPetOnTop, 30);
    });

    petWin.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: "deny" };
    });

    petWin.webContents.on("did-finish-load", () => {
        if (!petWin || petWin.isDestroyed()) return;
        // 桌宠页与离线页都先恢复穿透，由页面命中测试按需开启交互
        petWin.setIgnoreMouseEvents(true, { forward: true });
        keepPetOnTop();
    });

    petWin.webContents.on("did-fail-load", (_event, _code, _description, validatedURL, isMainFrame) => {
        if (!isMainFrame || !validatedURL.startsWith(serverUrl)) return;
        void petWin?.loadFile(path.join(__dirname, "offline.html"), {
            query: { server: serverUrl }
        });
    });

    petWin.on("closed", () => {
        petWin = null;
    });

    // Alt+F4 / 系统关闭按钮都收进托盘，只有明确退出才真正结束进程
    petWin.on("close", (event) => {
        if (allowQuit) return;
        event.preventDefault();
        hidePet();
    });

    petWin.once("ready-to-show", () => {
        petWin.showInactive();
        setTimeout(keepPetOnTop, 30);
    });

    // 页面加载失败时 ready-to-show 可能迟迟不触发，兜底显示离线页
    setTimeout(() => {
        if (petWin && !petWin.isDestroyed() && !petWin.isVisible()) {
            petWin.showInactive();
        }
    }, 2000);

    void petWin.loadURL(petUrl);
}

// 分辨率或显示器变化时，覆盖层跟随所有显示器组成的虚拟桌面
function resizePetWindow() {
    if (!petWin || petWin.isDestroyed()) return;
    const virtual = getVirtualBounds();
    petWin.setBounds({
        x: virtual.x,
        y: virtual.y,
        width: virtual.width,
        height: virtual.height
    });
    keepPetOnTop();
}

function openLoginWindow() {
    if (loginWin && !loginWin.isDestroyed()) {
        loginWin.show();
        loginWin.focus();
        return;
    }
    const area = getSelectedDisplay().workArea;
    const width = Math.min(460, area.width);
    const height = Math.min(620, area.height);
    const x = area.x + Math.max(0, Math.floor((area.width - width) / 2));
    const y = area.y + Math.max(0, Math.floor((area.height - height) / 2));
    loginWin = new BrowserWindow({
        width,
        height,
        x,
        y,
        minWidth: Math.min(380, width),
        minHeight: Math.min(520, height),
        title: "登录 GitStatus 桌宠",
        autoHideMenuBar: true,
        backgroundColor: "#f3f7f2",
        icon: trayIconPath,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    loginWin.setMenuBarVisibility(false);
    void loginWin.loadURL(loginUrl);
    loginWin.on("closed", () => {
        loginWin = null;
    });
}

// 桌面版打开待办页：默认在应用内窗口打开，可选直达新建待办弹窗
function openTodoWindow(add = false) {
    const addUrl = `${serverUrl}/pages/todo.html${add ? "?add=1" : ""}`;
    if (todoWin && !todoWin.isDestroyed()) {
        todoWin.show();
        todoWin.focus();
        if (add || !todoWin.webContents.getURL().includes("/pages/todo.html")) {
            void todoWin.loadURL(addUrl);
        }
        return;
    }
    const area = getSelectedDisplay().workArea;
    const width = Math.min(1280, area.width);
    const height = Math.min(860, area.height);
    const x = area.x + Math.max(0, Math.floor((area.width - width) / 2));
    const y = area.y + Math.max(0, Math.floor((area.height - height) / 2));
    todoWin = new BrowserWindow({
        width,
        height,
        x,
        y,
        minWidth: Math.min(900, width),
        minHeight: Math.min(600, height),
        title: "GitStatus 待办",
        autoHideMenuBar: true,
        backgroundColor: "#f3f7f2",
        icon: trayIconPath,
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    todoWin.setMenuBarVisibility(false);
    todoWin.once("ready-to-show", () => {
        if (!todoWin || todoWin.isDestroyed()) return;
        todoWin.show();
        todoWin.focus();
    });
    void todoWin.loadURL(addUrl);
    todoWin.on("closed", () => {
        todoWin = null;
    });
}

function openTodoAddWindow() {
    openTodoWindow(true);
}

function registerIpc() {
    ipcMain.on("pet:interactive", (event, value) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        if (value) petWin.setIgnoreMouseEvents(false);
        else petWin.setIgnoreMouseEvents(true, { forward: true });
        setTimeout(keepPetOnTop, 30);
    });

    ipcMain.handle("pet:get-displays", () => {
        const items = describeDisplays();
        return {
            currentId: petDisplayId,
            displays: items.map(({ id, label, primary, display }) => ({
                id,
                label,
                primary,
                workArea: display.workArea
            }))
        };
    });

    ipcMain.on("pet:initial-display", (event) => {
        event.returnValue = {
            virtual: getVirtualBounds(),
            display: getSelectedDisplay().workArea
        };
    });

    ipcMain.on("pet:position", (event, point) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        const x = Number(point?.x);
        const y = Number(point?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const display = screen.getDisplayNearestPoint({
            x: Math.round(x),
            y: Math.round(y)
        });
        if (display && display.id !== petDisplayId) {
            petDisplayId = display.id;
            saveDisplayState();
            updateTrayMenu();
        }
    });

    ipcMain.on("pet:move-display", (event, displayId) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        movePetToDisplay(displayId);
    });

    ipcMain.on("pet:hide", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        hidePet();
    });

    ipcMain.on("pet:hide-now", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        finishHide();
    });

    ipcMain.on("pet:open-login", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        openLoginWindow();
    });

    ipcMain.on("pet:open-todo-add", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        openTodoAddWindow();
    });

    ipcMain.on("pet:open-todo", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        openTodoWindow(false);
    });

    ipcMain.on("pet:login-done", () => {
        if (loginWin && !loginWin.isDestroyed()) loginWin.close();
        loginWin = null;
        if (petWin && !petWin.isDestroyed()) {
            petWin.setIgnoreMouseEvents(true, { forward: true });
            void petWin.loadURL(petUrl);
        }
    });

    ipcMain.on("pet:open-external", (event, url) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        openExternal(url);
    });

    ipcMain.on("pet:retry", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        void petWin.loadURL(petUrl);
    });

    ipcMain.on("pet:quit", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        app.quit();
    });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
    app.quit();
} else {
    app.setAppUserModelId("com.gitstatus.pet");

    app.on("before-quit", () => {
        allowQuit = true;
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    });

    app.on("second-instance", () => {
        showPet();
    });

    app.whenReady().then(() => {
        registerIpc();
        createPetWindow();
        createTray();
        screen.on("display-metrics-changed", handleDisplaysChanged);
        screen.on("display-added", handleDisplaysChanged);
        screen.on("display-removed", handleDisplaysChanged);
    });

    app.on("will-quit", () => {
        if (tray) {
            tray.destroy();
            tray = null;
        }
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });

    app.on("activate", () => {
        if (!petWin) createPetWindow();
    });
}
