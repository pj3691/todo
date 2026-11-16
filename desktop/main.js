/* ============================================================
   GitStatus 桌宠 Windows 桌面版（重写版）
   - 三个本地窗口：桌宠窗（只放桌宠）、气泡窗（小气泡/面板/提醒）、设置窗
   - 不再复用网页版桌宠页面，渲染层全部在 desktop/renderer 下
   - 鼠标命中直接按桌宠小窗口的屏幕矩形判断，不再采集命中区块
   - 数据轮询、提醒调度、角色素材都集中在主进程，窗口只做展示
   ============================================================ */
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, dialog, Notification } = require("electron");
const fs = require("fs");
const path = require("path");
const { readJson, writeJson } = require("./lib/store");
const { createApi } = require("./lib/api");
const copy = require("./lib/copy");

// 透明置顶窗在部分显卡/驱动下拖动会闪烁；桌宠窗口很小，继续用软件合成更稳。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const trayIconPath = path.join(__dirname, "tray.png");
const rendererDir = path.join(__dirname, "renderer");
const preloadPath = path.join(__dirname, "preload.js");
const offlinePage = path.join(__dirname, "offline.html");

// 桌宠窗口四周留出的透明内边距：给阴影、徽标和右侧小按钮留空间。
const PET_PADDING = 10;
const PET_SIZE_MIN = 56;
const PET_SIZE_MAX = 120;
const PET_SIZE_DEFAULT = 76;
const PET_MARGIN = 10;
// 右侧小按钮（菜单 / 新建 / 待办）最下沿相对桌宠顶部的距离，保证小尺寸时也能放下
const PET_SIDE_STACK_HEIGHT = 76;
// 气泡窗口四周的透明内边距：容纳阴影和小气泡尾巴
const BUBBLE_PADDING = 16;
// 与网页版一致的气泡宽度
const PANEL_WIDTH = 322;
const MINI_WIDTH = 200;
const SETTINGS_WIDTH = 384;

const POLL_MS = 25000;
const TICK_MS = 15000;
const WORK_GRACE_MINUTES = 10;

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
const loginUrl = `${serverUrl}/pages/desktop-login.html`;
const todoUrl = `${serverUrl}/pages/todo.html`;

const userDataDir = app.getPath("userData");
const files = {
    display: path.join(userDataDir, "display-state.json"),
    prefs: path.join(userDataDir, "preferences.json"),
    session: path.join(userDataDir, "session.json"),
    reminder: path.join(userDataDir, "reminder-state.json")
};
const debugLogPath = path.join(__dirname, "pet-debug.log");

