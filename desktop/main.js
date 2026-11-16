/* ============================================================
   GitStatus 桌宠 Windows 桌面版
   - 透明、无边框、置顶覆盖主显示器工作区，加载后端 /pages/desktop-pet.html
   - 透明区域点击穿透，桌宠与气泡区域可交互
   - 桌宠在覆盖层内拖动，位置由桌宠组件写入 localStorage
   ============================================================ */
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, dialog, Notification } = require("electron");
const fs = require("fs");
const path = require("path");

// 透明置顶窗在 Windows 上以分层窗口合成。硬件合成在部分显卡/驱动下
// 拖动时会出现方向性闪烁；桌宠内容很轻，改用软件合成更稳定。
app.disableHardwareAcceleration();
// 桌宠常年不聚焦：允许提醒音自动播放，并关闭后台节流
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
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

// PET_DEBUG=1 时把窗口诊断日志落到 desktop/pet-debug.log：
// Windows 下 Electron 主进程的 stdout 在部分启动方式里不会回到终端，落盘最可靠。
const debugLogPath = path.join(__dirname, "pet-debug.log");
function debugLog(tag, message) {
    if (process.env.PET_DEBUG !== "1") return;
    try {
        fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] [${tag}] ${message}\n`);
    } catch {
        /* 日志失败不影响运行 */
    }
}
// 带上启动时间戳，避免 Electron 缓存住旧的桌宠 HTML，
// 导致页面还在引用上一版 pet-widget.js（拖动/交互修复不生效）。
const petUrl = `${serverUrl}/pages/desktop-pet.html?v=${Date.now()}`;
const loginUrl = `${serverUrl}/pages/desktop-login.html`;

let petWin = null;
let loginWin = null;
let todoWin = null;
let tray = null;
let hiding = false;
let hideStartedAt = 0;
let hideTimer = null;
let petHidden = false;
let overlaySuspended = false;
let petShapeSupported = false;
let petShapeReady = false;
let lastPetShapeKey = "";
let topGuardTimer = null;
let allowQuit = false;
let petDisplayId = 0;

// 桌宠只占一个局部舞台，避免全屏透明置顶层持续参与浏览器合成。
const PET_STAGE_WIDTH = 420;
const PET_STAGE_HEIGHT = 720;
const PET_STAGE_MARGIN = 18;
let petWindowX = null;
let petWindowY = null;
let petAnchorRight = true;
let petAnchorBottom = true;
let petDragOffset = null;
let petDragDisplay = null;
let petDragActive = false;
let petHitRegions = [];
let petHoverInside = null;
let petHoverTimer = null;

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

// 所有窗口统一接管 window.open / target=_blank：
// 交给系统默认浏览器，否则 Electron 会弹出一个空白的内置窗口。
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

// Windows 下透明置顶窗在焦点切换后可能被普通窗口压下去，这里反复重新置顶
function keepPetOnTop() {
    if (!petWin || petWin.isDestroyed() || petHidden) return;
    // 待办/登录窗口打开时桌宠保持普通层级，不上浮抢占
    if (overlaySuspended) return;
    petWin.setAlwaysOnTop(true, "screen-saver");
}

// 页面按桌宠/气泡的实际可见矩形上报命中区域。
// 当前使用局部舞台窗口，命中由 petHoverGuard 按这些矩形切换鼠标穿透；
// 不调用 setShape，避免 Windows 给窗口区域额外绘制矩形阴影。
function applyPetShape(regions) {
    if (!petWin || petWin.isDestroyed() || !Array.isArray(regions)) return;
    const bounds = petWin.getBounds();
    const rects = [];
    const seen = new Set();
    for (const region of regions) {
        if (!region || typeof region !== "object") continue;
        const x = Math.floor(Number(region.x));
        const y = Math.floor(Number(region.y));
        const width = Math.ceil(Number(region.width));
        const height = Math.ceil(Number(region.height));
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(bounds.width, x + width);
        const bottom = Math.min(bounds.height, y + height);
        if (right <= left || bottom <= top) continue;
        const rect = { x: left, y: top, width: right - left, height: bottom - top };
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rects.push(rect);
    }
    petHitRegions = rects;
    const shapeKey = JSON.stringify(rects);
    if (shapeKey === lastPetShapeKey) return;
    lastPetShapeKey = shapeKey;
    if (!petShapeSupported) return;
    try {
        petWin.setShape(rects);
        petWin.setHasShadow(false);
        petWin.setBackgroundColor("#00000000");
        petShapeReady = rects.length > 0;
        petWin.setIgnoreMouseEvents(!petShapeReady, { forward: true });
        keepPetOnTop();
    } catch {
        petShapeSupported = false;
        petShapeReady = false;
        petWin.setIgnoreMouseEvents(true, { forward: true });
    }
}

// 待办/登录窗口打开期间把桌宠降为普通层级：
// 透明置顶窗（screen-saver 层级）会一直盖在待办窗口上，拖动待办窗口
// 经过桌宠 420×720 舞台（包括完全透明的空区）时，置顶层与下层窗口
// 会反复重新合成，表现为窗口尺寸/内容高频闪烁。
function suspendPetOverlay() {
    overlaySuspended = true;
    // 打开待办/登录窗口不代表拖动还在继续，清掉可能残留的拖动状态，
    // 否则 hover guard 会一直跳过，桌宠永远保持鼠标穿透。
    petDragActive = false;
    petDragOffset = null;
    petDragDisplay = null;
    petHoverInside = null;
    if (!petWin || petWin.isDestroyed()) return;
    petWin.setAlwaysOnTop(false);
    petWin.setIgnoreMouseEvents(true, { forward: false });
}

function restorePetOverlay() {
    overlaySuspended = false;
    if (!petWin || petWin.isDestroyed() || petHidden) return;
    petDragActive = false;
    petDragOffset = null;
    petDragDisplay = null;
    // 强制穿透后必须让 hover guard 重新判断一次；否则之前缓存的
    // petHoverInside=true 会让它提前 return，窗口关闭后桌宠点不动。
    petHoverInside = null;
    petWin.setAlwaysOnTop(true, "screen-saver");
    petWin.setIgnoreMouseEvents(!petShapeReady, { forward: true });
    keepPetOnTop();
    setTimeout(keepPetOnTop, 30);
}

function startPetHoverGuard() {
    if (petHoverTimer) return;
    petHoverTimer = setInterval(() => {
        if (!petWin || petWin.isDestroyed()) return;
        // 待办/登录窗口打开时不切换穿透，避免与下层窗口拖动互相触发
        if (petHidden || overlaySuspended) {
            petHoverInside = null;
            return;
        }
        if (petShapeSupported || petDragOffset || petDragActive) return;
        const bounds = petWin.getBounds();
        const point = screen.getCursorScreenPoint();
        const x = point.x - bounds.x;
        const y = point.y - bounds.y;
        const inside = petHitRegions.some(
            (rect) =>
                x >= rect.x &&
                x <= rect.x + rect.width &&
                y >= rect.y &&
                y <= rect.y + rect.height
        );
        if (inside === petHoverInside) return;
        petHoverInside = inside;
        petWin.setIgnoreMouseEvents(!inside, { forward: true });
    }, 25);
    petHoverTimer.unref?.();
}

function startPetTopGuard() {
    if (topGuardTimer) return;
    // 只补 always-on-top 标记，不再周期性 moveTop；后者会干扰浏览器标签拖拽。
    topGuardTimer = setInterval(() => {
        if (!petWin || petWin.isDestroyed() || petHidden) return;
        // 待办/登录窗口打开或拖动中不重设层级，避免叠加重合成
        if (overlaySuspended || petDragActive) return;
        petWin.setAlwaysOnTop(true, "screen-saver");
    }, 5000);
    topGuardTimer.unref?.();
}

function displayStateFile() {
    return path.join(app.getPath("userData"), "display-state.json");
}

// 读取上次保存的窗口位置。额外记录分辨率与缩放，用于判断旧坐标是否还能复用。
function readDisplayState() {
    try {
        const state = JSON.parse(fs.readFileSync(displayStateFile(), "utf8"));
        if (!state || typeof state !== "object") return null;
        return {
            displayId: Number.isFinite(state.displayId) ? Number(state.displayId) : null,
            x: Number.isFinite(state.x) ? Number(state.x) : null,
            y: Number.isFinite(state.y) ? Number(state.y) : null,
            scaleFactor: Number.isFinite(state.scaleFactor) ? Number(state.scaleFactor) : null,
            workArea:
                state.workArea &&
                Number.isFinite(state.workArea.width) &&
                Number.isFinite(state.workArea.height)
                    ? { width: Number(state.workArea.width), height: Number(state.workArea.height) }
                    : null
        };
    } catch {
        /* 首次启动或状态文件损坏 */
        return null;
    }
}

function saveDisplayState() {
    try {
        fs.mkdirSync(path.dirname(displayStateFile()), { recursive: true });
        const bounds = petWin && !petWin.isDestroyed() ? petWin.getBounds() : null;
        if (bounds) {
            petWindowX = bounds.x;
            petWindowY = bounds.y;
        }
        const display = getSelectedDisplay();
        fs.writeFileSync(
            displayStateFile(),
            JSON.stringify({
                displayId: petDisplayId,
                x: petWindowX,
                y: petWindowY,
                scaleFactor: display.scaleFactor,
                workArea: { width: display.workArea.width, height: display.workArea.height }
            }),
            "utf8"
        );
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

// 把 DIP 坐标对齐到物理像素网格：125% / 150% 缩放下整数 DIP 只对应
// 1.25 / 1.5 个物理像素，窗口落在半个像素上时 DWM 会重采样整窗位图，
// 拖动表现为边缘闪烁、内容发虚。
function alignDip(value, scaleFactor) {
    const scale = Number(scaleFactor) || 1;
    return Math.round(value * scale) / scale;
}

// 统一生成主屏 / 副屏名称，托盘菜单和设置面板共用
function describeDisplays() {
    const primaryId = screen.getPrimaryDisplay().id;
    let secondaryIndex = 0;
    return screen.getAllDisplays().map((display) => {
        const primary = display.id === primaryId;
        const name = primary ? "主显示器" : `副显示器 ${++secondaryIndex}`;
        // display.size / workArea 是 DIP（已经被系统缩放除过），直接展示会出现
        // 1707×960 这类逻辑分辨率，和系统设置里的物理分辨率对不上。
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

function movePetToDisplay(displayId) {
    const target = screen.getAllDisplays().find((display) => display.id === Number(displayId));
    if (!target) return;
    petDisplayId = target.id;
    petWindowX = null;
    petWindowY = null;
    petAnchorRight = true;
    petAnchorBottom = true;
    resizePetWindow();
    if (petWin && !petWin.isDestroyed()) {
        petWin.webContents.send("pet:anchor", { right: true, bottom: true });
    }
    saveDisplayState();
    updateTrayMenu();
}

function handleDisplaysChanged(changedMetrics) {
    if (!petWin || petWin.isDestroyed()) return;
    const current = screen.getAllDisplays().find((display) => display.id === petDisplayId);
    // display-metrics-changed 会带上变化项；分辨率 / 缩放 / 工作区变化后
    // 之前保存的坐标不再可靠，先回到目标显示器右下角再重新保存。
    const metrics = Array.isArray(changedMetrics) ? changedMetrics : null;
    const layoutChanged =
        !metrics || metrics.some((key) => key === "bounds" || key === "workArea" || key === "scaleFactor");
    if (!current) {
        // 当前显示器被拔掉时回到主屏
        petDisplayId = screen.getPrimaryDisplay().id;
        petWindowX = null;
        petWindowY = null;
        petAnchorRight = true;
        petAnchorBottom = true;
        if (petWin && !petWin.isDestroyed()) {
            petWin.webContents.send("pet:anchor", { right: true, bottom: true });
        }
    } else if (layoutChanged) {
        petWindowX = null;
        petWindowY = null;
        petAnchorRight = true;
        petAnchorBottom = true;
        if (petWin && !petWin.isDestroyed()) {
            petWin.webContents.send("pet:anchor", { right: true, bottom: true });
        }
    }
    resizePetWindow();
    saveDisplayState();
    updateTrayMenu();
}

function restartDesktop() {
    allowQuit = true;
    const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portableExecutable) app.relaunch({ execPath: portableExecutable });
    else app.relaunch();
    app.exit(0);
}

// 托盘“一键启动后台”：调用后端本机专用接口，按项目管理页保存的一键启动配置静默启动
async function quickStartProjects() {
    try {
        const response = await fetch(`${serverUrl}/gitstatus/api/projects/local/quickstart`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || data.res === false) {
            throw new Error((data && data.message) || `请求失败（HTTP ${response.status}）`);
        }
        const started = Array.isArray(data.started) ? data.started.length : 0;
        const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
        const failed = Array.isArray(data.failed) ? data.failed.length : 0;
        const body = `已启动 ${started} 个，跳过 ${skipped} 个，失败 ${failed} 个`;
        if (Notification.isSupported()) {
            new Notification({ title: "一键启动后台", body, silent: true }).show();
        } else {
            dialog.showMessageBox({ type: "info", title: "一键启动后台", message: body });
        }
    } catch (error) {
        dialog.showErrorBox("一键启动后台失败", error instanceof Error ? error.message : String(error));
    }
}

function updateTrayMenu() {
    if (!tray) return;
    const visible = Boolean(petWin && !petWin.isDestroyed() && !petHidden);
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
            {
                label: "一键启动后台",
                click: () => void quickStartProjects()
            },
            {
                label: "重启桌宠",
                click: restartDesktop
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
        if (petWin && !petWin.isDestroyed() && !petHidden) hidePet();
        else showPet();
    });
    updateTrayMenu();
}

// 关闭 = 先让页面播报再见小气泡，再把透明覆盖层藏到托盘
function hidePet() {
    if (!petWin || petWin.isDestroyed() || petHidden) return;
    if (hiding) {
        // 上一次隐藏流程如果卡住，超过兜底时间后直接收尾
        if (Date.now() - hideStartedAt > 2500) finishHide();
        return;
    }
    hiding = true;
    hideStartedAt = Date.now();
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
    hideStartedAt = 0;
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    petHidden = true;
    if (petWin && !petWin.isDestroyed()) {
        // close 方案：隐藏即销毁渲染进程，显示时重建，避免“再次显示停在最后一帧/点不动”
        petWin.webContents.send("pet:event", "hidden");
        try {
            petWin.destroy();
        } catch {
            /* 已销毁时忽略 */
        }
        petWin = null;
    }
    petHoverInside = null;
    updateTrayMenu();
}

function showPet() {
    // 隐藏时窗口已被销毁，这里重建；首次显示会经历一次页面加载
    if (!petWin || petWin.isDestroyed()) {
        petHidden = false;
        createPetWindow();
        updateTrayMenu();
        return;
    }
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    hiding = false;
    hideStartedAt = 0;
    petHidden = false;
    if (overlaySuspended && !todoWin && !loginWin) overlaySuspended = false;
    petDragActive = false;
    petDragOffset = null;
    petDragDisplay = null;
    petHoverInside = null;
    petWin.setOpacity(1);
    petWin.showInactive();
    if (petShapeSupported) {
        petWin.setIgnoreMouseEvents(!petShapeReady, { forward: true });
    } else if (overlaySuspended) {
        // 待办/登录窗口打开时保持完全不接收鼠标（不转发），避免拖动下层窗口时互相干扰
        petWin.setIgnoreMouseEvents(true, { forward: false });
        if (todoWin && !todoWin.isDestroyed()) {
            todoWin.show();
            todoWin.focus();
        } else if (loginWin && !loginWin.isDestroyed()) {
            loginWin.show();
            loginWin.focus();
        }
    } else {
        petWin.setIgnoreMouseEvents(true, { forward: true });
    }
    keepPetOnTop();
    setTimeout(keepPetOnTop, 30);
    petWin.webContents.send("pet:event", "after-show");
    // 隐藏后恢复时强制重绘，并补发事件与命中状态
    try {
        petWin.webContents.invalidate();
    } catch {
        /* 旧版本无此方法时忽略 */
    }
    setTimeout(() => {
        if (!petWin || petWin.isDestroyed() || petHidden) return;
        try {
            petWin.webContents.invalidate();
        } catch {
            /* ignore */
        }
        petHoverInside = null;
        keepPetOnTop();
    }, 80);
    setTimeout(() => {
        if (!petWin || petWin.isDestroyed() || petHidden) return;
        petWin.webContents.send("pet:event", "after-show");
        petHoverInside = null;
    }, 320);
    updateTrayMenu();
}

function createPetWindow() {
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    petHidden = false;
    hiding = false;
    hideStartedAt = 0;
    overlaySuspended = Boolean(
        (todoWin && !todoWin.isDestroyed()) || (loginWin && !loginWin.isDestroyed())
    );
    // 上次保存的位置只有在分辨率和缩放都没变时才复用，否则按新布局回到右下角
    const saved = readDisplayState();
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const display = displays.find((item) => item.id === saved?.displayId) || primary;
    petDisplayId = display.id;
    const scale = Number(display.scaleFactor) || 1;
    const layoutChanged =
        (saved?.scaleFactor != null && Math.abs(saved.scaleFactor - scale) > 0.001) ||
        (saved?.workArea != null &&
            (saved.workArea.width !== display.workArea.width ||
                saved.workArea.height !== display.workArea.height));
    petWindowX = layoutChanged ? null : (saved?.x ?? null);
    petWindowY = layoutChanged ? null : (saved?.y ?? null);
    const area = display.workArea;
    const defaultX = alignDip(area.x + area.width - PET_STAGE_WIDTH, scale);
    const defaultY = alignDip(area.y + area.height - PET_STAGE_HEIGHT, scale);
    const maxX = Math.max(area.x, alignDip(area.x + area.width - PET_STAGE_WIDTH, scale));
    const maxY = Math.max(area.y, alignDip(area.y + area.height - PET_STAGE_HEIGHT, scale));
    const x = alignDip(Math.max(area.x, Math.min(Number.isFinite(petWindowX) ? petWindowX : defaultX, maxX)), scale);
    const y = alignDip(Math.max(area.y, Math.min(Number.isFinite(petWindowY) ? petWindowY : defaultY, maxY)), scale);

    petWin = new BrowserWindow({
        x,
        y,
        width: PET_STAGE_WIDTH,
        height: PET_STAGE_HEIGHT,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        enableLargerThanScreen: false,
        // 允许系统原生拖动（后续可由页面 drag region 接管）
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
        x,
        y,
        width: PET_STAGE_WIDTH,
        height: PET_STAGE_HEIGHT
    });
    petWindowX = x;
    petWindowY = y;
    saveDisplayState();
    // 原生窗口区域会给小窗增加一圈矩形阴影，桌宠改用局部舞台＋鼠标穿透切换。
    petShapeSupported = false;
    petShapeReady = false;
    lastPetShapeKey = "";
    petHitRegions = [];
    petHoverInside = null;
    petWin.setBackgroundColor("#00000000");
    petWin.setHasShadow(false);
    petWin.setAlwaysOnTop(true, "screen-saver");
    petWin.setIgnoreMouseEvents(true, { forward: true });
    keepPetOnTop();
    startPetTopGuard();
    startPetHoverGuard();

    // 诊断开关：PET_DEBUG=1 时把窗口尺寸 / 位置变化打到终端，
    // 用来定位拖动时的高频 resize / 闪烁问题。
    if (process.env.PET_DEBUG === "1") {
        const logPetBounds = (tag) => {
            if (!petWin || petWin.isDestroyed()) return;
            const b = petWin.getBounds();
            debugLog("pet", `${tag} ${b.x},${b.y} ${b.width}x${b.height}`);
        };
        petWin.on("resize", () => logPetBounds("resize"));
        petWin.on("will-resize", () => logPetBounds("will-resize"));
        petWin.on("move", () => logPetBounds("move"));
        petWin.webContents.on("console-message", (_event, _level, message) => {
            debugLog("pet-renderer", message);
        });
    }

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
        // 首次命中区域上报前保持点击穿透，页面加载后会同步真实区域。
        petHoverInside = null;
        petWin.setIgnoreMouseEvents(!petShapeReady, { forward: true });
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
        petHitRegions = [];
        petHoverInside = null;
        petDragOffset = null;
        petDragActive = false;
        petShapeReady = false;
        lastPetShapeKey = "";
        updateTrayMenu();
    });

    // Alt+F4 / 系统关闭按钮都收进托盘，只有明确退出才真正结束进程
    petWin.on("close", (event) => {
        if (allowQuit) return;
        event.preventDefault();
        hidePet();
    });

    petWin.once("ready-to-show", () => {
        if (petHidden) return;
        petWin.showInactive();
        setTimeout(keepPetOnTop, 30);
    });

    // 页面加载失败时 ready-to-show 可能迟迟不触发，兜底显示离线页
    setTimeout(() => {
        if (petWin && !petWin.isDestroyed() && !petHidden && !petWin.isVisible()) {
            petWin.showInactive();
        }
    }, 2000);

    void petWin.loadURL(petUrl);
}

// 分辨率或显示器变化时，把局部舞台放回目标显示器右下角。
function resizePetWindow() {
    if (!petWin || petWin.isDestroyed()) return;
    const display = getSelectedDisplay();
    const area = display.workArea;
    const scale = Number(display.scaleFactor) || 1;
    const defaultX = alignDip(area.x + area.width - PET_STAGE_WIDTH, scale);
    const defaultY = alignDip(area.y + area.height - PET_STAGE_HEIGHT, scale);
    const maxX = Math.max(area.x, alignDip(area.x + area.width - PET_STAGE_WIDTH, scale));
    const maxY = Math.max(area.y, alignDip(area.y + area.height - PET_STAGE_HEIGHT, scale));
    const x = alignDip(Math.max(area.x, Math.min(Number.isFinite(petWindowX) ? petWindowX : defaultX, maxX)), scale);
    const y = alignDip(Math.max(area.y, Math.min(Number.isFinite(petWindowY) ? petWindowY : defaultY, maxY)), scale);
    petWindowX = x;
    petWindowY = y;
    petWin.setBounds({ x, y, width: PET_STAGE_WIDTH, height: PET_STAGE_HEIGHT });
    keepPetOnTop();
}

function movePetStage(x, y, petSize) {
    if (!petWin || petWin.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const size = Math.max(40, Math.min(180, Number(petSize) || 76));
    const area = display.workArea;
    const insetX = PET_STAGE_WIDTH - size - PET_STAGE_MARGIN;
    const insetY = PET_STAGE_HEIGHT - size - PET_STAGE_MARGIN;
    const minX = area.x - insetX;
    const maxX = area.x + area.width - PET_STAGE_WIDTH;
    const minY = area.y - insetY;
    const maxY = area.y + area.height - PET_STAGE_HEIGHT;
    const nextX = alignDip(Math.max(minX, Math.min(x, Math.max(minX, maxX))), display.scaleFactor);
    const nextY = alignDip(Math.max(minY, Math.min(y, Math.max(minY, maxY))), display.scaleFactor);
    petWindowX = nextX;
    petWindowY = nextY;
    petDisplayId = display.id;
    petWin.setPosition(nextX, nextY);
}

function clampToStage(value, origin, length, size) {
    const max = Math.max(origin, origin + length - size);
    return Math.round(Math.max(origin, Math.min(value, max)));
}

function sendPetAnchor(petSize) {
    if (!petWin || petWin.isDestroyed()) return;
    petWin.webContents.send("pet:anchor", {
        right: petAnchorRight,
        bottom: petAnchorBottom,
        petSize: Number(petSize) || 76
    });
}

function setPetStageAnchor(right, bottom, petSize) {
    if (right === petAnchorRight && bottom === petAnchorBottom) return;
    petAnchorRight = Boolean(right);
    petAnchorBottom = Boolean(bottom);
    sendPetAnchor(petSize);
}

// 由页面 rAF 触发：主进程的 16ms 定时器在 Windows 上实测只有约 35Hz，
// 直接用它会拖慢窗口移动；rAF 与显示器刷新同步，才能稳定到 60Hz。
function movePetWindowDragFrame() {
    if (!petWin || petWin.isDestroyed() || !petDragOffset) return;
    const point = screen.getCursorScreenPoint();
    let current = petDragDisplay;
    if (!current) current = screen.getDisplayNearestPoint(point);
    const currentArea = current.workArea;
    if (
        point.x < currentArea.x ||
        point.x > currentArea.x + currentArea.width ||
        point.y < currentArea.y ||
        point.y > currentArea.y + currentArea.height
    ) {
        current = screen.getDisplayNearestPoint(point);
        petDragDisplay = current;
        petDisplayId = current.id;
    }
    const displayArea = current.workArea;
    // 窗口尺寸在拖动全程保持不变（透明窗每次 resize 都要重新合成，高 DPI 下会闪一下），
    // 只按当前锚点把窗口里用不到的部分“藏”到光标外侧。
    const size = petDragOffset.size;
    const insetX = petAnchorRight ? PET_STAGE_WIDTH - size - PET_STAGE_MARGIN : PET_STAGE_MARGIN;
    const insetY = petAnchorBottom ? PET_STAGE_HEIGHT - size - PET_STAGE_MARGIN : PET_STAGE_MARGIN;
    const x = clampToStage(
        point.x - petDragOffset.x - insetX,
        displayArea.x,
        displayArea.width,
        PET_STAGE_WIDTH
    );
    const y = clampToStage(
        point.y - petDragOffset.y - insetY,
        displayArea.y,
        displayArea.height,
        PET_STAGE_HEIGHT
    );
    // 用缓存坐标去重，避免每帧同步 getBounds 增加主进程开销。
    // 高缩放下再把坐标对齐到物理像素，否则每帧落在半像素上会被 DWM 重采样。
    const scale = Number(current.scaleFactor) || 1;
    const nextX = alignDip(x, scale);
    const nextY = alignDip(y, scale);
    if (petWindowX !== nextX || petWindowY !== nextY) {
        petWindowX = nextX;
        petWindowY = nextY;
        petWin.setPosition(nextX, nextY);
    }
}

// 拖动开始：不再收缩窗口，只把舞台移到光标下方。透明窗口 resize 会重新
// 合成整个位图，高 DPI 下表现为拖动开始/结束闪一下，所以全程保持原尺寸。
function startPetWindowDrag(payload) {
    if (!petWin || petWin.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const size = Math.max(40, Math.min(180, Number(payload?.petSize) || 76));
    const offsetX = Number(payload?.offsetX);
    const offsetY = Number(payload?.offsetY);
    petDragOffset = {
        x: Number.isFinite(offsetX) ? Math.max(0, Math.min(size - 1, offsetX)) : size / 2,
        y: Number.isFinite(offsetY) ? Math.max(0, Math.min(size - 1, offsetY)) : size / 2,
        size
    };
    const display = screen.getDisplayNearestPoint(cursor);
    petDragDisplay = display;
    petDisplayId = display.id;
    const area = display.workArea;
    const insetX = petAnchorRight ? PET_STAGE_WIDTH - size - PET_STAGE_MARGIN : PET_STAGE_MARGIN;
    const insetY = petAnchorBottom ? PET_STAGE_HEIGHT - size - PET_STAGE_MARGIN : PET_STAGE_MARGIN;
    const startX = alignDip(
        clampToStage(cursor.x - petDragOffset.x - insetX, area.x, area.width, PET_STAGE_WIDTH),
        display.scaleFactor
    );
    const startY = alignDip(
        clampToStage(cursor.y - petDragOffset.y - insetY, area.y, area.height, PET_STAGE_HEIGHT),
        display.scaleFactor
    );
    petWindowX = startX;
    petWindowY = startY;
    petWin.setPosition(startX, startY);
}

function getPetWindowDragFinishLayout() {
    if (!petWin || petWin.isDestroyed() || !petDragOffset) return null;
    const size = petDragOffset.size;
    const bounds = petWin.getBounds();
    // 拖动期间窗口尺寸未变，桌宠固定在当前锚点角落
    const insetX = petAnchorRight ? PET_STAGE_WIDTH - size - PET_STAGE_MARGIN : PET_STAGE_MARGIN;
    const insetY = petAnchorBottom ? PET_STAGE_HEIGHT - size - PET_STAGE_MARGIN : PET_STAGE_MARGIN;
    const petLeft = bounds.x + insetX;
    const petTop = bounds.y + insetY;
    const display = screen.getDisplayNearestPoint({
        x: petLeft + size / 2,
        y: petTop + size / 2
    });
    const area = display.workArea;
    const right = petLeft + size / 2 > area.x + area.width / 2;
    const bottom = petTop + size / 2 > area.y + area.height / 2;
    const localX = right ? PET_STAGE_WIDTH - size - PET_STAGE_MARGIN : PET_STAGE_MARGIN;
    const localY = bottom ? PET_STAGE_HEIGHT - size - PET_STAGE_MARGIN : PET_STAGE_MARGIN;
    const x = alignDip(clampToStage(petLeft - localX, area.x, area.width, PET_STAGE_WIDTH), display.scaleFactor);
    const y = alignDip(clampToStage(petTop - localY, area.y, area.height, PET_STAGE_HEIGHT), display.scaleFactor);
    petAnchorRight = right;
    petAnchorBottom = bottom;
    petDisplayId = display.id;
    petWindowX = x;
    petWindowY = y;
    return {
        x,
        y,
        width: PET_STAGE_WIDTH,
        height: PET_STAGE_HEIGHT,
        localX,
        localY,
        right,
        bottom,
        petSize: size
    };
}

// 兜底路径：由主进程直接展开舞台；页面优先使用 finish-layout + moveTo/resizeTo
// 在同一帧完成“窗口展开 + 桌宠重新定位”，避免松开鼠标时闪烁。
function finishPetWindowDrag() {
    const layout = getPetWindowDragFinishLayout();
    if (!layout) {
        stopPetWindowDrag();
        return;
    }
    petWin.setBounds({ x: layout.x, y: layout.y, width: layout.width, height: layout.height });
    sendPetAnchor(layout.petSize);
    stopPetWindowDrag();
}

function stopPetWindowDrag() {
    petDragOffset = null;
    petDragDisplay = null;
    // 拖动结束由 finishPetWindowDrag 收口时，页面不会再单独发 desktop-drag-active(false)
    petDragActive = false;
    saveDisplayState();
    updateTrayMenu();
}

function openLoginWindow() {
    suspendPetOverlay();
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
    // 登录窗口失焦后同样恢复桌宠，理由同待办窗口
    loginWin.on("blur", () => {
        setTimeout(() => {
            if (!loginWin || loginWin.isDestroyed() || loginWin.isFocused()) return;
            if (overlaySuspended) restorePetOverlay();
        }, 80);
    });
    loginWin.on("closed", () => {
        loginWin = null;
        restorePetOverlay();
    });
}

// 桌面版打开待办页：默认在应用内窗口打开，可选直达新建待办弹窗
function openTodoWindow(add = false) {
    suspendPetOverlay();
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
    // 诊断开关：记录待办窗口的尺寸/位置变化，用来定位拖动时尺寸来回跳的问题
    if (process.env.PET_DEBUG === "1") {
        const logTodoBounds = (tag) => {
            if (!todoWin || todoWin.isDestroyed()) return;
            const b = todoWin.getBounds();
            const max = todoWin.isMaximized() ? " maximized" : "";
            debugLog("todo", `${tag} ${b.x},${b.y} ${b.width}x${b.height}${max}`);
        };
        todoWin.on("resize", () => logTodoBounds("resize"));
        todoWin.on("will-resize", () => logTodoBounds("will-resize"));
        todoWin.on("move", () => logTodoBounds("move"));
        todoWin.on("will-move", () => logTodoBounds("will-move"));
        todoWin.on("maximize", () => logTodoBounds("maximize"));
        todoWin.on("unmaximize", () => logTodoBounds("unmaximize"));
        todoWin.on("enter-full-screen", () => logTodoBounds("enter-full-screen"));
        todoWin.on("leave-full-screen", () => logTodoBounds("leave-full-screen"));
    }
    todoWin.once("ready-to-show", () => {
        if (!todoWin || todoWin.isDestroyed()) return;
        todoWin.show();
        todoWin.focus();
    });
    void todoWin.loadURL(addUrl);
    // 待办窗口失焦（用户切到浏览器/桌面等外部应用）时恢复桌宠，
    // 否则桌宠会一直沉在待办窗口下面且不接收鼠标，点了也没反应。
    // 窗口重新获得焦点时 browser-window-focus 会再次暂停。
    todoWin.on("blur", () => {
        setTimeout(() => {
            if (!todoWin || todoWin.isDestroyed() || todoWin.isFocused()) return;
            if (overlaySuspended) restorePetOverlay();
        }, 80);
    });
    todoWin.on("closed", () => {
        todoWin = null;
        restorePetOverlay();
    });
}

function openTodoAddWindow() {
    openTodoWindow(true);
}

function registerIpc() {
    ipcMain.on("pet:interactive", (event, value) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        // 待办/登录窗口打开时桌宠已降层，不再切换鼠标状态
        if (overlaySuspended) return;
        // 命中切换由主进程的 petHoverGuard 负责，避免页面 mousemove 与
        // 窗口移动互相触发造成指针闪烁或意外拖动。
        if (!petShapeSupported) return;
        if (value) petWin.setIgnoreMouseEvents(false);
        else petWin.setIgnoreMouseEvents(true, { forward: true });
        setTimeout(keepPetOnTop, 30);
    });

    ipcMain.on("pet:hit-regions", (event, regions) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        applyPetShape(regions);
    });

    ipcMain.handle("pet:get-displays", () => {
        const items = describeDisplays();
        return {
            currentId: petDisplayId,
            displays: items.map(({ id, label, primary, display, scaleFactor }) => ({
                id,
                label,
                primary,
                scaleFactor,
                size: display.size,
                workArea: display.workArea
            }))
        };
    });

    ipcMain.on("pet:cursor", (event) => {
        if (petWin && event.sender !== petWin.webContents) return;
        event.returnValue = screen.getCursorScreenPoint();
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

    ipcMain.on("pet:move-window", (event, point) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        const x = Number(point?.x);
        const y = Number(point?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        movePetStage(x, y, point?.petSize);
    });

    ipcMain.on("pet:desktop-drag-active", (event, active) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        petDragActive = Boolean(active);
        if (petDragActive) {
            petHoverInside = null;
            const cursor = screen.getCursorScreenPoint();
            const display = screen.getDisplayNearestPoint(cursor);
            petDragDisplay = display;
            petDisplayId = display.id;
            return;
        }
        petDragDisplay = null;
        petHoverInside = null;
        saveDisplayState();
        updateTrayMenu();
        keepPetOnTop();
    });

    ipcMain.on("pet:window-drag-start", (event, payload) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        startPetWindowDrag(payload);
    });

    ipcMain.on("pet:window-drag-tick", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        movePetWindowDragFrame();
    });

    ipcMain.handle("pet:window-drag-finish-layout", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return null;
        return getPetWindowDragFinishLayout();
    });

    ipcMain.on("pet:window-drag-complete", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        stopPetWindowDrag();
        keepPetOnTop();
    });

    // 兼容旧页面：直接结束并展开舞台。
    ipcMain.on("pet:window-drag-end", (event) => {
        if (!petWin || event.sender !== petWin.webContents) return;
        finishPetWindowDrag();
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
            petHoverInside = null;
            petDragActive = false;
            petDragOffset = null;
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

    // 其他窗口获得焦点时也把桌宠重新提到最上层，但不抢焦点。
    // 焦点在桌面版自己的待办/登录窗口时桌宠避让（不置顶、不接收鼠标），
    // 避开拖动窗口时透明置顶层的反复合成；焦点回到其他窗口后恢复。
    app.on("browser-window-focus", (_event, win) => {
        if (win === todoWin || win === loginWin) {
            if (!overlaySuspended) suspendPetOverlay();
            return;
        }
        if (overlaySuspended) restorePetOverlay();
        if (petWin && !petWin.isDestroyed() && !petHidden) {
            setTimeout(keepPetOnTop, 50);
        }
    });

    app.whenReady().then(() => {
        const primary = screen.getPrimaryDisplay();
        debugLog(
            "app",
            `ready size=${primary.size.width}x${primary.size.height} scale=${primary.scaleFactor} workArea=${primary.workArea.width}x${primary.workArea.height}`
        );
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
        // 托盘常驻应用：隐藏会销毁桌宠窗口，此时不能退出进程
    });

    app.on("activate", () => {
        if (!petWin) createPetWindow();
    });
}
