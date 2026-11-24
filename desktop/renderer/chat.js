/* ============================================================
   AI 助手浮窗
   - 数据全部走主进程代理（chat:*），页面是 file:// 不直接访问后端
   - 流式事件 chat:stream 由主进程逐条转发
   - 回复按 Markdown 渲染，原始 HTML 先经 DOMPurify 消毒
   ============================================================ */
(function (global) {
    "use strict";

    const api = global.desktopApi;
    if (!api) return;

    const dom = {
        card: document.getElementById("card"),
        sessionTitle: document.getElementById("sessionTitle"),
        sessionSelect: document.getElementById("sessionSelect"),
        deleteBtn: document.getElementById("deleteBtn"),
        newBtn: document.getElementById("newBtn"),
        webBtn: document.getElementById("webBtn"),
        closeBtn: document.getElementById("closeBtn"),
        notice: document.getElementById("notice"),
        messages: document.getElementById("messages"),
        empty: document.getElementById("empty"),
        attachList: document.getElementById("attachList"),
        attachBtn: document.getElementById("attachBtn"),
        input: document.getElementById("input"),
        sendBtn: document.getElementById("sendBtn"),
        stopBtn: document.getElementById("stopBtn"),
        foot: document.getElementById("foot")
    };

    const state = {
        loggedIn: false,
        offline: false,
        llm: null,
        sessions: [],
        activeId: null,
        streaming: false,
        attachments: [],
        noticeTimer: 0,
        attachments_: 0,
        /** 当前会话的 token 统计，由主进程代理 /chat/sessions/:id/stats */
        stats: null
    };

    const FILE_ICON =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
    const IMAGE_ICON =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };

    // ---------- Markdown ----------

    let purifyHooked = false;

    function ensurePurifyHook() {
        if (purifyHooked || !global.DOMPurify) return;
        purifyHooked = true;
        global.DOMPurify.addHook("afterSanitizeAttributes", (element) => {
            if (!element.tagName) return;
            if (element.tagName === "A" && element.getAttribute("href")) {
                element.setAttribute("target", "_blank");
                element.setAttribute("rel", "noopener noreferrer");
            }
            if (element.tagName === "IMG") {
                element.setAttribute("loading", "lazy");
                element.setAttribute("referrerpolicy", "no-referrer");
            }
        });
    }

    /** 渲染 markdown；依赖缺失时返回 null，调用方退回纯文本 */
    function renderMarkdown(text) {
        const source = String(text || "");
        if (!source.trim()) return "";
        if (!global.marked || !global.DOMPurify) return null;
        ensurePurifyHook();
        try {
            const html = global.marked.parse(source, { gfm: true, breaks: true });
            return global.DOMPurify.sanitize(html, {
                FORBID_TAGS: ["style", "form", "input", "button"],
                FORBID_ATTR: ["style", "onerror", "onload"]
            });
        } catch {
            return null;
        }
    }

    function paintMarkdown(bubble, text) {
        const html = renderMarkdown(text);
        if (html === null) bubble.textContent = text;
        else bubble.innerHTML = html;
    }

    // ---------- 通用 UI ----------

    function showNotice(message, type) {
        global.clearTimeout(state.noticeTimer);
        dom.notice.textContent = message;
        dom.notice.classList.toggle("is-error", type === "error");
        dom.notice.classList.remove("hidden");
        state.noticeTimer = global.setTimeout(() => dom.notice.classList.add("hidden"), 6000);
    }

    function hideNotice() {
        global.clearTimeout(state.noticeTimer);
        dom.notice.classList.add("hidden");
    }

    function scrollToBottom(force) {
        const box = dom.messages;
        if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 120) {
            box.scrollTop = box.scrollHeight;
        }
    }

    function formatSize(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatJson(raw) {
        const text = String(raw || "").trim();
        if (!text) return "（无参数）";
        try {
            return JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            return text;
        }
    }

    function updateComposer() {
        const disabled = !state.loggedIn || state.streaming;
        dom.input.disabled = disabled;
        dom.attachBtn.disabled = disabled;
        dom.sendBtn.disabled = disabled;
        dom.sendBtn.classList.toggle("hidden", state.streaming);
        dom.stopBtn.classList.toggle("hidden", !state.streaming);
        dom.deleteBtn.disabled = !state.activeId || state.streaming;
        dom.input.placeholder = state.loggedIn
            ? "问我点什么，Enter 发送"
            : "请先在桌面端登录 GitStatus";
    }

    function renderFoot(snapshot) {
        if (snapshot && snapshot.loggedIn === false) {
            dom.foot.textContent = "未登录：右键桌宠选择「登录 GitStatus」";
            return;
        }
        const model = state.llm && state.llm.model ? state.llm.model : "未配置模型";
        const configured = state.llm && state.llm.configured ? "" : "（未接入）";
        const headLine = state.offline
            ? "后台未运行，发送前请先启动后台"
            : `模型 ${model}${configured} · 双击桌宠可再次唤起`;

        dom.foot.replaceChildren();
        dom.foot.appendChild(node("span", "chat-foot-line", headLine));
        const totals = state.stats && state.stats.totals;
        if (totals && totals.requests > 0) {
            dom.foot.appendChild(
                node(
                    "span",
                    "chat-foot-usage",
                    `${usageSummary(totals, state.stats.cacheHitRate)} · ${totals.requests} 次请求`
                )
            );
        }
    }

    // ---------- Token 统计 ----------

    // 切会话时旧请求可能晚回，用序号丢弃过期结果
    let statsRequestId = 0;

    function formatTokens(value) {
        const count = Number(value) || 0;
        if (count < 1000) return String(count);
        if (count < 1000000) return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`;
        return `${(count / 1000000).toFixed(2)}M`;
    }

    function formatRate(rate) {
        return typeof rate === "number" && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : "—";
    }

    function usageSummary(usage, hitRate) {
        if (!usage) return "";
        const prompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
        return `↑${formatTokens(prompt)} ↓${formatTokens(usage.outputTokens)} · 命中 ${formatRate(hitRate)}`;
    }

    async function loadStats() {
        const requestId = ++statsRequestId;
        if (!state.activeId) {
            state.stats = null;
            renderFoot(null);
            return;
        }
        const result = await api.chatStats(state.activeId);
        if (requestId !== statsRequestId) return;
        state.stats = result && result.ok && result.json ? result.json.stats || null : null;
        renderFoot(null);
    }

    // ---------- 附件 ----------

    function renderAttachments() {
        dom.attachList.replaceChildren();
        dom.attachList.classList.toggle("hidden", state.attachments.length === 0);
        for (const item of state.attachments) {
            const chip = node("span", "chat-chip");
            const icon = node("span", "chat-chip-icon");
            icon.innerHTML = item.kind === "image" ? IMAGE_ICON : FILE_ICON;
            const name = node("span", "chat-chip-name", item.name || "附件");
            name.title = item.name || "";
            const remove = node("button", "chat-chip-remove", "×");
            remove.type = "button";
            remove.title = "移除附件";
            remove.addEventListener("click", () => void removeAttachment(item));
            chip.append(icon, name, node("span", "chat-chip-size", formatSize(item.size)), remove);
            dom.attachList.appendChild(chip);
        }
    }

    async function removeAttachment(item) {
        state.attachments = state.attachments.filter((entry) => entry.key !== item.key);
        renderAttachments();
        if (item.id) await api.chatRemoveAttachment(item.id);
    }

    async function pickAttachments() {
        if (state.attachments.length >= 5) {
            showNotice("一次最多 5 个附件", "error");
            return;
        }
        const result = await api.chatPickAttachment();
        if (!result || !result.ok) {
            if (result && result.message) showNotice(result.message, "error");
            return;
        }
        for (const item of result.attachments || []) {
            if (state.attachments.length >= 5) break;
            state.attachments.push({
                key: `a${Date.now()}-${Math.random().toString(16).slice(2)}`,
                id: Number(item.id) || 0,
                name: item.name || "附件",
                size: Number(item.size) || 0,
                kind: item.kind === "image" ? "image" : "file"
            });
        }
        renderAttachments();
    }

    // ---------- 消息渲染 ----------

    function buildAttachmentChip(item) {
        const chip = node("span", "chat-chip");
        const bound = Number(item.boundTodoId) || 0;
        const icon = node("span", "chat-chip-icon");
        icon.innerHTML = item.kind === "image" ? IMAGE_ICON : FILE_ICON;
        const name = node("span", "chat-chip-name", item.name || "附件");
        name.title = item.name || "";
        chip.append(
            icon,
            name,
            node("span", "chat-chip-size", bound ? `已加入 #${bound}` : formatSize(item.size))
        );
        return chip;
    }

    function buildUserMessage(content, attachments) {
        const wrap = node("div", "msg is-user");
        wrap.append(node("span", "msg-role", "我"));
        const list = Array.isArray(attachments) ? attachments : [];
        const text = content || (list.length > 0 ? `（附件：${list.map((item) => item.name).join("、")}）` : "");
        wrap.appendChild(node("div", "msg-bubble", text));
        if (list.length > 0) {
            const box = node("div", "msg-attachments");
            for (const item of list) box.appendChild(buildAttachmentChip(item));
            wrap.appendChild(box);
        }
        return wrap;
    }

    function buildToolCard(call) {
        const details = node("details", "tool is-pending");
        const summary = document.createElement("summary");
        const label = node("span", "tool-label", call.title || call.name || "工具");
        const name = node("span", "tool-name", call.name || "");
        const status = node("span", "tool-state", call.isError === true ? "失败" : call.content ? "完成" : "执行中…");
        summary.append(node("span", "tool-dot"), label, name, status);

        const body = node("div", "tool-body");
        const argsSection = node("div", "tool-section", "参数");
        const argsPre = document.createElement("pre");
        argsPre.textContent = formatJson(call.arguments);
        argsSection.appendChild(argsPre);

        const resultSection = node("div", "tool-section", "结果");
        const resultPre = document.createElement("pre");
        resultPre.textContent = call.content || "执行中…";
        resultSection.appendChild(resultPre);

        body.append(argsSection, resultSection);
        if (call.isError === true) {
            details.classList.remove("is-pending");
            details.classList.add("is-error");
        } else if (call.content) {
            details.classList.remove("is-pending");
            details.classList.add("is-ok");
        }
        details.append(summary, body);
        return { details, status, resultPre };
    }

    function buildAssistantMessage(message) {
        const wrap = node("div", "msg is-assistant");
        wrap.append(node("span", "msg-role", "助手"));

        const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        if (calls.length > 0) {
            const tools = node("div", "msg-tools");
            for (const call of calls) tools.appendChild(buildToolCard(call).details);
            wrap.appendChild(tools);
        }

        const bubble = node("div", "msg-bubble md");
        paintMarkdown(bubble, message.content || "");
        wrap.appendChild(bubble);

        if (message.interrupted) {
            wrap.appendChild(node("div", "msg-interrupted", "该回复被中断，内容可能不完整"));
        }
        if (message.usage) {
            wrap.appendChild(node("div", "msg-usage", usageSummary(message.usage, message.cacheHitRate)));
        }
        return wrap;
    }

    function renderMessages(messages) {
        dom.messages.replaceChildren();
        for (const message of messages) {
            dom.messages.appendChild(
                message.role === "user"
                    ? buildUserMessage(message.content, message.attachments)
                    : buildAssistantMessage(message)
            );
        }
        dom.empty.classList.toggle("hidden", messages.length > 0 || !state.activeId);
        scrollToBottom(true);
    }

    function renderEmptyPrompts() {
        dom.empty.replaceChildren();
        dom.empty.append(node("strong", "", "可以问点什么"));
        const list = document.createElement("ul");
        const prompts = [
            "今天还有哪些待办没完成？",
            "帮我建一条明天下午三点的待办，标题是「复核定稿」",
            "最近有哪些项目在运行？"
        ];
        for (const prompt of prompts) {
            const item = document.createElement("li");
            item.textContent = prompt;
            item.dataset.prompt = prompt;
            item.addEventListener("click", () => {
                dom.input.value = prompt;
                dom.input.focus();
            });
            list.appendChild(item);
        }
        dom.empty.appendChild(list);
        dom.empty.classList.remove("hidden");
    }

    function renderEmptyLogin() {
        dom.empty.replaceChildren();
        dom.empty.append(
            node("strong", "", "请先登录"),
            node("span", "", "助手会以你的账号身份读写数据，需要先在桌面端登录 GitStatus。")
        );
        const button = node("button", "tool-btn", "前往登录");
        button.style.marginTop = "10px";
        button.addEventListener("click", () => api.openLogin());
        dom.empty.appendChild(button);
        dom.empty.classList.remove("hidden");
        dom.messages.replaceChildren();
    }

    // ---------- 会话 ----------

    function renderSessions() {
        dom.sessionSelect.replaceChildren();
        if (state.sessions.length === 0) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = "还没有历史会话";
            dom.sessionSelect.appendChild(option);
            dom.sessionSelect.disabled = true;
        } else {
            dom.sessionSelect.disabled = false;
            for (const session of state.sessions) {
                const option = document.createElement("option");
                option.value = session.id;
                option.textContent = session.title || "新对话";
                dom.sessionSelect.appendChild(option);
            }
        }
        dom.sessionSelect.value = state.activeId || "";
        const active = state.sessions.find((item) => item.id === state.activeId);
        dom.sessionTitle.textContent = active ? active.title || "新对话" : "新对话";
        updateComposer();
    }

    async function openSession(id) {
        if (!id) return;
        state.activeId = id;
        renderSessions();
        const result = await api.chatMessages(id);
        if (!result || !result.ok) {
            showNotice((result && result.message) || "加载消息失败", "error");
            return;
        }
        const messages = result.json && Array.isArray(result.json.messages) ? result.json.messages : [];
        renderMessages(messages);
        if (messages.length === 0) renderEmptyPrompts();
        await loadStats();
    }

    async function createSession() {
        if (state.streaming) return null;
        const result = await api.chatCreateSession();
        if (!result || !result.ok || !result.json || !result.json.session) {
            showNotice((result && result.message) || "新建会话失败", "error");
            return null;
        }
        const session = result.json.session;
        state.sessions.unshift(session);
        state.activeId = session.id;
        state.stats = null;
        renderSessions();
        renderMessages([]);
        renderEmptyPrompts();
        renderFoot(null);
        dom.input.focus();
        return session.id;
    }

    async function deleteSession() {
        if (!state.activeId || state.streaming) return;
        if (!global.confirm("删除当前会话及其全部消息？")) return;
        const id = state.activeId;
        const result = await api.chatDeleteSession(id);
        if (!result || !result.ok) {
            showNotice((result && result.message) || "删除失败", "error");
            return;
        }
        state.sessions = state.sessions.filter((item) => item.id !== id);
        state.activeId = null;
        state.stats = null;
        renderSessions();
        dom.messages.replaceChildren();
        renderEmptyPrompts();
        renderFoot(null);
        if (state.sessions.length > 0) await openSession(state.sessions[0].id);
    }

    async function refreshSessions() {
        const snapshot = await api.chatGetState();
        if (!snapshot) return;
        state.sessions = snapshot.sessions || [];
        state.llm = snapshot.llm;
        state.loggedIn = Boolean(snapshot.loggedIn);
        state.offline = Boolean(snapshot.offline);
        renderFoot(snapshot);
        renderSessions();
    }

    // ---------- 发送 ----------

    let paintTimer = 0;
    let paintTarget = null;
    let paintedAt = 0;
    let textBuffer = "";
    let finished = false;

    function paintBubble(force) {
        if (!paintTarget) return;
        const now = Date.now();
        if (!force && now - paintedAt < 60) {
            if (!paintTimer) {
                paintTimer = global.setTimeout(() => {
                    paintTimer = 0;
                    paintBubble(true);
                }, 60);
            }
            return;
        }
        paintedAt = now;
        paintMarkdown(paintTarget, textBuffer);
    }

    async function send() {
        if (state.streaming) return;
        if (!state.loggedIn) {
            showNotice("请先在桌面端登录 GitStatus", "error");
            return;
        }
        const text = dom.input.value.trim();
        const files = state.attachments.filter((item) => item.id > 0);
        if (!text && files.length === 0) return;

        if (!state.activeId) {
            const id = await createSession();
            if (!id) return;
        }

        hideNotice();
        const sessionId = state.activeId;
        dom.messages.appendChild(buildUserMessage(text, files));
        dom.empty.classList.add("hidden");

        const wrap = node("div", "msg is-assistant");
        wrap.append(node("span", "msg-role", "助手"));
        const tools = node("div", "msg-tools");
        wrap.appendChild(tools);
        const bubble = node("div", "msg-bubble md is-pending");
        wrap.appendChild(bubble);
        dom.messages.appendChild(wrap);
        scrollToBottom(true);

        paintTarget = bubble;
        textBuffer = "";
        finished = false;
        paintedAt = 0;

        const sentKeys = new Set(files.map((item) => item.key));
        const attachmentIds = files.map((item) => item.id);
        dom.input.value = "";
        dom.input.style.height = "auto";
        state.attachments = state.attachments.filter((item) => !sentKeys.has(item.key));
        renderAttachments();

        state.streaming = true;
        updateComposer();

        const pending = new Map();

        const handleEvent = (payload) => {
            if (!payload) return;
            const event = payload.event;
            const data = payload.data || {};
            if (event === "delta") {
                textBuffer += String(data.text || "");
                paintBubble(false);
                scrollToBottom(false);
                return;
            }
            if (event === "tool_call") {
                const card = buildToolCard({
                    name: data.name,
                    title: data.title,
                    arguments: data.arguments
                });
                tools.appendChild(card.details);
                pending.set(data.id, card);
                scrollToBottom(false);
                return;
            }
            if (event === "tool_result") {
                const card = pending.get(data.id);
                if (!card) return;
                card.details.classList.remove("is-pending");
                card.details.classList.add(data.isError ? "is-error" : "is-ok");
                card.status.textContent = data.isError ? "失败" : "完成";
                card.resultPre.textContent = String(data.content || "");
                card.details.open = Boolean(data.isError);
                scrollToBottom(false);
                return;
            }
            if (event === "done") {
                finished = true;
                wrap.replaceWith(
                    buildAssistantMessage({
                        content: data.content || "",
                        toolCalls: data.toolCalls || [],
                        interrupted: data.interrupted === true,
                        usage: data.usage || null,
                        cacheHitRate: data.cacheHitRate === undefined ? null : data.cacheHitRate
                    })
                );
                scrollToBottom(false);
                void loadStats();
                return;
            }
            if (event === "error") {
                finished = true;
                bubble.classList.remove("is-pending");
                if (textBuffer) paintBubble(true);
                showNotice(String(data.message || "生成失败"), "error");
                if (!textBuffer && tools.childElementCount === 0) wrap.remove();
            }
        };

        const unsubscribe = api.onChatStream(handleEvent);
        try {
            const result = await api.chatSend({ sessionId, content: text, attachmentIds });
            if (result && result.aborted) {
                paintBubble(true);
                wrap.appendChild(node("div", "msg-interrupted", "已停止生成"));
            } else if (!finished) {
                bubble.classList.remove("is-pending");
                if (textBuffer) paintBubble(true);
                else bubble.textContent = "（没有收到回复）";
            }
        } finally {
            unsubscribe();
            if (paintTimer) {
                global.clearTimeout(paintTimer);
                paintTimer = 0;
            }
            paintTarget = null;
            state.streaming = false;
            updateComposer();
            void refreshSessions();
        }
    }

    function stop() {
        if (!state.streaming) return;
        api.chatStop();
    }

    // ---------- 事件 ----------

    function bindEvents() {
        dom.closeBtn.addEventListener("click", () => api.chatClose());
        dom.webBtn.addEventListener("click", () => api.chatOpenPage());
        dom.newBtn.addEventListener("click", () => void createSession());
        dom.deleteBtn.addEventListener("click", () => void deleteSession());
        dom.attachBtn.addEventListener("click", () => void pickAttachments());
        dom.sendBtn.addEventListener("click", () => void send());
        dom.stopBtn.addEventListener("click", () => stop());

        dom.sessionSelect.addEventListener("change", () => {
            const id = dom.sessionSelect.value;
            if (id && id !== state.activeId) void openSession(id);
        });

        dom.input.addEventListener("keydown", (event) => {
            // 中文输入法选词时的 Enter 不能当发送
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                void send();
            }
        });

        dom.input.addEventListener("input", () => {
            dom.input.style.height = "auto";
            dom.input.style.height = `${Math.min(dom.input.scrollHeight, 96)}px`;
        });

        api.onChatShown(() => dom.card.classList.add("is-shown"));
    }

    async function init() {
        bindEvents();
        updateComposer();
        renderSessions();

        const snapshot = await api.chatGetState();
        if (!snapshot) return;
        state.loggedIn = Boolean(snapshot.loggedIn);
        state.offline = Boolean(snapshot.offline);
        state.llm = snapshot.llm;
        state.sessions = snapshot.sessions || [];
        renderFoot(snapshot);
        renderSessions();

        if (!state.loggedIn) {
            renderEmptyLogin();
            updateComposer();
            return;
        }
        if (state.offline) {
            showNotice("后台还没有启动，先启动后台再对话", "error");
        }
        if (!state.llm || !state.llm.configured) {
            showNotice("后端还没配置模型，可在网页版「AI 助手」右上角齿轮里填写", "error");
        }
        if (state.sessions.length > 0) await openSession(state.sessions[0].id);
        else renderEmptyPrompts();
        updateComposer();

        // 兜底：chat:shown 极端情况下丢失时也要显示出来
        global.setTimeout(() => dom.card.classList.add("is-shown"), 600);
    }

    void init();
})(window);