function debugLog(tag, message) {
    if (process.env.PET_DEBUG !== "1") return;
    try {
        fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] [${tag}] ${message}\n`);
    } catch {
        /* 日志失败不影响运行 */
    }
}

debugLog("app", `boot userData=${userDataDir}`);

// ---------- 本地状态 ----------
const rawPrefs = readJson(files.prefs, {});
const prefs = {
    size: clampInt(rawPrefs.size, PET_SIZE_DEFAULT, PET_SIZE_MIN, PET_SIZE_MAX),
    mirror: rawPrefs.mirror === true,
    muted: rawPrefs.muted === true,
    debug: rawPrefs.debug === true
};

const sessionState = readJson(files.session, {});
let token = String(sessionState.token || "").trim();

const reminderState = readJson(files.reminder, {});
let seen = new Set(Array.isArray(reminderState.seen) ? reminderState.seen.filter((key) => typeof key === "string") : []);
let intervalLastAt = Number(reminderState.intervalLastAt) || 0;
let workState =
    reminderState.work && typeof reminderState.work === "object"
        ? {
              date: String(reminderState.work.date || ""),
              start: reminderState.work.start === true,
              end: reminderState.work.end === true
          }
        : { date: "", start: false, end: false };

let displayState = readJson(files.display, null);

const api = createApi({ serverUrl, getToken: () => token });

// ---------- 运行时状态 ----------
let petWin = null;
let bubbleWin = null;
let settingsWin = null;
let loginWin = null;
let todoWin = null;
let tray = null;

let petHidden = false;
let allowQuit = false;
let hiding = false;
let hideTimer = null;
let welcomeOnReady = false;

let petDisplayId = Number(displayState && displayState.displayId) || 0;
let petWindowX = Number.isFinite(Number(displayState && displayState.x)) ? Number(displayState.x) : null;
let petWindowY = Number.isFinite(Number(displayState && displayState.y)) ? Number(displayState.y) : null;

let petDrag = null;
let hoverTimer = null;
let topGuardTimer = null;
let hoverInside = null;
let lastIgnore = null;
let lastFlip = null;
let saveMoveTimer = null;

let summary = null;
let settings = null;
let loggedIn = false;
let offline = false;
let lastSync = "";
let petImageDataUrl = "";
let currentPetImageUrl = "";

let bubbleType = null;
let bubbleData = null;
let bubbleVisible = false;
let bubbleHover = false;
let bubbleDirty = false;
let bubbleHideTimer = null;
let bubbleShowTimer = null;
let bubbleReady = false;
let bubbleSize = { width: 0, height: 0 };
let settingsSize = { width: 0, height: 0 };
let noticeQueue = [];
const snoozeTimers = new Set();

let pollTimer = null;
let tickTimer = null;

// ---------- 基础工具 ----------
function clampInt(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

// 高缩放屏幕下把 DIP 坐标对齐到物理像素，避免窗口边缘被 DWM 重采样。
function alignDip(value, scaleFactor) {
    const scale = Number(scaleFactor) || 1;
    return Math.round(value * scale) / scale;
}

function petWindowSize() {
    return {
        width: prefs.size + PET_PADDING * 2,
        // 小尺寸桌宠也要给右侧三连按钮留出竖向空间
        height: Math.max(prefs.size, PET_SIDE_STACK_HEIGHT) + PET_PADDING * 2
    };
}

function describeDisplays() {
    const primaryId = screen.getPrimaryDisplay().id;
    let secondaryIndex = 0;
    return screen.getAllDisplays().map((display) => {
        const primary = display.id === primaryId;
        const name = primary ? "主显示器" : `副显示器 ${++secondaryIndex}`;
        const scale = Number(display.scaleFactor) || 1;
        const width = Math.round(display.size.width * scale);
        const height = Math.round(display.size.height * scale);
        const scaleText = Math.abs(scale - 1) > 0.001 ? ` · 缩放 ${Math.round(scale * 100)}%` : "";
        return {
            id: display.id,
            primary,
            label: `${name} · ${width}×${height}${scaleText}`,
            scaleFactor: scale,
            width,
            height,
            display
        };
    });
}

function getSelectedDisplay() {
    const displays = screen.getAllDisplays();
    return displays.find((display) => display.id === petDisplayId) || screen.getPrimaryDisplay();
}

function getPetCenter() {
    if (petWin && !petWin.isDestroyed()) {
        const bounds = petWin.getBounds();
        return { x: bounds.x + PET_PADDING + prefs.size / 2, y: bounds.y + PET_PADDING + prefs.size / 2 };
    }
    const display = getSelectedDisplay();
    return { x: display.workArea.x + display.workArea.width / 2, y: display.workArea.y + display.workArea.height / 2 };
}

function defaultPetBounds(display) {
    const area = display.workArea;
    const { width, height } = petWindowSize();
    const scale = Number(display.scaleFactor) || 1;
    const x = alignDip(Math.max(area.x, area.x + area.width - width - PET_MARGIN), scale);
    const y = alignDip(Math.max(area.y, area.y + area.height - height - PET_MARGIN), scale);
    return { x, y, width, height };
}

function savePrefs() {
    writeJson(files.prefs, prefs);
}

function saveSession() {
    writeJson(files.session, { token });
}

function saveReminderState() {
    writeJson(files.reminder, {
        seen: Array.from(seen).slice(-200),
        intervalLastAt,
        work: workState
    });
}

function saveDisplayState() {
    if (!petWin || petWin.isDestroyed()) return;
    const bounds = petWin.getBounds();
    petWindowX = bounds.x;
    petWindowY = bounds.y;
    const display = screen.getDisplayMatching(bounds);
    petDisplayId = display.id;
    displayState = {
        displayId: petDisplayId,
        x: petWindowX,
        y: petWindowY,
        scaleFactor: display.scaleFactor,
        workArea: { width: display.workArea.width, height: display.workArea.height }
    };
    writeJson(files.display, displayState);
}

// ---------- 窗口状态 ----------
function shouldFlip() {
    if (!prefs.mirror) return false;
    const center = getPetCenter();
    const area = getSelectedDisplay().workArea;
    return center.x > area.x + area.width / 2;
}

function buildStatePayload() {
    const displays = describeDisplays();
    return {
        serverUrl,
        loggedIn,
        offline,
        muted: prefs.muted,
        size: prefs.size,
        mirror: prefs.mirror,
        debug: prefs.debug,
        flip: shouldFlip(),
        summary: summary
            ? {
                  today: summary.today,
                  now: summary.now,
                  stats: summary.stats,
                  preview: summary.preview,
                  nextReminder: summary.nextReminder
              }
            : null,
        settings,
        displays: displays.map(({ id, label, primary, scaleFactor, width, height, display }) => ({
            id,
            label,
            primary,
            scaleFactor,
            width,
            height,
            workArea: display.workArea
        })),
        currentDisplayId: petDisplayId
    };
}

function sendTo(win, channel, payload) {
    if (!win || win.isDestroyed()) return;
    try {
        win.webContents.send(channel, payload);
    } catch {
        /* 窗口销毁瞬间可能发送失败 */
    }
}

// 透明窗口直接 show 会"啪"地出现；页面侧先渲染到透明度 0，
// 量好尺寸后再显示，最后用 CSS transition 淡入，避开窗口首帧旧内容闪烁。
function showFloatingWindow(win, options) {
    if (!win || win.isDestroyed()) return;
    const opts = options || {};
    if (opts.focus) {
        win.show();
        win.focus();
    } else {
        win.showInactive();
    }
    try {
        win.webContents.invalidate();
    } catch {
        /* 旧版本没有该方法时忽略 */
    }
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
}

function broadcastState() {
    const payload = buildStatePayload();
    sendTo(petWin, "app:state", payload);
    sendTo(bubbleWin, "app:state", payload);
    sendTo(settingsWin, "app:state", payload);
    updateTrayMenu();
}

function sendPetImage() {
    sendTo(petWin, "app:pet-image", petImageDataUrl);
    sendTo(settingsWin, "app:pet-image", petImageDataUrl);
}

function updateFlip(force) {
    if (!petWin || petWin.isDestroyed()) return;
    const flip = shouldFlip();
    if (!force && flip === lastFlip) return;
    lastFlip = flip;
    sendTo(petWin, "pet:flip", flip);
}

async function syncPetImage(petImageUrl) {
    const target = String(petImageUrl || "").trim();
    if (target === currentPetImageUrl) return;
    currentPetImageUrl = target;
    if (!target) {
        petImageDataUrl = "";
        sendPetImage();
        return;
    }
    try {
        const dataUrl = await api.fetchPetImageDataUrl(target);
        if (currentPetImageUrl !== target) return;
        petImageDataUrl = dataUrl;
        sendPetImage();
    } catch {
        // 素材拉取失败时保留当前形象，避免桌宠突然消失
    }
}

// ---------- 桌宠窗口 ----------
function readReusablePosition() {
    const saved = displayState;
    const primary = screen.getPrimaryDisplay();
    const display = screen.getAllDisplays().find((item) => item.id === saved?.displayId) || primary;
    petDisplayId = display.id;
    const scale = Number(display.scaleFactor) || 1;
    const layoutChanged =
        (saved?.scaleFactor != null && Math.abs(saved.scaleFactor - scale) > 0.001) ||
        (saved?.workArea != null &&
            (saved.workArea.width !== display.workArea.width || saved.workArea.height !== display.workArea.height));
    const x = layoutChanged ? null : saved?.x;
    const y = layoutChanged ? null : saved?.y;
    const fallback = defaultPetBounds(display);
    const { width, height } = petWindowSize();
    const area = display.workArea;
    return {
        x: alignDip(
            clamp(Number.isFinite(Number(x)) ? Number(x) : fallback.x, area.x, area.x + area.width - width),
            scale
        ),
        y: alignDip(
            clamp(Number.isFinite(Number(y)) ? Number(y) : fallback.y, area.y, area.y + area.height - height),
            scale
        ),
        width,
        height
    };
}

function createPetWindow() {
    if (petWin && !petWin.isDestroyed()) return;
    petHidden = false;
    hiding = false;

    const bounds = readReusablePosition();
    petWin = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        thickFrame: false,
        show: false,
        title: "GitStatus 桌宠",
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    petWin.setMenuBarVisibility(false);
    petWin.setBackgroundColor("#00000000");
    petWin.setHasShadow(false);
    petWin.setAlwaysOnTop(true, "screen-saver");
    petWin.setIgnoreMouseEvents(true, { forward: false });
    lastIgnore = true;
    hoverInside = null;
    petWindowX = bounds.x;
    petWindowY = bounds.y;
    lastFlip = null;

    petWin.on("close", (event) => {
        if (allowQuit) return;
        event.preventDefault();
        hidePet();
    });

    petWin.on("closed", () => {
        petWin = null;
        petDrag = null;
        hoverInside = null;
        lastIgnore = null;
        hideBubble({ silent: true });
        updateTrayMenu();
    });

    petWin.on("focus", () => {
        keepPetOnTop();
    });
    petWin.on("blur", () => {
        setTimeout(keepPetOnTop, 80);
    });
    petWin.on("show", () => {
        setTimeout(keepPetOnTop, 30);
    });
    petWin.on("move", () => {
        if (petDrag) return;
        if (saveMoveTimer) clearTimeout(saveMoveTimer);
        saveMoveTimer = setTimeout(() => {
            saveMoveTimer = null;
            if (!petWin || petWin.isDestroyed()) return;
            saveDisplayState();
            updateFlip(false);
            repositionBubbleIfVisible();
        }, 400);
    });

    petWin.webContents.on("did-finish-load", () => {
        if (!petWin || petWin.isDestroyed()) return;
        sendTo(petWin, "app:state", buildStatePayload());
        sendPetImage();
        updateFlip(true);
    });

    petWin.webContents.on("render-process-gone", (_event, details) => {
        debugLog("pet", `render-process-gone ${details && details.reason}`);
    });

    petWin.once("ready-to-show", () => {
        if (!petWin || petWin.isDestroyed() || petHidden) return;
        petWin.showInactive();
        applyHoverIgnore(true);
        keepPetOnTop();
        repositionSettingsIfVisible();
        if (welcomeOnReady) {
            welcomeOnReady = false;
            setTimeout(() => showMiniNotice("welcome"), 120);
        }
        if (!token) {
            setTimeout(() => {
                if (petHidden || !petWin || petWin.isDestroyed()) return;
                if (!bubbleType) showPanel();
            }, 700);
        }
    });

    // 加载异常时兜底显示，避免窗口永远不出现
    setTimeout(() => {
        if (petWin && !petWin.isDestroyed() && !petHidden && !petWin.isVisible()) {
            petWin.showInactive();
        }
    }, 2000);

    void petWin.loadFile(path.join(rendererDir, "pet.html"));
    startHoverGuard();
    startTopGuard();
    updateTrayMenu();
}

function destroyPetWindow() {
    if (!petWin || petWin.isDestroyed()) return;
    const win = petWin;
    petWin = null;
    try {
        win.destroy();
    } catch {
        /* 已销毁时忽略 */
    }
}

function keepPetOnTop() {
    if (!petWin || petWin.isDestroyed() || petHidden) return;
    petWin.setAlwaysOnTop(true, "screen-saver");
}

function applyHoverIgnore(ignore) {
    if (!petWin || petWin.isDestroyed()) return;
    const value = Boolean(ignore);
    if (value === lastIgnore) return;
    lastIgnore = value;
    petWin.setIgnoreMouseEvents(value, { forward: false });
}

// 命中判断只看桌宠小窗口的屏幕矩形：光标在窗内才接收鼠标，其余全部穿透。
function startHoverGuard() {
    if (hoverTimer) return;
    hoverTimer = setInterval(() => {
        if (!petWin || petWin.isDestroyed() || petHidden) return;
        if (hiding) {
            hoverInside = null;
            applyHoverIgnore(true);
            return;
        }
        if (petDrag) {
            // 页面 rAF 停止 1.5 秒仍未收到 tick，说明拖动已经中断，主动收尾
            if (Date.now() - (petDrag.lastTick || 0) > 1500) {
                endPetDrag();
                return;
            }
            hoverInside = true;
            applyHoverIgnore(false);
            return;
        }
        const bounds = petWin.getBounds();
        const point = screen.getCursorScreenPoint();
        const inside =
            point.x >= bounds.x &&
            point.x < bounds.x + bounds.width &&
            point.y >= bounds.y &&
            point.y < bounds.y + bounds.height;
        if (inside === hoverInside) return;
        hoverInside = inside;
        applyHoverIgnore(!inside);
    }, 16);
    hoverTimer.unref?.();
}

function startTopGuard() {
    if (topGuardTimer) return;
    // 只补置顶标记，不周期性 moveTop：后者会干扰浏览器标签拖拽。
    topGuardTimer = setInterval(() => {
        if (petDrag || petHidden) return;
        keepPetOnTop();
    }, 5000);
    topGuardTimer.unref?.();
}

function movePetToDisplay(displayId) {
    const target = screen.getAllDisplays().find((display) => display.id === Number(displayId));
    if (!target || !petWin || petWin.isDestroyed()) {
        if (target) {
            petDisplayId = target.id;
            petWindowX = null;
            petWindowY = null;
            saveDisplayStateFromBounds(defaultPetBounds(target));
            updateTrayMenu();
        }
        return;
    }
    const bounds = defaultPetBounds(target);
    petDisplayId = target.id;
    petWindowX = bounds.x;
    petWindowY = bounds.y;
    petWin.setBounds(bounds);
    saveDisplayState();
    updateFlip(true);
    updateTrayMenu();
    repositionBubbleIfVisible();
    repositionSettingsIfVisible();
}

function saveDisplayStateFromBounds(bounds) {
    const display = screen.getDisplayMatching(bounds);
    petDisplayId = display.id;
    petWindowX = bounds.x;
    petWindowY = bounds.y;
    displayState = {
        displayId: petDisplayId,
        x: bounds.x,
        y: bounds.y,
        scaleFactor: display.scaleFactor,
        workArea: { width: display.workArea.width, height: display.workArea.height }
    };
    writeJson(files.display, displayState);
}

function handleDisplaysChanged() {
    if (!petWin || petWin.isDestroyed()) {
        updateTrayMenu();
        return;
    }
    const current = screen.getAllDisplays().find((display) => display.id === petDisplayId);
    if (!current) {
        const primary = screen.getPrimaryDisplay();
        petDisplayId = primary.id;
        petWin.setBounds(defaultPetBounds(primary));
    } else {
        const bounds = petWin.getBounds();
        const area = current.workArea;
        const x = alignDip(clamp(bounds.x, area.x, area.x + area.width - bounds.width), current.scaleFactor);
        const y = alignDip(clamp(bounds.y, area.y, area.y + area.height - bounds.height), current.scaleFactor);
        if (x !== bounds.x || y !== bounds.y) {
            petWin.setPosition(x, y);
        }
    }
    saveDisplayState();
    updateFlip(true);
    updateTrayMenu();
    repositionBubbleIfVisible();
    repositionSettingsIfVisible();
}

function resizePetForSize() {
    if (!petWin || petWin.isDestroyed()) return;
    const { width, height } = petWindowSize();
    const bounds = petWin.getBounds();
    if (bounds.width === width && bounds.height === height) return;
    const center = {
        x: bounds.x + PET_PADDING + prefs.size / 2,
        y: bounds.y + PET_PADDING + prefs.size / 2
    };
    const display = screen.getDisplayNearestPoint(center);
    const area = display.workArea;
    const x = alignDip(
        clamp(center.x - PET_PADDING - prefs.size / 2, area.x, area.x + area.width - width),
        display.scaleFactor
    );
    const y = alignDip(
        clamp(center.y - PET_PADDING - prefs.size / 2, area.y, area.y + area.height - height),
        display.scaleFactor
    );
    petWin.setBounds({ x, y, width, height });
    saveDisplayState();
    updateFlip(true);
    repositionBubbleIfVisible();
    repositionSettingsIfVisible();
}

// ---------- 拖动 ----------
function startPetDrag(offsetX, offsetY) {
    if (!petWin || petWin.isDestroyed() || petHidden) return;
    const { width, height } = petWindowSize();
    petDrag = {
        x: clamp(Number(offsetX) || width / 2, 0, width - 1),
        y: clamp(Number(offsetY) || height / 2, 0, height - 1),
        lastTick: Date.now()
    };
    hoverInside = true;
    applyHoverIgnore(false);
    hideBubble({ silent: true });
    closeSettingsWindow();
}

function movePetDragFrame() {
    if (!petDrag || !petWin || petWin.isDestroyed()) return;
    petDrag.lastTick = Date.now();
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    const { width, height } = petWindowSize();
    const x = alignDip(clamp(point.x - petDrag.x, area.x, area.x + area.width - width), display.scaleFactor);
    const y = alignDip(clamp(point.y - petDrag.y, area.y, area.y + area.height - height), display.scaleFactor);
    petDisplayId = display.id;
    const bounds = petWin.getBounds();
    if (bounds.x !== x || bounds.y !== y) {
        petWin.setPosition(x, y);
        petWindowX = x;
        petWindowY = y;
    }
    updateFlip(false);
}

function endPetDrag() {
    if (!petDrag) return;
    petDrag = null;
    hoverInside = null;
    applyHoverIgnore(true);
    saveDisplayState();
    updateFlip(false);
    updateTrayMenu();
    keepPetOnTop();
    repositionSettingsIfVisible();
    setTimeout(maybeShowNextReminder, 300);
}

// ---------- 气泡窗口 ----------
function createBubbleWindow() {
    if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;
    bubbleReady = false;
    bubbleWin = new BrowserWindow({
        width: 380,
        height: 260,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        thickFrame: false,
        focusable: true,
        title: "GitStatus 桌宠气泡",
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    bubbleWin.setMenuBarVisibility(false);
    bubbleWin.setBackgroundColor("#00000000");
    bubbleWin.setHasShadow(false);
    bubbleWin.setAlwaysOnTop(true, "screen-saver");
    if (process.env.PET_DEBUG === "1") {
        bubbleWin.webContents.on("console-message", (_event, _level, message) => {
            debugLog("bubble-renderer", message);
        });
    }

    bubbleWin.on("closed", () => {
        if (bubbleShowTimer) {
            clearTimeout(bubbleShowTimer);
            bubbleShowTimer = null;
        }
        bubbleWin = null;
        bubbleReady = false;
        bubbleVisible = false;
        bubbleType = null;
        bubbleData = null;
    });

    bubbleWin.webContents.on("did-finish-load", () => {
        bubbleReady = true;
        if (bubbleType) renderBubble(true);
    });

    void bubbleWin.loadFile(path.join(rendererDir, "bubble.html"));
    return bubbleWin;
}

function maxBubbleHeight() {
    const area = getSelectedDisplay().workArea;
    // 与网页版一致：面板最高 560px，避免超出工作区
    return Math.max(220, Math.min(560, area.height - 24));
}

function buildBubbleView(type) {
    if (type === "mini") {
        return {
            loggedIn,
            offline,
            serverUrl,
            compact: copy.buildMini({ loggedIn, summary })
        };
    }
    if (type === "panel") {
        return {
            loggedIn,
            offline,
            serverUrl,
            muted: prefs.muted,
            summary: summary
                ? {
                      today: summary.today,
                      now: summary.now,
                      stats: summary.stats,
                      preview: summary.preview,
                      nextReminder: summary.nextReminder
                  }
                : null
        };
    }
    return bubbleData || {};
}

function renderBubble(force) {
    if (!bubbleWin || bubbleWin.isDestroyed() || !bubbleType) return;
    if (!bubbleReady && !force) return;
    const data = buildBubbleView(bubbleType);
    sendTo(bubbleWin, "bubble:render", {
        type: bubbleType,
        data,
        maxHeight: maxBubbleHeight(),
        playSound: bubbleType === "reminder" && !prefs.muted
    });
}

function showBubble(type, data, autoHideMs) {
    if (!petWin || petWin.isDestroyed() || petHidden) return;
    debugLog("bubble", `show ${type} visible=${bubbleVisible}`);
    if (bubbleShowTimer) {
        clearTimeout(bubbleShowTimer);
        bubbleShowTimer = null;
    }
    bubbleType = type;
    bubbleData = data || null;
    bubbleDirty = false;
    createBubbleWindow();
    renderBubble();
    // 小气泡 / 完整面板 / 隐藏播报打开时，设置浮窗让位（与旧版同一个气泡容器一致）
    if (type === "mini" || type === "panel" || type === "notice") closeSettingsWindow();
    if (autoHideMs) scheduleBubbleHide(autoHideMs);
    else clearBubbleHide();
}

function scheduleBubbleHide(ms) {
    if (bubbleHideTimer) {
        clearTimeout(bubbleHideTimer);
        bubbleHideTimer = null;
    }
    if (!ms || bubbleHover) return;
    bubbleHideTimer = setTimeout(() => {
        bubbleHideTimer = null;
        if (bubbleHover) return;
        hideBubble();
    }, ms);
}

function clearBubbleHide() {
    if (!bubbleHideTimer) return;
    clearTimeout(bubbleHideTimer);
    bubbleHideTimer = null;
}

function hideBubble(options) {
    const opts = options || {};
    if (bubbleType) debugLog("bubble", `hide ${bubbleType}`);
    if (bubbleShowTimer) {
        clearTimeout(bubbleShowTimer);
        bubbleShowTimer = null;
    }
    clearBubbleHide();
    bubbleType = null;
    bubbleData = null;
    bubbleDirty = false;
    bubbleHover = false;
    bubbleSize = { width: 0, height: 0 };
    if (bubbleWin && !bubbleWin.isDestroyed() && bubbleVisible) {
        sendTo(bubbleWin, "bubble:hidden", true);
        bubbleWin.hide();
    }
    bubbleVisible = false;
    if (!opts.silent) setTimeout(maybeShowNextReminder, 350);
}

// 桌宠可视区域（不含窗口四周的透明内边距）
function petVisualRect() {
    if (!petWin || petWin.isDestroyed()) return null;
    const bounds = petWin.getBounds();
    return {
        left: bounds.x + PET_PADDING,
        top: bounds.y + PET_PADDING,
        right: bounds.x + PET_PADDING + prefs.size,
        bottom: bounds.y + PET_PADDING + prefs.size,
        width: prefs.size,
        height: prefs.size
    };
}

/**
 * 按旧版桌宠的贴边规则计算气泡/设置浮窗的位置：
 * - 面板：优先在桌宠上方，左右两种对齐依次尝试，放不下再看下方
 * - 小气泡：按桌宠在中线左右决定向左还是向右展开，优先上方
 * 返回的 x/y 是窗口坐标（已含透明内边距）。
 */
function computeFloatingBounds(mode, cardWidth, cardHeight) {
    const pet = petVisualRect();
    if (!pet) return null;
    const display = screen.getDisplayMatching({
        x: pet.left,
        y: pet.top,
        width: pet.width,
        height: pet.height
    });
    const area = display.workArea;
    const pad = BUBBLE_PADDING;
    const edge = 10;
    const gap = mode === "mini" ? 8 : 12;
    const width = cardWidth + pad * 2;
    const height = cardHeight + pad * 2;
    const isRight = pet.left + pet.width / 2 > area.x + area.width / 2;

    // 旧版小气泡会与桌宠重叠 20px，面板则在桌宠左右外侧 4px
    const rightAlignedLeft =
        mode === "mini" ? pet.left + 20 - cardWidth - pad : pet.right + 4 - cardWidth - pad;
    const leftAlignedLeft = mode === "mini" ? pet.right - 20 - pad : pet.left - 4 - pad;
    const aboveTop = pet.top - gap - cardHeight - pad;
    const belowTop = pet.bottom + gap - pad;

    const candidates = [];
    if (mode === "mini") {
        const x = isRight ? rightAlignedLeft : leftAlignedLeft;
        candidates.push({ above: true, alignRight: isRight, x, y: aboveTop });
        candidates.push({ above: false, alignRight: isRight, x, y: belowTop });
    } else {
        for (const above of [true, false]) {
            for (const alignRight of [true, false]) {
                candidates.push({
                    above,
                    alignRight,
                    x: alignRight ? rightAlignedLeft : leftAlignedLeft,
                    y: above ? aboveTop : belowTop
                });
            }
        }
    }

    const fits = (candidate) => {
        const cardLeft = candidate.x + pad;
        const cardTop = candidate.y + pad;
        return (
            cardLeft >= area.x + edge &&
            cardLeft + cardWidth <= area.x + area.width - edge &&
            cardTop >= area.y + edge &&
            cardTop + cardHeight <= area.y + area.height - edge
        );
    };
    let chosen = candidates.find(fits);
    if (!chosen) {
        chosen = { ...candidates[0] };
        const cardLeft = clamp(
            chosen.x + pad,
            area.x + edge,
            area.x + area.width - cardWidth - edge
        );
        const cardTop = clamp(
            chosen.y + pad,
            area.y + edge,
            area.y + area.height - cardHeight - edge
        );
        chosen.x = cardLeft - pad;
        chosen.y = cardTop - pad;
    }

    return {
        x: Math.round(alignDip(chosen.x, display.scaleFactor)),
        y: Math.round(alignDip(chosen.y, display.scaleFactor)),
        width,
        height,
        above: chosen.above,
        alignRight: chosen.alignRight
    };
}

function positionBubbleWindow(width, height) {
    if (!bubbleWin || bubbleWin.isDestroyed()) return { above: true, alignRight: true };
    const mode = bubbleType === "mini" || bubbleType === "notice" ? "mini" : "panel";
    const bounds = computeFloatingBounds(mode, width - BUBBLE_PADDING * 2, height - BUBBLE_PADDING * 2);
    if (!bounds) return { above: true, alignRight: true };
    bubbleWin.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    return { above: bounds.above, alignRight: bounds.alignRight };
}

function repositionBubbleIfVisible() {
    if (!bubbleVisible || !bubbleWin || bubbleWin.isDestroyed()) return;
    if (!bubbleSize.width || !bubbleSize.height) return;
    const placement = positionBubbleWindow(bubbleSize.width, bubbleSize.height);
    sendTo(bubbleWin, "bubble:placement", placement);
}

function applySettingsBounds() {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    if (!settingsSize.width || !settingsSize.height) return;
    let bounds = computeFloatingBounds(
        "panel",
        settingsSize.width - BUBBLE_PADDING * 2,
        settingsSize.height - BUBBLE_PADDING * 2
    );
    if (!bounds) {
        // 桌宠隐藏时从托盘打开设置，先贴到当前显示器右上角
        const area = getSelectedDisplay().workArea;
        bounds = {
            x: area.x + area.width - settingsSize.width - 20,
            y: area.y + 20,
            width: settingsSize.width,
            height: settingsSize.height
        };
    }
    settingsWin.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}

function repositionSettingsIfVisible() {
    if (!settingsWin || settingsWin.isDestroyed() || !settingsWin.isVisible()) return;
    applySettingsBounds();
}

function closeSettingsWindow() {
    if (settingsWin && !settingsWin.isDestroyed()) {
        try {
            settingsWin.close();
        } catch {
            /* 已销毁时忽略 */
        }
    }
    settingsWin = null;
    settingsSize = { width: 0, height: 0 };
}

function showMini() {
    showBubble("mini", null, 7000);
}

function showPanel() {
    showBubble("panel", null, 10000);
}

function toggleMini() {
    if (bubbleVisible && bubbleType === "mini") {
        hideBubble();
        return;
    }
    showMini();
}

function togglePanel() {
    if (bubbleVisible && bubbleType === "panel") {
        hideBubble();
        return;
    }
    showPanel();
}

function showMiniNotice(kind) {
    if (!petWin || petWin.isDestroyed() || petHidden) return;
    hideBubble({ silent: true });
    showBubble("notice", copy.buildNotice(kind), kind === "goodbye" ? 0 : 7000);
}

// ---------- 提醒队列 ----------
function enqueueNotice(notice) {
    if (!notice) return;
    // 桌宠收进托盘时不再排队，避免重新显示后一次性弹出一堆积压提醒
    if (petHidden || hiding) {
        notifySystem(notice);
        return;
    }
    if (noticeQueue.length >= 20) noticeQueue.shift();
    noticeQueue.push(notice);
    maybeShowNextReminder();
}

function notifySystem(notice) {
    if (!notice || !Notification.isSupported()) return;
    try {
        new Notification({
            title: notice.kicker || "待办提醒",
            body: notice.title || "",
            silent: prefs.muted
        }).show();
    } catch {
        /* 通知失败不影响提醒队列 */
    }
}

function maybeShowNextReminder() {
    if (noticeQueue.length === 0) return;
    if (!petWin || petWin.isDestroyed() || petHidden || hiding || petDrag) return;
    if (bubbleType === "reminder" || bubbleType === "panel") return;
    // 旧版设置面板打开时提醒会排队，这里保持同样行为
    if (settingsWin && !settingsWin.isDestroyed()) return;
    const notice = noticeQueue.shift();
    showBubble("reminder", notice, 30000);
    sendTo(petWin, "pet:alert", true);
    // 桌宠窗口异常消失时用系统通知兜底；气泡可见时不再重复弹通知
    if (!petVisible()) notifySystem(notice);
}

function petVisible() {
    return Boolean(petWin && !petWin.isDestroyed() && petWin.isVisible() && !petHidden);
}

// ---------- 显示 / 隐藏 ----------
function hidePet() {
    if (!petWin || petWin.isDestroyed() || petHidden) return;
    if (hiding) {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
            finishHide();
        }
        return;
    }
    hiding = true;
    noticeQueue = [];
    showMiniNotice("goodbye");
    hideTimer = setTimeout(() => {
        hideTimer = null;
        finishHide();
    }, 1200);
}

function finishHide() {
    if (!hiding) return;
    // 销毁前再存一次位置，避免隐藏后丢失最后一次移动
    saveDisplayState();
    hiding = false;
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    petHidden = true;
    hideBubble({ silent: true });
    closeSettingsWindow();
    destroyPetWindow();
    updateTrayMenu();
}

function showPet() {
    if (petHidden || !petWin || petWin.isDestroyed()) {
        const wasHidden = petHidden;
        petHidden = false;
        welcomeOnReady = wasHidden;
        createPetWindow();
        updateTrayMenu();
        return;
    }
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    hiding = false;
    petHidden = false;
    hoverInside = null;
    lastIgnore = null;
    petWin.showInactive();
    applyHoverIgnore(true);
    keepPetOnTop();
    setTimeout(keepPetOnTop, 30);
    repositionSettingsIfVisible();
    sendTo(petWin, "app:state", buildStatePayload());
    sendTo(petWin, "pet:alert", false);
    showMiniNotice("welcome");
    updateTrayMenu();
}

function restartDesktop() {
    allowQuit = true;
    const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portableExecutable) app.relaunch({ execPath: portableExecutable });
    else app.relaunch();
    app.exit(0);
}

// ---------- 外部程序 / 窗口 ----------
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

function openLoginWindow() {
    closeSettingsWindow();
    if (loginWin && !loginWin.isDestroyed()) {
        loginWin.show();
        loginWin.focus();
        return;
    }
    const area = getSelectedDisplay().workArea;
    const width = Math.min(460, area.width);
    const height = Math.min(620, area.height);
    loginWin = new BrowserWindow({
        width,
        height,
        x: area.x + Math.max(0, Math.floor((area.width - width) / 2)),
        y: area.y + Math.max(0, Math.floor((area.height - height) / 2)),
        minWidth: Math.min(380, width),
        minHeight: Math.min(520, height),
        title: "登录 GitStatus 桌宠",
        autoHideMenuBar: true,
        backgroundColor: "#f3f7f2",
        icon: trayIconPath,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    loginWin.setMenuBarVisibility(false);
    loginWin.loadURL(loginUrl).catch(() => {
        if (loginWin && !loginWin.isDestroyed()) {
            void loginWin.loadFile(offlinePage, { query: { server: serverUrl, target: "login" } });
        }
    });
    loginWin.on("closed", () => {
        loginWin = null;
        maybeShowNextReminder();
    });
}

function openTodoWindow(add, forceReload) {
    closeSettingsWindow();
    const target = `${todoUrl}${add ? "?add=1" : ""}`;
    if (todoWin && !todoWin.isDestroyed()) {
        todoWin.show();
        todoWin.focus();
        if (forceReload || add || !String(todoWin.webContents.getURL()).includes("/pages/todo.html")) {
            void todoWin.loadURL(target);
        }
        return;
    }
    const area = getSelectedDisplay().workArea;
    const width = Math.min(1280, area.width);
    const height = Math.min(860, area.height);
    todoWin = new BrowserWindow({
        width,
        height,
        x: area.x + Math.max(0, Math.floor((area.width - width) / 2)),
        y: area.y + Math.max(0, Math.floor((area.height - height) / 2)),
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
    todoWin.loadURL(target).catch(() => {
        if (todoWin && !todoWin.isDestroyed()) {
            void todoWin.loadFile(offlinePage, { query: { server: serverUrl, target: "todo" } });
        }
    });
    todoWin.on("closed", () => {
        todoWin = null;
        maybeShowNextReminder();
    });
}

function openSettingsWindow() {
    if (settingsWin && !settingsWin.isDestroyed()) {
        applySettingsBounds();
        if (settingsWin.isVisible()) {
            settingsWin.focus();
            settingsWin.moveTop();
        } else {
            showFloatingWindow(settingsWin, { focus: true });
            sendTo(settingsWin, "settings:shown", true);
        }
        return;
    }
    hideBubble({ silent: true });
    const width = SETTINGS_WIDTH + BUBBLE_PADDING * 2;
    const cardHeight = Math.min(560, getSelectedDisplay().workArea.height - 24);
    settingsSize = { width, height: cardHeight + BUBBLE_PADDING * 2 };
    settingsWin = new BrowserWindow({
        width,
        height: settingsSize.height,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        thickFrame: false,
        focusable: true,
        title: "GitStatus 桌宠设置",
        icon: trayIconPath,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    settingsWin.setMenuBarVisibility(false);
    settingsWin.setBackgroundColor("#00000000");
    settingsWin.setHasShadow(false);
    settingsWin.setAlwaysOnTop(true, "screen-saver");
    if (process.env.PET_DEBUG === "1") {
        settingsWin.webContents.on("console-message", (_event, _level, message) => {
            debugLog("settings-renderer", message);
        });
    }
    // 等页面量好高度再显示；1 秒没量到就按默认高度贴到桌宠旁
    settingsWin.once("ready-to-show", () => {
        setTimeout(() => {
            if (!settingsWin || settingsWin.isDestroyed() || settingsWin.isVisible()) return;
            applySettingsBounds();
            showFloatingWindow(settingsWin, { focus: true });
            sendTo(settingsWin, "settings:shown", true);
        }, 900);
    });
    settingsWin.on("closed", () => {
        settingsWin = null;
        settingsSize = { width: 0, height: 0 };
        maybeShowNextReminder();
    });
    void settingsWin.loadFile(path.join(rendererDir, "settings.html"));
}

// 设置窗口打开后，主进程同步一次完整状态
function settingsStatePayload() {
    debugLog("settings", `state petImage=${petImageDataUrl ? petImageDataUrl.length : 0} loggedIn=${loggedIn} offline=${offline}`);
    return {
        ...buildStatePayload(),
        petImage: petImageDataUrl
    };
}

async function quickStartProjects() {
    const result = await api.quickStartProjects();
    if (!result.ok || !result.json || result.json.res === false) {
        const message = (result.json && result.json.message) || (result.networkError ? "后台还没有启动喵" : `请求失败（HTTP ${result.status}）`);
        dialog.showErrorBox("一键启动后台失败", message);
        return;
    }
    const started = Array.isArray(result.json.started) ? result.json.started.length : 0;
    const skipped = Array.isArray(result.json.skipped) ? result.json.skipped.length : 0;
    const failed = Array.isArray(result.json.failed) ? result.json.failed.length : 0;
    const body = `已启动 ${started} 个，跳过 ${skipped} 个，失败 ${failed} 个`;
    if (Notification.isSupported()) {
        new Notification({ title: "一键启动后台", body, silent: true }).show();
    } else {
        dialog.showMessageBox({ type: "info", title: "一键启动后台", message: body });
    }
}
// ---------- 托盘 ----------
function updateTrayMenu() {
    if (!tray) return;
    const visible = Boolean(petWin && !petWin.isDestroyed() && !petHidden);
    const displays = describeDisplays();
    const pending = Math.max(0, Number(summary && summary.stats && summary.stats.pending) || 0);
    tray.setToolTip(pending > 0 ? `GitStatus 桌宠 · 还有 ${pending} 条待办喵` : "GitStatus 桌宠");
    const template = [
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
        { label: "打开待办", click: () => openTodoWindow(false) },
        { label: "桌宠设置", click: () => openSettingsWindow() },
        ...(token ? [] : [{ label: "登录 GitStatus", click: () => openLoginWindow() }]),
        { label: "一键启动后台", click: () => void quickStartProjects() },
        { label: "重启桌宠", click: restartDesktop },
        { type: "separator" },
        { label: "退出桌宠", click: () => app.quit() }
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
    if (tray) return;
    const icon = nativeImage.createFromPath(trayIconPath);
    tray = new Tray(icon);
    tray.setToolTip("GitStatus 桌宠");
    tray.on("click", () => {
        if (petWin && !petWin.isDestroyed() && !petHidden) hidePet();
        else showPet();
    });
    updateTrayMenu();
}

// ---------- 设置与数据 ----------
const CLIENT_DEFAULTS = {
    intervalEnabled: true,
    intervalMinutes: 60,
    intervalWithinWorkHours: false,
    workStart: "09:00",
    workEnd: "18:00",
    workStartEnabled: true,
    workEndEnabled: true,
    dueLeadMinutes: 15
};

function toBoundedInt(value, fallback, min, max) {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeTimeText(value, fallback) {
    const text = String(value || "");
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
        intervalEnabled: source.intervalEnabled !== false,
        intervalMinutes: toBoundedInt(source.intervalMinutes, CLIENT_DEFAULTS.intervalMinutes, 5, 480),
        intervalWithinWorkHours: source.intervalWithinWorkHours === true,
        workStart: normalizeTimeText(source.workStart, CLIENT_DEFAULTS.workStart),
        workEnd: normalizeTimeText(source.workEnd, CLIENT_DEFAULTS.workEnd),
        workStartEnabled: source.workStartEnabled !== false,
        workEndEnabled: source.workEndEnabled !== false,
        dueLeadMinutes: toBoundedInt(source.dueLeadMinutes, CLIENT_DEFAULTS.dueLeadMinutes, 0, 1440),
        petImageUrl: typeof source.petImageUrl === "string" ? source.petImageUrl : "",
        updatedAt: source.updatedAt || null
    };
}

function clearSessionAndSummary() {
    token = "";
    saveSession();
    summary = null;
    settings = null;
    loggedIn = false;
    lastSync = "";
    currentPetImageUrl = "";
    petImageDataUrl = "";
    sendPetImage();
}

async function refreshSummary() {
    if (!token) {
        // 未登录时也探一次接口，用来判断后端是否在运行
        const probe = await api.summary("");
        offline = probe.networkError;
        loggedIn = false;
        summary = null;
        broadcastState();
        refreshOpenBubble();
        return;
    }

    const result = await api.summary(lastSync);
    if (result.networkError) {
        offline = true;
        broadcastState();
        refreshOpenBubble();
        return;
    }
    if (result.status === 401) {
        clearSessionAndSummary();
        offline = false;
        broadcastState();
        refreshOpenBubble();
        return;
    }
    if (!result.ok || !result.json || !result.json.res) {
        offline = result.status >= 500;
        broadcastState();
        refreshOpenBubble();
        return;
    }

    offline = false;
    loggedIn = true;
    summary = result.json;
    if (result.json.settings && typeof result.json.settings === "object") {
        settings = normalizeSettings(result.json.settings);
        void syncPetImage(settings.petImageUrl);
    }
    if (typeof result.json.now === "string" && result.json.now) lastSync = result.json.now;
    handleIncoming(result.json.events, result.json.dueSoon);
    updateTrayMenu();
    broadcastState();
    refreshOpenBubble();
    runLocalReminderChecks();
}

function refreshOpenBubble() {
    if (!bubbleVisible || !bubbleType) return;
    if (bubbleType === "reminder" || bubbleType === "notice") return;
    if (bubbleHover) {
        bubbleDirty = true;
        return;
    }
    renderBubble();
}

function handleIncoming(events, dueSoon) {
    const fresh = [];
    const accept = (key, notice) => {
        if (!notice || typeof key !== "string" || !key) return;
        if (seen.has(key)) return;
        seen.add(key);
        fresh.push(notice);
    };
    if (Array.isArray(events)) {
        for (const event of events) {
            if (event) accept(event.key, copy.makeServerNotice(event, summary?.today));
        }
    }
    if (Array.isArray(dueSoon)) {
        for (const item of dueSoon) {
            if (item) accept(item.key, copy.makeDueNotice(item));
        }
    }
    if (fresh.length === 0) return;
    seen = new Set(Array.from(seen).slice(-200));
    saveReminderState();
    for (const notice of fresh) noticeQueue.push(notice);
    maybeShowNextReminder();
}

function currentStats() {
    return copy.currentStats(summary);
}

const pad2 = (value) => String(value).padStart(2, "0");

function localDayKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function timeToMinutes(text) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text || ""));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function withinWorkHours(current, date) {
    const start = timeToMinutes(current.workStart);
    const end = timeToMinutes(current.workEnd);
    if (start === null || end === null || end <= start) return true;
    const nowMinutes = minutesOfDay(date);
    return nowMinutes >= start && nowMinutes < end;
}

function runLocalReminderChecks() {
    if (!token || !settings) return;
    const now = new Date();
    maybeIntervalReminder(now);
    maybeWorkMomentReminder(now);
}

function maybeIntervalReminder(now) {
    if (!settings || !settings.intervalEnabled) return;
    const { pending, overdue } = currentStats();
    if (pending <= 0) return;
    if (settings.intervalWithinWorkHours && !withinWorkHours(settings, now)) return;

    const intervalMs = Math.max(1, Number(settings.intervalMinutes) || 60) * 60000;
    const nowMs = now.getTime();
    if (!intervalLastAt) {
        intervalLastAt = nowMs;
        saveReminderState();
        return;
    }
    const elapsed = nowMs - intervalLastAt;
    if (elapsed < intervalMs) return;
    // 桌面版长时间未运行时不补发，重新开始计时
    if (elapsed > intervalMs * 2) {
        intervalLastAt = nowMs;
        saveReminderState();
        return;
    }
    intervalLastAt = nowMs;
    saveReminderState();
    enqueueNotice(copy.makeIntervalNotice(pending, overdue));
}

function maybeWorkMomentReminder(now) {
    if (!settings) return;
    const { pending, overdue } = currentStats();
    if (pending <= 0) return;

    const dayKey = localDayKey(now);
    let changed = false;
    if (workState.date !== dayKey) {
        workState = { date: dayKey, start: false, end: false };
        changed = true;
    }
    const current = minutesOfDay(now);
    const grace = Math.max(1, WORK_GRACE_MINUTES);

    if (settings.workStartEnabled && !workState.start) {
        const start = timeToMinutes(settings.workStart);
        if (start !== null) {
            if (current >= start && current < start + grace) {
                workState.start = true;
                saveReminderState();
                enqueueNotice(copy.makeWorkStartNotice(pending));
                return;
            }
            if (current >= start + grace) {
                workState.start = true;
                changed = true;
            }
        }
    }

    if (settings.workEndEnabled && !workState.end) {
        const end = timeToMinutes(settings.workEnd);
        if (end !== null) {
            if (current >= end && current < end + grace) {
                workState.end = true;
                saveReminderState();
                enqueueNotice(copy.makeWorkEndNotice(pending, overdue));
                return;
            }
            if (current >= end + grace) {
                workState.end = true;
                changed = true;
            }
        }
    }

    if (changed) saveReminderState();
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = setInterval(() => void refreshSummary(), POLL_MS);
    tickTimer = setInterval(runLocalReminderChecks, TICK_MS);
    void refreshSummary();
}

async function saveSettingsFromRenderer(payload) {
    const result = await api.saveSettings(payload);
    if (result.networkError) return { ok: false, message: "后台还没有启动喵" };
    const json = result.json || {};
    if (!result.ok || !json.res) {
        return { ok: false, message: json.message || `保存失败（${result.status}）` };
    }
    settings = normalizeSettings(json.settings);
    // 重新开始间隔计时，且清空当天已提醒标记，避免刚改完设置就立刻弹一次
    intervalLastAt = Date.now();
    workState = { date: "", start: false, end: false };
    saveReminderState();
    void syncPetImage(settings.petImageUrl);
    broadcastState();
    void refreshSummary();
    return { ok: true, settings };
}

async function uploadPetFromRenderer(payload) {
    const bytes = payload && payload.bytes;
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const result = await api.uploadPetImage(buffer, payload && payload.mime, payload && payload.name);
    if (result.networkError) return { ok: false, message: "后台还没有启动喵" };
    const json = result.json || {};
    if (!result.ok || !json.res) {
        return { ok: false, message: json.message || `上传失败（${result.status}）` };
    }
    settings = normalizeSettings(json.settings);
    currentPetImageUrl = "";
    petImageDataUrl = "";
    await syncPetImage(settings.petImageUrl);
    broadcastState();
    return { ok: true, settings };
}

async function deletePetFromRenderer() {
    const result = await api.deletePetImage();
    if (result.networkError) return { ok: false, message: "后台还没有启动喵" };
    const json = result.json || {};
    if (!result.ok || !json.res) {
        return { ok: false, message: json.message || `恢复默认失败（${result.status}）` };
    }
    settings = normalizeSettings(json.settings);
    currentPetImageUrl = "";
    petImageDataUrl = "";
    sendPetImage();
    broadcastState();
    return { ok: true, settings };
}

// ---------- 右键菜单 ----------
function showPetContextMenu() {
    if (!petWin || petWin.isDestroyed()) return;
    Menu.buildFromTemplate([
        { label: "查看今日待办", click: () => showPanel() },
        { label: "打开待办", click: () => openTodoWindow(false) },
        { label: "新建待办", click: () => openTodoWindow(true) },
        { label: "桌宠设置", click: () => openSettingsWindow() },
        { type: "separator" },
        { label: "隐藏桌宠", click: () => hidePet() },
        { label: "退出桌宠", click: () => app.quit() }
    ]).popup({ window: petWin });
}

// ---------- IPC ----------
function senderIs(event, win) {
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
}

function senderIsApp(event) {
    return [petWin, bubbleWin, settingsWin, loginWin, todoWin].some((win) => senderIs(event, win));
}

function bubbleAutoHideMs(type) {
    if (type === "reminder") return 30000;
    if (type === "panel") return 10000;
    return 7000;
}

function handleBubbleAction(action, payload) {
    switch (action) {
        case "open-todo":
            openTodoWindow(false);
            hideBubble({ silent: true });
            break;
        case "open-todo-add":
            openTodoWindow(true);
            hideBubble({ silent: true });
            break;
        case "open-settings":
            openSettingsWindow();
            break;
        case "open-login":
            openLoginWindow();
            hideBubble({ silent: true });
            break;
        case "hide-pet":
            hideBubble({ silent: true });
            hidePet();
            break;
        case "close":
            hideBubble();
            break;
        case "quit":
            app.quit();
            break;
        case "toggle-mute":
            prefs.muted = !prefs.muted;
            savePrefs();
            broadcastState();
            if (bubbleVisible && bubbleType === "panel") renderBubble(true);
            break;
        case "snooze": {
            const notice = bubbleData;
            const minutes = clamp(Number(payload && payload.minutes) || 0, 1, 120);
            if (notice && minutes > 0) {
                const timer = setTimeout(() => {
                    snoozeTimers.delete(timer);
                    noticeQueue.unshift({ ...notice, snoozeMinutes: 0 });
                    maybeShowNextReminder();
                }, minutes * 60000);
                snoozeTimers.add(timer);
            }
            hideBubble();
            break;
        }
        case "retry":
            // 保留气泡，等待 refreshSummary 把离线状态刷新掉后自动重渲染
            void refreshSummary();
            break;
        case "open-external":
            openExternal(payload && payload.url);
            break;
        default:
            break;
    }
}

function registerIpc() {
    ipcMain.handle("app:get-state", (event) => (senderIsApp(event) ? settingsStatePayload() : null));
    ipcMain.handle("app:get-pet-image", (event) => (senderIsApp(event) ? petImageDataUrl : ""));

    ipcMain.on("app:open-todo", (event, add) => {
        if (!senderIsApp(event)) return;
        openTodoWindow(Boolean(add));
    });
    ipcMain.on("app:open-todo-add", (event) => {
        if (!senderIsApp(event)) return;
        openTodoWindow(true);
    });
    ipcMain.on("app:open-settings", (event) => {
        if (!senderIsApp(event)) return;
        openSettingsWindow();
    });
    ipcMain.on("app:open-login", (event) => {
        if (!senderIsApp(event)) return;
        openLoginWindow();
    });
    ipcMain.on("app:hide-pet", (event) => {
        if (!senderIsApp(event)) return;
        hidePet();
    });
    ipcMain.on("app:quit", (event) => {
        if (!senderIsApp(event)) return;
        app.quit();
    });
    ipcMain.on("app:open-external", (event, url) => {
        if (!senderIsApp(event)) return;
        openExternal(url);
    });
    ipcMain.on("app:retry", (event) => {
        if (senderIs(event, loginWin)) {
            loginWin.loadURL(loginUrl).catch(() => {
                if (loginWin && !loginWin.isDestroyed()) {
                    void loginWin.loadFile(offlinePage, { query: { server: serverUrl, target: "login" } });
                }
            });
            return;
        }
        if (senderIs(event, todoWin)) {
            openTodoWindow(false, true);
            return;
        }
        if (senderIsApp(event)) void refreshSummary();
    });

    ipcMain.on("app:login-done", (event, nextToken) => {
        if (!senderIs(event, loginWin)) return;
        const value = String(nextToken || "").trim();
        if (value) {
            token = value;
            saveSession();
        }
        if (loginWin && !loginWin.isDestroyed()) loginWin.close();
        loginWin = null;
        summary = null;
        loggedIn = Boolean(token);
        offline = false;
        lastSync = "";
        currentPetImageUrl = "";
        petImageDataUrl = "";
        sendPetImage();
        void refreshSummary();
        broadcastState();
        if (petWin && !petHidden) showMiniNotice("welcome");
    });

    // 桌宠窗口
    ipcMain.on("pet:toggle-mini", (event) => {
        if (!senderIs(event, petWin)) return;
        toggleMini();
    });
    ipcMain.on("pet:toggle-panel", (event) => {
        if (!senderIs(event, petWin)) return;
        debugLog("pet", `toggle-panel visible=${bubbleVisible} type=${bubbleType || "-"}`);
        togglePanel();
    });
    ipcMain.on("pet:context-menu", (event) => {
        if (!senderIs(event, petWin)) return;
        showPetContextMenu();
    });
    ipcMain.on("pet:alert-done", () => {
        /* 页面自行结束抖动动画，这里只保留通道 */
    });
    ipcMain.on("pet:drag-start", (event, offset) => {
        if (!senderIs(event, petWin)) return;
        startPetDrag(offset && offset.x, offset && offset.y);
    });
    ipcMain.on("pet:drag-tick", (event) => {
        if (!senderIs(event, petWin)) return;
        movePetDragFrame();
    });
    ipcMain.on("pet:drag-end", (event) => {
        if (!senderIs(event, petWin)) return;
        endPetDrag();
    });

    // 气泡窗口
    ipcMain.on("bubble:resize", (event, size) => {
        if (!senderIs(event, bubbleWin)) return;
        // 页面刚加载完、还没有渲染内容时不要显示空窗
        if (!bubbleType) return;
        const width = clamp(Math.ceil(Number(size && size.width) || 0), 120, 560);
        const height = clamp(
            Math.ceil(Number(size && size.height) || 0),
            60,
            maxBubbleHeight() + BUBBLE_PADDING * 2
        );
        if (!width || !height) return;
        bubbleSize = { width, height };
        if (!bubbleWin || bubbleWin.isDestroyed()) return;
        const placement = positionBubbleWindow(width, height);
        sendTo(bubbleWin, "bubble:placement", placement);
        if (!bubbleVisible && !bubbleShowTimer) {
            // 给渲染进程一帧时间，把卡片先画成透明再显示窗口
            bubbleShowTimer = setTimeout(() => {
                bubbleShowTimer = null;
                if (!bubbleWin || bubbleWin.isDestroyed() || bubbleVisible || !bubbleType) return;
                bubbleVisible = true;
                showFloatingWindow(bubbleWin, {});
                sendTo(bubbleWin, "bubble:shown", true);
            }, 24);
        }
    });
    ipcMain.on("bubble:hover", (event, value) => {
        if (!senderIs(event, bubbleWin)) return;
        bubbleHover = Boolean(value);
        if (bubbleHover) {
            clearBubbleHide();
            return;
        }
        if (bubbleDirty) {
            bubbleDirty = false;
            renderBubble(true);
        }
        scheduleBubbleHide(bubbleAutoHideMs(bubbleType));
    });
    ipcMain.on("bubble:close", (event) => {
        if (!senderIs(event, bubbleWin)) return;
        hideBubble();
    });
    ipcMain.on("bubble:action", (event, action, payload) => {
        if (!senderIs(event, bubbleWin)) return;
        handleBubbleAction(String(action || ""), payload || {});
    });

    // 设置窗口
    ipcMain.handle("settings:get-state", (event) => (senderIs(event, settingsWin) ? settingsStatePayload() : null));
    ipcMain.handle("settings:save", async (event, payload) => {
        if (!senderIs(event, settingsWin)) return { ok: false, message: "窗口已失效" };
        return saveSettingsFromRenderer(payload);
    });
    ipcMain.handle("settings:upload-pet", async (event, payload) => {
        if (!senderIs(event, settingsWin)) return { ok: false, message: "窗口已失效" };
        return uploadPetFromRenderer(payload);
    });
    ipcMain.handle("settings:delete-pet", async (event) => {
        if (!senderIs(event, settingsWin)) return { ok: false, message: "窗口已失效" };
        return deletePetFromRenderer();
    });
    ipcMain.handle("settings:set-pref", (event, key, value) => {
        if (!senderIs(event, settingsWin)) return { ok: false };
        if (key === "size") {
            prefs.size = clampInt(value, prefs.size, PET_SIZE_MIN, PET_SIZE_MAX);
            resizePetForSize();
        } else if (key === "mirror" || key === "muted" || key === "debug") {
            prefs[key] = Boolean(value);
        } else {
            return { ok: false };
        }
        savePrefs();
        broadcastState();
        updateFlip(true);
        if (bubbleVisible && bubbleType === "panel") renderBubble(true);
        return { ok: true, prefs: { ...prefs } };
    });
    ipcMain.on("settings:move-display", (event, displayId) => {
        if (!senderIs(event, settingsWin)) return;
        movePetToDisplay(displayId);
    });
    ipcMain.on("settings:close", (event) => {
        if (!senderIs(event, settingsWin)) return;
        settingsWin.close();
    });
    ipcMain.on("settings:resize", (event, size) => {
        if (!senderIs(event, settingsWin)) return;
        const width = clamp(Math.ceil(Number(size && size.width) || 0), 260, 600);
        const height = clamp(Math.ceil(Number(size && size.height) || 0), 120, 720);
        if (!width || !height) return;
        settingsSize = { width, height };
        applySettingsBounds();
        if (!settingsWin.isVisible()) {
            showFloatingWindow(settingsWin, { focus: true });
            sendTo(settingsWin, "settings:shown", true);
        }
        settingsWin.setAlwaysOnTop(true, "screen-saver");
    });
}

// ---------- 全局网络策略 ----------
app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
        if (url.startsWith("file:") || url.startsWith("devtools:")) return;
        try {
            if (new URL(url).origin === new URL(serverUrl).origin) return;
        } catch {
            /* 非法地址按外部处理 */
        }
        event.preventDefault();
        openExternal(url);
    });
});

// ---------- 生命周期 ----------
const hasLock = app.requestSingleInstanceLock();
debugLog("app", `singleInstanceLock=${hasLock}`);
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
        if (pollTimer) clearInterval(pollTimer);
        if (tickTimer) clearInterval(tickTimer);
        for (const timer of snoozeTimers) clearTimeout(timer);
        snoozeTimers.clear();
        saveDisplayState();
    });

    app.on("second-instance", () => {
        showPet();
    });

    app.on("browser-window-focus", () => {
        // 桌宠与其他窗口完全独立：不因待办/登录/设置获得焦点而降层或强制穿透
        if (petWin && !petWin.isDestroyed() && !petHidden) {
            setTimeout(keepPetOnTop, 50);
        }
    });

    app.whenReady().then(() => {
        debugLog(
            "app",
            `ready displays=${screen.getAllDisplays().length} primary=${screen.getPrimaryDisplay().workArea.width}x${screen.getPrimaryDisplay().workArea.height}`
        );
        registerIpc();
        createPetWindow();
        // 预热气泡窗口：第一次点击时不用等页面加载，直接量高、淡入
        createBubbleWindow();
        createTray();
        screen.on("display-metrics-changed", handleDisplaysChanged);
        screen.on("display-added", handleDisplaysChanged);
        screen.on("display-removed", handleDisplaysChanged);
        startPolling();
    });

    app.on("will-quit", () => {
        if (tray) {
            tray.destroy();
            tray = null;
        }
    });

    app.on("window-all-closed", () => {
        // 托盘常驻应用：桌宠隐藏时不能退出进程
    });

    app.on("activate", () => {
        showPet();
    });
}
