/* ============================================================
   GitStatus 桌宠 Tauri 桥接
   把 window.__TAURI__ 适配成与 Electron preload 完全相同的
   window.desktopApi 协议，页面（desktop-pet.html / pet-widget.js /
   desktop-login.html / offline.html）不需要区分运行时。
   仅在 Tauri 环境生效；普通浏览器里不会定义 desktopApi。
   ============================================================ */
(function (global) {
    "use strict";

    if (global.desktopApi) return;

    const tauri = global.__TAURI__;
    const invoke = tauri && tauri.core && tauri.core.invoke;
    if (typeof invoke !== "function") return;

    const listen = tauri.event && tauri.event.listen;
    // 与 Electron 版对齐：给页面一个“桌面端”标记，登录页等样式会用到
    try {
        document.documentElement.classList.add("desktop-app");
    } catch {
        /* 忽略 */
    }
    // 页面只用 getCursorPoint 做拖拽按下时的兜底坐标；真实光标由 Rust 侧读取，
    // 这里返回 null 时页面会退回 pointer 事件的 screenX/screenY。
    let cursorCache = null;

    function safeInvoke(command, args) {
        try {
            const result = invoke(command, args);
            if (result && typeof result.catch === "function") result.catch(function () {});
            return result;
        } catch {
            return Promise.resolve(null);
        }
    }

    function subscribe(eventName, callback) {
        if (typeof listen !== "function" || typeof callback !== "function") return;
        listen(eventName, function (event) {
            callback(event && event.payload);
        }).catch(function () {});
    }

    global.desktopApi = {
        setInteractive: function (value) {
            return safeInvoke("pet_set_interactive", { value: Boolean(value) });
        },
        setHitRegions: function (regions) {
            return safeInvoke("pet_set_hit_regions", { regions: Array.isArray(regions) ? regions : [] });
        },
        getDisplays: function () {
            return safeInvoke("pet_get_displays");
        },
        getCursorPoint: function () {
            return cursorCache;
        },
        moveToDisplay: function (displayId) {
            return safeInvoke("pet_move_to_display", { displayId: Number(displayId) });
        },
        reportPetPosition: function (x, y) {
            return safeInvoke("pet_report_position", { x: Number(x), y: Number(y) });
        },
        moveWindow: function (x, y, petSize) {
            return safeInvoke("pet_move_window", {
                x: Number(x),
                y: Number(y),
                petSize: Number(petSize)
            });
        },
        setDesktopDragging: function (active) {
            return safeInvoke("pet_set_desktop_dragging", { active: Boolean(active) });
        },
        startWindowDrag: function (petSize, offsetX, offsetY) {
            return safeInvoke("pet_start_drag", {
                petSize: Number(petSize),
                offsetX: Number(offsetX),
                offsetY: Number(offsetY)
            });
        },
        windowDragTick: function () {
            return safeInvoke("pet_drag_tick");
        },
        finishWindowDragLayout: function () {
            return safeInvoke("pet_finish_drag_layout");
        },
        completeWindowDrag: function () {
            return safeInvoke("pet_end_drag");
        },
        endWindowDrag: function () {
            return safeInvoke("pet_end_drag");
        },
        openLogin: function () {
            return safeInvoke("pet_open_login");
        },
        openTodoAdd: function () {
            return safeInvoke("pet_open_todo_add");
        },
        openTodo: function () {
            return safeInvoke("pet_open_todo");
        },
        hidePet: function () {
            return safeInvoke("pet_hide");
        },
        hideNow: function () {
            return safeInvoke("pet_hide_now");
        },
        onPetEvent: function (callback) {
            subscribe("pet-event", callback);
        },
        onStageAnchor: function (callback) {
            subscribe("pet-anchor", callback);
        },
        openExternal: function (url) {
            return safeInvoke("pet_open_external", { url: String(url || "") });
        },
        loginDone: function () {
            return safeInvoke("pet_login_done");
        },
        retry: function () {
            return safeInvoke("pet_retry");
        },
        quit: function () {
            return safeInvoke("pet_quit");
        }
    };

    // 告诉 Rust 侧页面已真正执行：窗口要等这个信号才显示，
    // 3 秒内没收到信号会被判定为 WebView2 首帧白屏并自动重载一次。
    safeInvoke("pet_page_ready");
})(window);
