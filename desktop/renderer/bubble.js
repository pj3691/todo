/* ============================================================
   气泡窗口渲染逻辑
   - 同一个小窗承载：左键小气泡、完整面板、提醒气泡、隐藏/回来播报
   - 内容高度变化后回报主进程调整窗口，主进程负责贴着桌宠摆放
   ============================================================ */
(function (global) {
    "use strict";

    const api = global.desktopApi;
    if (!api) return;

    const bubble = document.getElementById("bubble");
    const card = bubble.querySelector(".bubble-card");
    const content = document.getElementById("content");

    const TYPE_CLASSES = ["is-mini", "is-panel", "is-reminder", "is-notice"];
    const PADDING = 16;

    let maxHeight = 600;
    let placement = { above: true, alignRight: true };
    let lastSize = { width: 0, height: 0 };
    let sizeFrame = 0;
    let sizeForce = false;
    let audioCtx = null;
    let currentType = "";
    let shown = false;
    let revealPending = false;
    let revealToken = 0;
    let revealFallback = 0;

    // ---------- 基础工具 ----------
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function formatTrigger(triggerAt, today) {
        const text = String(triggerAt || "");
        if (!text) return "";
        const dateKey = text.slice(0, 10);
        const time = text.slice(11, 16);
        if (today && dateKey === today) return `今天 ${time}`;
        return `${dateKey.slice(5)} ${time}`;
    }

    function actionButton(label, className, action, options) {
        const node = el("button", className, label);
        node.type = "button";
        node.dataset.action = action;
        const opts = options || {};
        if (opts.minutes !== undefined) node.dataset.minutes = String(opts.minutes);
        if (opts.title) node.title = opts.title;
        if (opts.ariaLabel) node.setAttribute("aria-label", opts.ariaLabel);
        return node;
    }

    function settingsButton() {
        return actionButton("设置", "link-btn", "open-settings", { title: "调整桌宠提醒设置" });
    }

    function closeToTrayButton() {
        return actionButton("\u00d7", "close-btn", "hide-pet", {
            title: "收进 Windows 托盘",
            ariaLabel: "关闭桌宠到托盘"
        });
    }

    function closeBubbleButton() {
        return actionButton("\u00d7", "close-btn", "close", {
            title: "关闭面板",
            ariaLabel: "关闭面板"
        });
    }

    function head(kicker, title, actions) {
        const wrap = el("div", "bubble-head");
        const copy = el("div");
        copy.append(el("span", "bubble-kicker", kicker), el("div", "bubble-title", title));
        wrap.append(copy);
        if (Array.isArray(actions) && actions.length > 0) {
            const box = el("div", "head-actions");
            box.append(...actions);
            wrap.append(box);
        }
        return wrap;
    }

    function actionsRow(buttons) {
        const row = el("div", "actions");
        row.append(...buttons);
        return row;
    }

    // ---------- 各类型内容 ----------
    function renderOffline(data) {
        const fragment = document.createDocumentFragment();
        fragment.append(head("GITSTATUS 桌宠", "后台还没有启动喵", [closeBubbleButton()]));
        fragment.append(el("p", "hint", "请先在项目根目录启动后端，再点下面的按钮重新连接。"));
        fragment.append(el("code", "offline-code", String(data.serverUrl || "")));
        fragment.append(actionsRow([actionButton("重新连接", "btn btn-primary", "retry")]));
        content.replaceChildren(fragment);
    }

    function renderLoggedOut() {
        const fragment = document.createDocumentFragment();
        fragment.append(head("GITSTATUS 桌宠", "老大还没登录喵", [closeToTrayButton()]));
        fragment.append(el("p", "hint", "登录后我才能帮你盯着当天的待办喵～"));
        fragment.append(
            actionsRow([
                actionButton("去登录喵", "btn btn-primary", "open-login"),
                actionButton("隐藏桌宠", "btn btn-muted", "hide-pet"),
                actionButton("退出桌宠", "btn btn-muted", "quit")
            ])
        );
        content.replaceChildren(fragment);
    }

    function renderLoading() {
        const fragment = document.createDocumentFragment();
        fragment.append(head("GITSTATUS 桌宠", "正在看看待办喵…", [closeToTrayButton()]));
        fragment.append(
            actionsRow([
                actionButton("去待办喵", "btn btn-primary", "open-todo"),
                actionButton("隐藏桌宠", "btn btn-muted", "hide-pet")
            ])
        );
        content.replaceChildren(fragment);
    }

    function renderPanel(data) {
        if (data.offline) {
            renderOffline(data);
            return;
        }
        if (!data.loggedIn) {
            renderLoggedOut();
            return;
        }
        const summary = data.summary;
        if (!summary) {
            renderLoading();
            return;
        }

        const stats = summary.stats || {};
        const pending = Math.max(0, Number(stats.pending) || 0);
        const overdue = Math.max(0, Number(stats.overdue) || 0);
        const completed = Math.max(0, Number(stats.completed) || 0);

        const fragment = document.createDocumentFragment();
        fragment.append(
            head(
                "今天 · " + String(summary.today || "").slice(5),
                pending > 0 ? `老大还有 ${pending} 件事没做完喵～` : "今天的待办都完成啦喵，老大真棒！",
                [settingsButton(), closeBubbleButton()]
            )
        );

        if (pending > 0 || completed > 0) {
            const row = el("div", "stat-row");
            const pendingStat = el("span", "stat");
            pendingStat.append(el("strong", "", String(pending)), document.createTextNode("没做完"));
            row.append(pendingStat);
            if (overdue > 0) {
                const overdueStat = el("span", "stat is-danger");
                overdueStat.append(el("strong", "", String(overdue)), document.createTextNode("逾期了喵"));
                row.append(overdueStat);
            }
            if (completed > 0) {
                const doneStat = el("span", "stat");
                doneStat.append(el("strong", "", String(completed)), document.createTextNode("搞定啦"));
                row.append(doneStat);
            }
            fragment.append(row);
        }

        const preview = Array.isArray(summary.preview) ? summary.preview : [];
        if (preview.length > 0) {
            const list = el("ul", "list");
            for (const item of preview) {
                const li = el("li", "list-item" + (item.isOverdue ? " is-overdue" : ""));
                li.append(el("span", "list-title", String(item.title || "未命名待办")));
                if (item.dueTime) li.append(el("span", "list-time", String(item.dueTime)));
                list.append(li);
            }
            fragment.append(list);
        }

        if (summary.nextReminder) {
            const next = el("div", "next");
            next.append(
                document.createTextNode(
                    "下一条提醒喵 · " + formatTrigger(summary.nextReminder.triggerAt, summary.today) + " "
                ),
                el("strong", "", String(summary.nextReminder.title || "还有待办在等你喵"))
            );
            fragment.append(next);
        }

        fragment.append(
            actionsRow([
                actionButton(data.muted ? "提醒音：关喵" : "提醒音：开喵", "btn btn-muted", "toggle-mute"),
                actionButton("去待办喵", "btn btn-primary", "open-todo"),
                actionButton("隐藏桌宠", "btn btn-muted", "hide-pet")
            ])
        );
        content.replaceChildren(fragment);
    }

    function renderMini(data) {
        const compact = data.compact || {};
        const fragment = document.createDocumentFragment();
        if (compact.text) {
            fragment.append(
                el("span", "mini-kicker", String(compact.kicker || "桌宠喵")),
                el("span", "mini-text", String(compact.text))
            );
            content.replaceChildren(fragment);
            return;
        }

        fragment.append(el("span", "mini-kicker", String(compact.kicker || "待办喵")));
        const main = el("span", "mini-main");
        main.append(
            el("strong", "", String(compact.main ? compact.main.value : 0)),
            el("span", "", String(compact.main ? compact.main.unit : ""))
        );
        fragment.append(main);
        if (compact.title) fragment.append(el("span", "mini-title", String(compact.title)));
        if (compact.sub) fragment.append(el("span", "mini-sub", String(compact.sub)));
        const chips = Array.isArray(compact.chips) ? compact.chips : [];
        if (chips.length > 0) {
            const row = el("span", "mini-chips");
            for (const chip of chips.slice(0, 2)) {
                row.append(
                    el("span", "mini-chip" + (chip && chip.cls ? ` ${chip.cls}` : ""), chip && chip.text)
                );
            }
            fragment.append(row);
        }
        content.replaceChildren(fragment);
    }

    function renderNotice(data) {
        const fragment = document.createDocumentFragment();
        fragment.append(el("span", "mini-kicker", String(data.kicker || "桌宠喵")));
        fragment.append(el("span", "mini-text", String(data.text || "")));
        if (data.sub) fragment.append(el("span", "mini-sub", String(data.sub)));
        content.replaceChildren(fragment);
    }

    function renderReminder(data) {
        const fragment = document.createDocumentFragment();
        fragment.append(
            head(String(data.kicker || "待办提醒"), String(data.title || ""), [closeBubbleButton()])
        );
        if (data.message) fragment.append(el("p", "hint", String(data.message)));
        const buttons = [];
        if (data.snoozeMinutes) {
            buttons.push(actionButton("稍后提醒", "btn", "snooze", { minutes: data.snoozeMinutes }));
        }
        buttons.push(actionButton(String(data.actionLabel || "去待办喵"), "btn btn-primary", "open-todo"));
        fragment.append(actionsRow(buttons));
        content.replaceChildren(fragment);
    }

    // ---------- 尺寸回报 ----------
    function scheduleResize(force) {
        if (force) sizeForce = true;
        if (sizeFrame) return;
        sizeFrame = global.requestAnimationFrame(() => {
            sizeFrame = 0;
            const rect = bubble.getBoundingClientRect();
            const width = Math.ceil(rect.width) + PADDING * 2;
            const height = Math.ceil(rect.height) + PADDING * 2;
            const forced = sizeForce;
            sizeForce = false;
            // 新内容即使尺寸相同也要回报一次，否则窗口隐藏后再显示不会触发主进程定位
            if (!forced && width === lastSize.width && height === lastSize.height) return;
            lastSize = { width, height };
            api.resizeBubble(width, height);
        });
    }

    function applyPlacement(next) {
        placement = {
            above: !next || next.above !== false,
            alignRight: !next || next.alignRight !== false
        };
        bubble.classList.toggle("is-above", placement.above);
        bubble.classList.toggle("is-below", !placement.above);
        bubble.classList.toggle("align-right", placement.alignRight);
        bubble.classList.toggle("align-left", !placement.alignRight);
    }

    function setType(type) {
        for (const key of TYPE_CLASSES) bubble.classList.remove(key);
        bubble.classList.add(`is-${type}`);
    }

    // 透明窗口的显示/尺寸变化由主进程负责；卡片本身做透明度+轻微位移过渡。
    // 隐藏时先无过渡置 0，避免旧内容在窗口重新显示的第一帧闪一下。
    function hideCard() {
        if (!card) return;
        revealToken += 1;
        card.style.transition = "none";
        card.style.opacity = "0";
        card.style.transform = "translateY(6px) scale(0.98)";
        // 强制样式落地，避免同一帧内被过渡吃回去
        void card.offsetWidth;
    }

    function revealCard() {
        if (!card) return;
        const token = ++revealToken;
        card.style.transition = "";
        console.debug("[bubble] reveal", currentType);
        requestAnimationFrame(() => {
            if (token !== revealToken) return;
            requestAnimationFrame(() => {
                if (token !== revealToken) return;
                card.style.opacity = "";
                card.style.transform = "";
            });
        });
    }

    function render(type, data) {
        setType(type);
        if (type === "panel" || type === "reminder") {
            // 旧版气泡最大高度 560px，扣掉卡片上下内边距后就是内容滚动区高度
            content.style.maxHeight = `${Math.max(140, maxHeight - 25)}px`;
        } else {
            content.style.removeProperty("max-height");
        }
        if (type === "panel") renderPanel(data);
        else if (type === "mini") renderMini(data);
        else if (type === "notice") renderNotice(data);
        else if (type === "reminder") renderReminder(data);
        else content.replaceChildren();
        scheduleResize(true);
    }

    // ---------- 提示音 ----------
    function playChime() {
        try {
            const Ctx = global.AudioContext || global.webkitAudioContext;
            if (!Ctx) return;
            if (!audioCtx) audioCtx = new Ctx();
            const ctx = audioCtx;
            if (ctx.state === "suspended") ctx.resume().catch(() => {});
            const start = ctx.currentTime;
            [880, 1174].forEach((freq, index) => {
                const at = start + index * 0.14;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(0.06, at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(at);
                osc.stop(at + 0.18);
            });
        } catch {
            /* 音频不可用时静默降级 */
        }
    }

    // ---------- 事件 ----------
    content.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        const action = target.getAttribute("data-action") || "";
        const minutes = Number(target.getAttribute("data-minutes"));
        api.bubbleAction(action, Number.isFinite(minutes) && minutes > 0 ? { minutes } : {});
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") api.closeBubble();
    });

    document.body.addEventListener("pointerenter", () => api.setBubbleHover(true));
    document.body.addEventListener("pointerleave", () => api.setBubbleHover(false));

    new ResizeObserver(() => scheduleResize()).observe(bubble);
    global.addEventListener("resize", () => scheduleResize());

    api.onBubbleRender((message) => {
        if (!message || !message.type) return;
        const type = String(message.type);
        const typeChanged = type !== currentType;
        const animate = !shown || typeChanged;
        currentType = type;
        console.debug("[bubble] render", type, "shown", shown, "changed", typeChanged, "animate", animate);
        maxHeight = Math.max(200, Number(message.maxHeight) || 600);
        applyPlacement(placement);
        if (animate) hideCard();
        render(type, message.data || {});
        if (shown && typeChanged) revealPending = true;
        // 兜底：shown 事件极端情况下丢失时，别让卡片一直停在透明态
        if (revealFallback) clearTimeout(revealFallback);
        revealFallback = setTimeout(() => {
            revealFallback = 0;
            if (!shown) revealCard();
        }, 400);
        if (message.playSound) playChime();
    });

    api.onBubblePlacement((next) => {
        applyPlacement(next);
        // 类型切换时等主进程把窗口挪到最终尺寸后再淡入，避免看到窗口 resize
        if (shown && revealPending) {
            revealPending = false;
            revealCard();
        }
    });

    api.onBubbleShown(() => {
        shown = true;
        revealPending = false;
        if (revealFallback) {
            clearTimeout(revealFallback);
            revealFallback = 0;
        }
        console.debug("[bubble] shown");
        revealCard();
    });

    api.onBubbleHidden(() => {
        shown = false;
        revealPending = false;
        console.debug("[bubble] hidden");
        hideCard();
    });

    applyPlacement(placement);
    scheduleResize();
})(window);
