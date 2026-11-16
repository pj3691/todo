/* ============================================================
   GitStatus 桌宠桌面版 preload
   同一份 preload 供桌宠窗 / 气泡窗 / 设置窗 / 登录窗 / 离线页使用，
   渲染进程只拿到白名单方法，不接触 Node。
   ============================================================ */
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
        try {
            ipcRenderer.removeListener(channel, listener);
        } catch {
            /* 窗口销毁时忽略 */
        }
    };
}

contextBridge.exposeInMainWorld("desktopApi", {
    // 状态
    getState: () => ipcRenderer.invoke("app:get-state"),
    getPetImage: () => ipcRenderer.invoke("app:get-pet-image"),
    onState: (callback) => subscribe("app:state", callback),
    onPetImage: (callback) => subscribe("app:pet-image", callback),
    onFlip: (callback) => subscribe("pet:flip", callback),
    onAlert: (callback) => subscribe("pet:alert", callback),
    onBubbleRender: (callback) => subscribe("bubble:render", callback),
    onBubblePlacement: (callback) => subscribe("bubble:placement", callback),
    onBubbleShown: (callback) => subscribe("bubble:shown", callback),
    onBubbleHidden: (callback) => subscribe("bubble:hidden", callback),
    onSettingsShown: (callback) => subscribe("settings:shown", callback),

    // 桌宠窗口
    startDrag: (x, y) => ipcRenderer.send("pet:drag-start", { x: Number(x), y: Number(y) }),
    dragTick: () => ipcRenderer.send("pet:drag-tick"),
    endDrag: () => ipcRenderer.send("pet:drag-end"),
    toggleMini: () => ipcRenderer.send("pet:toggle-mini"),
    togglePanel: () => ipcRenderer.send("pet:toggle-panel"),
    showContextMenu: () => ipcRenderer.send("pet:context-menu"),

    // 气泡窗口
    resizeBubble: (width, height) =>
        ipcRenderer.send("bubble:resize", { width: Number(width), height: Number(height) }),
    setBubbleHover: (value) => ipcRenderer.send("bubble:hover", Boolean(value)),
    closeBubble: () => ipcRenderer.send("bubble:close"),
    bubbleAction: (action, payload) => ipcRenderer.send("bubble:action", String(action || ""), payload || {}),

    // 通用动作
    openTodo: (add) => ipcRenderer.send("app:open-todo", Boolean(add)),
    openTodoAdd: () => ipcRenderer.send("app:open-todo-add"),
    openSettings: () => ipcRenderer.send("app:open-settings"),
    openLogin: () => ipcRenderer.send("app:open-login"),
    hidePet: () => ipcRenderer.send("app:hide-pet"),
    quitApp: () => ipcRenderer.send("app:quit"),
    openExternal: (url) => ipcRenderer.send("app:open-external", String(url || "")),
    retry: () => ipcRenderer.send("app:retry"),
    loginDone: (token) => ipcRenderer.send("app:login-done", token === undefined ? "" : String(token || "")),

    // 设置窗口
    getSettingsState: () => ipcRenderer.invoke("settings:get-state"),
    saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
    uploadPet: (bytes, mime, name) => ipcRenderer.invoke("settings:upload-pet", { bytes, mime, name }),
    deletePet: () => ipcRenderer.invoke("settings:delete-pet"),
    setPreference: (key, value) => ipcRenderer.invoke("settings:set-pref", String(key), value),
    moveToDisplay: (displayId) => ipcRenderer.send("settings:move-display", Number(displayId)),
    closeSettings: () => ipcRenderer.send("settings:close"),
    resizeSettings: (width, height) =>
        ipcRenderer.send("settings:resize", { width: Number(width), height: Number(height) })
});
