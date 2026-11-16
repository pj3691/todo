/* ============================================================
   桌宠窗口渲染逻辑
   - 只负责造型、徽标、点击/拖动；数据与提醒全部来自主进程
   - 拖动由页面 rAF 驱动主进程逐帧移动窗口，避免主进程定时器抖动
   ============================================================ */
(function (global) {
    "use strict";

    const api = global.desktopApi;
    if (!api) return;

    const root = document.getElementById("pet");
    const squish = root.querySelector(".pet-squish");
    const badge = root.querySelector(".pet-badge");
    const debugLabel = root.querySelector(".pet-debug-label");
    const menuBtn = root.querySelector(".pet-menu-btn");
    const addBtn = root.querySelector(".pet-add-btn");
    const todoBtn = root.querySelector(".pet-todo-btn");

    const IDLE_AFTER_MS = 60000;
    const PENDING_CLICK_MS = 220;
    const DOUBLE_CLICK_MS = 280;
    const DRAG_THRESHOLD = 4;

    let idleTimer = 0;
    let alertTimer = 0;
    let clickTimer = 0;
    let lastClickAt = 0;
    let drag = null;

    function setBadge(stats) {
        const pending = Math.max(0, Number(stats && stats.pending) || 0);
        const overdue = Math.max(0, Number(stats && stats.overdue) || 0);
        if (pending <= 0) {
            badge.textContent = "";
            badge.classList.remove("is-visible", "is-danger");
            root.setAttribute("aria-label", "桌宠喵：今天的待办都完成啦");
            return;
        }
        badge.textContent = pending > 99 ? "99+" : String(pending);
        badge.classList.add("is-visible");
        badge.classList.toggle("is-danger", overdue > 0);
        root.setAttribute(
            "aria-label",
            `桌宠喵：今天还有 ${pending} 件事没做完${overdue > 0 ? `，${overdue} 件逾期了` : ""}`
        );
    }

    function updateDebugLabel() {
        debugLabel.textContent = `窗口 ${global.innerWidth}×${global.innerHeight}`;
    }

    function wake() {
        root.classList.remove("is-idle");
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = global.setTimeout(() => {
            idleTimer = 0;
            root.classList.add("is-idle");
        }, IDLE_AFTER_MS);
    }

    function pulseAlert() {
        root.classList.add("is-alert");
        if (alertTimer) clearTimeout(alertTimer);
        alertTimer = global.setTimeout(() => {
            alertTimer = 0;
            root.classList.remove("is-alert");
        }, 2600);
        wake();
    }

    function applyState(state) {
        if (!state) return;
        // 桌宠造型尺寸由设置决定；窗口高度可能为右侧按钮留了额外空间
        root.style.setProperty("--pet-size", `${Math.max(40, Number(state.size) || 76)}px`);
        setBadge(state.summary && state.summary.stats);
        root.classList.toggle("is-flipped", Boolean(state.flip));
        root.classList.toggle("is-debug", Boolean(state.debug));
        updateDebugLabel();
        wake();
    }

    function setVisual(imageUrl) {
        squish.replaceChildren(global.PetVisual.createVisual(imageUrl, "桌宠"));
    }

    function stopFrame() {
        if (drag && drag.frame) {
            global.cancelAnimationFrame(drag.frame);
            drag.frame = 0;
        }
    }

    function triggerClick() {
        const now = Date.now();
        if (now - lastClickAt < DOUBLE_CLICK_MS) {
            lastClickAt = 0;
            if (clickTimer) {
                global.clearTimeout(clickTimer);
                clickTimer = 0;
            }
            api.togglePanel();
            return;
        }
        lastClickAt = now;
        if (clickTimer) global.clearTimeout(clickTimer);
        clickTimer = global.setTimeout(() => {
            clickTimer = 0;
            api.toggleMini();
        }, PENDING_CLICK_MS);
        wake();
    }

    function onPointerMove(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
        if (event.cancelable) event.preventDefault();
        if (drag.moved) return;
        drag.moved = true;
        root.classList.remove("is-pressed");
        root.classList.add("is-dragging");
        api.startDrag(drag.offsetX, drag.offsetY);
        const step = () => {
            if (!drag) return;
            api.dragTick();
            drag.frame = global.requestAnimationFrame(step);
        };
        drag.frame = global.requestAnimationFrame(step);
    }

    function finishPointer(allowClick) {
        if (!drag) return;
        const wasDrag = drag.moved;
        stopFrame();
        drag = null;
        root.classList.remove("is-pressed", "is-dragging");
        global.removeEventListener("pointermove", onPointerMove);
        global.removeEventListener("pointerup", onPointerUp);
        global.removeEventListener("pointercancel", onPointerCancel);
        if (wasDrag) {
            api.endDrag();
            return;
        }
        if (allowClick) triggerClick();
    }

    function onPointerUp(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        finishPointer(true);
    }

    function onPointerCancel(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        finishPointer(false);
    }

    function onPointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        if (drag) return;
        event.preventDefault();
        try {
            root.focus({ preventScroll: true });
        } catch {
            /* 不支持 focus options 时忽略 */
        }
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            // 窗口坐标原点是桌宠窗口左上角，直接作为主进程的抓取偏移
            offsetX: event.clientX,
            offsetY: event.clientY,
            moved: false,
            frame: 0
        };
        root.classList.add("is-pressed");
        try {
            root.setPointerCapture(event.pointerId);
        } catch {
            /* 指针捕获不可用时依赖 window 级事件 */
        }
        global.addEventListener("pointermove", onPointerMove, { passive: false });
        global.addEventListener("pointerup", onPointerUp);
        global.addEventListener("pointercancel", onPointerCancel);
        wake();
    }

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            api.toggleMini();
        }
    });
    root.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        api.showContextMenu();
    });

    // 右侧三连按钮：与旧版一致，菜单开面板、+ 新建待办、待办列表打开待办页
    function bindSideButton(node, handler) {
        if (!node) return;
        node.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
        });
        node.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            handler();
        });
    }
    bindSideButton(menuBtn, () => api.togglePanel());
    bindSideButton(addBtn, () => api.openTodoAdd());
    bindSideButton(todoBtn, () => api.openTodo(false));

    global.addEventListener("resize", updateDebugLabel);

    api.onState(applyState);
    api.onPetImage(setVisual);
    api.onFlip((value) => root.classList.toggle("is-flipped", Boolean(value)));
    api.onAlert((value) => {
        if (value) pulseAlert();
    });

    void (async () => {
        try {
            applyState(await api.getState());
            setVisual(await api.getPetImage());
        } catch {
            /* 主进程未就绪时保持内置造型 */
        }
    })();
})(window);
