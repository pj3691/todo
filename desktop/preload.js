/* ============================================================
   GitStatus 桌宠桌面版 preload
   只暴露桌宠需要的窗口控制能力，渲染进程不接触 Node
   ============================================================ */
const { contextBridge, ipcRenderer } = require("electron");

// 同步拿一次虚拟桌面和当前显示器，页面首帧就能把桌宠放到正确位置
let initialDisplay = null;
try {
    initialDisplay = ipcRenderer.sendSync("pet:initial-display");
} catch {
    /* 主进程还没准备好时忽略，页面会回退到默认位置 */
}
if (initialDisplay) {
    contextBridge.exposeInMainWorld("desktopInitialDisplay", initialDisplay);
}

contextBridge.exposeInMainWorld("desktopApi", {
    setInteractive(value) {
        ipcRenderer.send("pet:interactive", Boolean(value));
    },
    getDisplays() {
        return ipcRenderer.invoke("pet:get-displays");
    },
    moveToDisplay(displayId) {
        ipcRenderer.send("pet:move-display", Number(displayId));
    },
    reportPetPosition(x, y) {
        ipcRenderer.send("pet:position", { x: Number(x), y: Number(y) });
    },
    openLogin() {
        ipcRenderer.send("pet:open-login");
    },
    openTodoAdd() {
        ipcRenderer.send("pet:open-todo-add");
    },
    openTodo() {
        ipcRenderer.send("pet:open-todo");
    },
    hidePet() {
        ipcRenderer.send("pet:hide");
    },
    hideNow() {
        ipcRenderer.send("pet:hide-now");
    },
    onPetEvent(callback) {
        if (typeof callback !== "function") return;
        ipcRenderer.on("pet:event", (_event, type) => callback(String(type || "")));
    },
    openExternal(url) {
        ipcRenderer.send("pet:open-external", String(url || ""));
    },
    loginDone() {
        ipcRenderer.send("pet:login-done");
    },
    retry() {
        ipcRenderer.send("pet:retry");
    },
    quit() {
        ipcRenderer.send("pet:quit");
    }
});
