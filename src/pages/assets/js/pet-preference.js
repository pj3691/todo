/* ============================================================
   页面桌宠显示偏好
   - 所有网页页面共用一个开关，默认不显示桌宠
   - 在账号信息卡片里通过 data-todo-pet-toggle 开关控制，各页面的开关与桌宠同步生效
   - 桌面版待办窗口使用 noPet=1，开关会隐藏，桌宠由桌面覆盖层负责
   ============================================================ */
(function (global) {
    "use strict";

    const KEY = "gitstatus_pet_todo_visible_v1";
    const TOGGLE_SELECTOR = "[data-todo-pet-toggle]";

    function readVisible() {
        try {
            return global.localStorage.getItem(KEY) === "1";
        } catch {
            return false;
        }
    }

    function writeVisible(value) {
        try {
            global.localStorage.setItem(KEY, value ? "1" : "0");
        } catch {
            /* 隐私模式下 localStorage 可能不可用 */
        }
    }

    function getToggles() {
        return Array.from(document.querySelectorAll(TOGGLE_SELECTOR));
    }

    function isNoPetPage() {
        try {
            return new URLSearchParams(global.location.search).get("noPet") === "1";
        } catch {
            return false;
        }
    }

    function syncToggles() {
        const visible = readVisible();
        for (const toggle of getToggles()) {
            toggle.checked = visible;
        }
    }

    function applyPetVisibility(visible) {
        if (visible) global.GitStatusPet?.init();
        else global.GitStatusPet?.destroy();
    }

    function bind() {
        const noPet = isNoPetPage();
        for (const toggle of getToggles()) {
            const row = toggle.closest(".user-popover-meta-row");
            if (noPet) {
                // 桌面版待办窗口里的桌宠由托盘/覆盖层控制，不再显示第二个桌宠
                row?.classList.add("hidden");
                continue;
            }
            toggle.checked = readVisible();
            toggle.addEventListener("change", () => {
                const visible = toggle.checked;
                writeVisible(visible);
                applyPetVisibility(visible);
            });
        }
        if (noPet) return;
        global.addEventListener("storage", (event) => {
            if (event.key !== KEY) return;
            const visible = readVisible();
            syncToggles();
            applyPetVisibility(visible);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bind, { once: true });
    } else {
        bind();
    }
})(window);
