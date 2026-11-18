/* ============================================================
   AI 助手页
   - 会话与消息来自 /gitstatus/api/chat
   - 发送消息用 fetch 读 SSE：delta / tool_call / tool_result / done / error
   - 停止按钮直接 abort 请求，服务端会保留已生成内容
   ============================================================ */
(function () {
    "use strict";

    const Auth = window.GitStatusAuth;

    const dom = {
        navAccountLink: document.getElementById("navAccountLink"),
        chatUser: document.getElementById("chatUser"),
        chatFoot: document.getElementById("chatFoot"),
        chatNotice: document.getElementById("chatNotice"),
        chatEmpty: document.getElementById("chatEmpty"),
        sessionList: document.getElementById("sessionList"),
        messages: document.getElementById("messages"),
        newSessionBtn: document.getElementById("newSessionBtn"),
        composer: document.getElementById("composer"),
        input: document.getElementById("input"),
        sendBtn: document.getElementById("sendBtn"),
        stopBtn: document.getElementById("stopBtn"),
        attachBtn: document.getElementById("attachBtn"),
        attachInput: document.getElementById("attachInput"),
        attachList: document.getElementById("attachList"),
        dropMask: document.getElementById("dropMask"),
        llmSettingsBtn: document.getElementById("llmSettingsBtn"),
        llmModal: document.getElementById("llmModal"),
        llmCloseBtn: document.getElementById("llmCloseBtn"),
        llmStatus: document.getElementById("llmStatus"),
        llmForm: document.getElementById("llmForm"),
        llmBaseUrl: document.getElementById("llmBaseUrl"),
        llmModel: document.getElementById("llmModel"),
        llmApiKey: document.getElementById("llmApiKey"),
        llmKeyHint: document.getElementById("llmKeyHint"),
        llmTemperature: document.getElementById("llmTemperature"),
        llmMaxRounds: document.getElementById("llmMaxRounds"),
        llmFeedback: document.getElementById("llmFeedback"),
        llmTestBtn: document.getElementById("llmTestBtn"),
        llmSaveBtn: document.getElementById("llmSaveBtn"),
        llmClearBtn: document.getElementById("llmClearBtn"),
    };

    const ROLE_LABEL = { admin: "管理员", readwrite: "读写", readonly: "只读" };

    // 与后端 chat/attachments 的限制保持一致
    const ATTACH_MAX_FILES = 5;
    const ATTACH_MAX_BYTES = 32 * 1024 * 1024;
    const BLOCKED_FILE_RE = /\.(exe|msi|bat|cmd|com|scr|pif|ps1|vbs|vbe|js|jse|wsf|wsh|sh|jar|reg|lnk)$/i;

    const FILE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
    const IMAGE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

    const state = {
        user: null,
        configured: false,
        tools: null,
        llm: null,
        sessions: [],
        activeId: null,
        streaming: false,
        controller: null,
        noticeTimer: 0,
        /** 待发送的附件，status=ready 时才有服务端 id */
        attachments: [],
        /** 正在上传的数量，大于 0 时不允许发送 */
        uploading: 0,
    };

    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };

    /** 顶部提示条，自动消失；错误态换配色 */
    function showNotice(message, type) {
        window.clearTimeout(state.noticeTimer);
        dom.chatNotice.textContent = message;
        dom.chatNotice.classList.toggle("is-error", type === "error");
        dom.chatNotice.classList.remove("hidden");
        state.noticeTimer = window.setTimeout(() => {
            dom.chatNotice.classList.add("hidden");
        }, 6000);
    }

    function hideNotice() {
        window.clearTimeout(state.noticeTimer);
        dom.chatNotice.classList.add("hidden");
    }

    function scrollToBottom(force) {
        const box = dom.messages;
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
        if (force || nearBottom) box.scrollTop = box.scrollHeight;
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

    function updateComposerState() {
        const disabled = !state.user || !state.configured || state.streaming;
        dom.input.disabled = disabled;
        dom.attachBtn.disabled = disabled;
        // 上传未完成时不能发送：附件还没拿到服务端编号，模型无法引用
        dom.sendBtn.disabled = disabled || state.uploading > 0;
        dom.sendBtn.classList.toggle("hidden", state.streaming);
        dom.stopBtn.classList.toggle("hidden", !state.streaming);
        dom.input.placeholder = !state.user
            ? "请先登录后再使用助手"
            : !state.configured
                ? "后端尚未配置 LLM，请先补齐 config/config.json 的 llm 段"
                : "输入问题，Enter 发送，Shift + Enter 换行；文件可直接拖进来";
    }

    // ---------- 附件 ----------

    function formatSize(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    /** 历史消息里的附件快照：只读，不能移除 */
    function buildAttachmentChip(item) {
        const chip = node("span", "chat-chip");
        const bound = Number(item.boundTodoId) || 0;
        if (bound) chip.classList.add("is-bound");
        const icon = node("span", "chat-chip-icon");
        icon.innerHTML = item.kind === "image" ? IMAGE_ICON : FILE_ICON;
        const name = node("span", "chat-chip-name", item.name || "附件");
        name.title = item.name || "";
        chip.append(
            icon,
            name,
            node("span", "chat-chip-size", bound ? `已加入 #${bound}` : formatSize(item.size)),
        );
        return chip;
    }

    /** 输入区里待发送的附件：带上传状态与移除按钮 */
    function renderAttachments() {
        dom.attachList.replaceChildren();
        dom.attachList.classList.toggle("hidden", state.attachments.length === 0);
        for (const item of state.attachments) {
            const chip = node("span", "chat-chip");
            chip.classList.toggle("is-uploading", item.status === "uploading");
            chip.classList.toggle("is-error", item.status === "error");
            const icon = node("span", "chat-chip-icon");
            icon.innerHTML = item.kind === "image" ? IMAGE_ICON : FILE_ICON;
            const name = node("span", "chat-chip-name", item.name);
            name.title = item.status === "error" ? item.error || item.name : item.name;
            chip.append(icon, name);
            if (item.status === "uploading") {
                chip.append(node("span", "chat-chip-size", "上传中…"));
            } else if (item.status === "error") {
                chip.append(node("span", "chat-chip-size", "失败"));
            } else {
                chip.append(node("span", "chat-chip-size", formatSize(item.size)));
            }
            const remove = node("button", "chat-chip-remove", "×");
            remove.type = "button";
            remove.title = "移除附件";
            remove.addEventListener("click", () => void removeAttachment(item));
            chip.append(remove);
            dom.attachList.appendChild(chip);
        }
    }

    async function removeAttachment(item) {
        state.attachments = state.attachments.filter((entry) => entry.key !== item.key);
        renderAttachments();
        updateComposerState();
        if (item.status !== "ready" || !item.id) return;
        try {
            await Auth.apiFetch(`/chat/attachments/${item.id}`, { method: "DELETE" });
        } catch {
            /* 已经绑定或已被清理，不影响界面 */
        }
    }

    /** 选文件 / 拖文件 / 粘贴图片都走这里：一次请求上传，服务端按顺序返回编号 */
    async function addFiles(fileList) {
        if (!state.user) {
            showNotice("请先登录后再添加附件", "error");
            return;
        }
        const incoming = Array.from(fileList || []);
        if (incoming.length === 0) return;

        const room = ATTACH_MAX_FILES - state.attachments.length;
        if (room <= 0) {
            showNotice(`一次最多 ${ATTACH_MAX_FILES} 个附件`, "error");
            return;
        }
        if (incoming.length > room) {
            showNotice(`一次最多 ${ATTACH_MAX_FILES} 个附件，多余的已忽略`, "error");
        }

        const accepted = [];
        for (const file of incoming.slice(0, room)) {
            if (file.size > ATTACH_MAX_BYTES) {
                showNotice(`${file.name} 超过 32 MB`, "error");
                continue;
            }
            if (BLOCKED_FILE_RE.test(file.name)) {
                showNotice(`${file.name} 是不允许上传的文件类型`, "error");
                continue;
            }
            accepted.push(file);
        }
        if (accepted.length === 0) return;

        const entries = accepted.map((file) => ({
            key: `a${Date.now()}-${Math.random().toString(16).slice(2)}`,
            name: file.name,
            size: file.size,
            kind: String(file.type || "").startsWith("image/") ? "image" : "file",
            status: "uploading",
            error: "",
            id: 0,
        }));
        state.attachments.push(...entries);
        state.uploading += entries.length;
        renderAttachments();
        updateComposerState();

        try {
            const form = new FormData();
            accepted.forEach((file) => form.append("files", file, file.name));
            if (state.activeId) form.append("sessionId", state.activeId);
            const response = await Auth.apiFetch("/chat/attachments", { method: "POST", body: form });
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "上传失败");
            const created = Array.isArray(json.attachments) ? json.attachments : [];
            entries.forEach((entry, index) => {
                const live = state.attachments.find((item) => item.key === entry.key);
                if (!live) return;
                const saved = created[index];
                if (!saved) {
                    live.status = "error";
                    live.error = "服务端没有返回附件信息";
                    return;
                }
                live.id = Number(saved.id) || 0;
                live.size = Number(saved.size) || live.size;
                live.kind = saved.kind || live.kind;
                live.status = live.id ? "ready" : "error";
            });
        } catch (error) {
            entries.forEach((entry) => {
                const live = state.attachments.find((item) => item.key === entry.key);
                if (live) {
                    live.status = "error";
                    live.error = error.message || "上传失败";
                }
            });
            if (error.status !== 401) showNotice(error.message || "附件上传失败", "error");
        } finally {
            state.uploading = Math.max(0, state.uploading - entries.length);
            renderAttachments();
            updateComposerState();
        }
    }

    /** 拖拽时只有带文件的拖动才接管，避免抢掉文本拖选 */
    function dragHasFiles(event) {
        const types = event.dataTransfer && event.dataTransfer.types;
        return Boolean(types && Array.from(types).includes("Files"));
    }

    // ---------- Markdown ----------

    // 模型输出属于不可信内容：先按 GFM 解析，再统一消毒。
    // 否则工具结果里的待办标题带了 <script> 之类会被直接注入页面。
    let purifyHooked = false;

    function ensurePurifyHook() {
        if (purifyHooked || !window.DOMPurify) return;
        purifyHooked = true;
        window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
            if (!node.tagName) return;
            if (node.tagName === "A" && node.getAttribute("href")) {
                // 外链新窗口打开，并切断 opener
                node.setAttribute("target", "_blank");
                node.setAttribute("rel", "noopener noreferrer");
            }
            if (node.tagName === "IMG") {
                node.setAttribute("loading", "lazy");
                node.setAttribute("referrerpolicy", "no-referrer");
            }
        });
    }

    /** 渲染 markdown；依赖没加载时返回 null，由调用方退回纯文本 */
    function renderMarkdown(text) {
        const source = String(text || "");
        if (!source.trim()) return "";
        if (!window.marked || !window.DOMPurify) return null;
        ensurePurifyHook();
        try {
            const html = window.marked.parse(source, { gfm: true, breaks: true });
            return window.DOMPurify.sanitize(html, {
                FORBID_TAGS: ["style", "form", "input", "button"],
                FORBID_ATTR: ["style", "onerror", "onload"],
            });
        } catch {
            return null;
        }
    }

    /** 写进气泡；渲染失败时退回纯文本，至少不丢内容 */
    function paintMarkdown(bubble, text) {
        const html = renderMarkdown(text);
        if (html === null) bubble.textContent = text;
        else bubble.innerHTML = html;
    }

    // ---------- 渲染 ----------

    function renderSessions() {
        dom.sessionList.replaceChildren();
        if (state.sessions.length === 0) {
            dom.sessionList.appendChild(node("div", "chat-sidebar-foot", "还没有历史会话"));
            return;
        }
        for (const session of state.sessions) {
            const item = node("div", "chat-session");
            item.classList.toggle("is-active", session.id === state.activeId);
            const title = node("span", "chat-session-title", session.title || "新对话");
            title.title = session.title || "新对话";
            const remove = node("button", "chat-session-del", "×");
            remove.type = "button";
            remove.title = "删除该会话";
            remove.addEventListener("click", (event) => {
                event.stopPropagation();
                void deleteSession(session.id);
            });
            item.append(title, remove);
            item.addEventListener("click", () => void selectSession(session.id));
            dom.sessionList.appendChild(item);
        }
    }

    function updateEmptyState() {
        const hasMessages = dom.messages.childElementCount > 0;
        dom.chatEmpty.classList.toggle("hidden", hasMessages || !state.activeId);
    }

    /** 工具调用卡片；pending 时结果区显示占位 */
    function buildToolCard(call) {
        const details = node("details", "tool-card is-pending");
        const summary = document.createElement("summary");
        const dot = node("span", "tool-dot");
        const label = node("span", "tool-label", call.title || call.name);
        const name = node("span", "tool-name", call.name || "");
        const status = node("span", "tool-state", call.isError === true ? "失败" : call.content ? "完成" : "执行中…");
        summary.append(dot, label, name, status);

        const body = node("div", "tool-body");
        const argsSection = node("div", "tool-section");
        argsSection.append(node("span", "", "参数"));
        const argsPre = document.createElement("pre");
        argsPre.textContent = formatJson(call.arguments);
        argsSection.append(argsPre);

        const resultSection = node("div", "tool-section");
        resultSection.append(node("span", "", "结果"));
        const resultPre = document.createElement("pre");
        resultPre.textContent = call.content || "执行中…";
        resultSection.append(resultPre);

        body.append(argsSection, resultSection);

        if (call.isError === true) {
            details.classList.remove("is-pending");
            details.classList.add("is-error");
        } else if (call.content) {
            details.classList.remove("is-pending");
            details.classList.add("is-ok");
        }

        details.append(summary, body);
        return { details, status, resultPre, resultSection };
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

    function buildAssistantMessage(message) {
        const wrap = node("div", "msg is-assistant");
        wrap.append(node("span", "msg-role", "助手"));

        const tools = node("div", "msg-tools");
        const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        for (const call of toolCalls) {
            tools.appendChild(buildToolCard(call).details);
        }
        if (toolCalls.length > 0) wrap.appendChild(tools);

        const bubble = node("div", "msg-bubble md");
        paintMarkdown(bubble, message.content || "");
        wrap.appendChild(bubble);

        if (message.interrupted) {
            wrap.appendChild(node("div", "msg-interrupted", "该回复被中断，内容可能不完整"));
        }
        return wrap;
    }

    function renderMessages(messages) {
        dom.messages.replaceChildren();
        for (const message of messages) {
            dom.messages.appendChild(
                message.role === "user"
                    ? buildUserMessage(message.content, message.attachments)
                    : buildAssistantMessage(message),
            );
        }
        updateEmptyState();
        scrollToBottom(true);
    }

    // ---------- 数据 ----------

    const SOURCE_LABEL = {
        saved: "页面保存",
        env: "环境变量",
        config: "config/config.json",
        none: "未配置",
    };

    function updateChatFoot() {
        if (!state.tools) return;
        const model = state.llm?.model || "未配置";
        dom.chatFoot.textContent = `模型 ${model} · 可用工具 ${state.tools.visible}/${state.tools.total}`;
    }

    /** 把配置状态渲染进设置面板；接口只给掩码，页面拿不到明文 */
    function renderLlm(status) {
        state.llm = status || null;
        state.configured = Boolean(status && status.configured);
        if (!status) return;

        const label = SOURCE_LABEL[status.source] || status.source;
        const parts = [`当前来源：${label}`];
        if (status.apiKeyMasked) parts.push(`密钥 ${status.apiKeyMasked}`);
        if (status.model) parts.push(`模型 ${status.model}`);
        dom.llmStatus.textContent = parts.join(" · ");

        dom.llmBaseUrl.value = status.baseUrl || "";
        dom.llmModel.value = status.model || "";
        dom.llmTemperature.value = String(status.temperature ?? 0.3);
        dom.llmMaxRounds.value = String(status.maxToolRounds ?? 6);
        dom.llmApiKey.value = "";
        dom.llmKeyHint.textContent = status.source === "saved"
            ? "已保存密钥，留空表示不修改。"
            : status.configured
                ? `当前值来自${label}，保存后会覆盖它。`
                : "首次配置必须填写 API Key。";
    }

    function setLlmFeedback(text, type) {
        dom.llmFeedback.textContent = text;
        dom.llmFeedback.classList.remove("hidden", "is-ok", "is-error");
        dom.llmFeedback.classList.add(type === "error" ? "is-error" : "is-ok");
    }

    function openLlmModal() {
        dom.llmModal.classList.remove("hidden");
        dom.llmFeedback.classList.add("hidden");
        void refreshLlm();
    }

    function closeLlmModal() {
        dom.llmModal.classList.add("hidden");
    }

    async function refreshLlm() {
        try {
            const response = await Auth.apiFetch("/chat/llm");
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "读取配置失败");
            renderLlm(json.llm);
            updateComposerState();
        } catch (error) {
            if (error.status === 401) return;
            dom.llmStatus.textContent = error.message || "读取配置失败";
        }
    }

    async function saveLlm(event) {
        event.preventDefault();
        dom.llmSaveBtn.disabled = true;
        try {
            const temperatureText = dom.llmTemperature.value.trim();
            const roundsText = dom.llmMaxRounds.value.trim();
            const response = await Auth.apiFetch("/chat/llm", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    baseUrl: dom.llmBaseUrl.value.trim(),
                    model: dom.llmModel.value.trim(),
                    apiKey: dom.llmApiKey.value.trim(),
                    ...(temperatureText ? { temperature: Number(temperatureText) } : {}),
                    ...(roundsText ? { maxToolRounds: Number(roundsText) } : {}),
                }),
            });
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "保存失败");
            renderLlm(json.llm);
            updateComposerState();
            updateChatFoot();
            setLlmFeedback("配置已保存，下一次对话立即生效。", "ok");
            hideNotice();
        } catch (error) {
            if (error.status === 401) return;
            setLlmFeedback(error.message || "保存失败", "error");
        } finally {
            dom.llmSaveBtn.disabled = false;
        }
    }

    /** 测试用当前表单值，方便先测再存 */
    async function testLlm() {
        dom.llmTestBtn.disabled = true;
        setLlmFeedback("正在测试连接…", "ok");
        try {
            const response = await Auth.apiFetch("/chat/llm/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    baseUrl: dom.llmBaseUrl.value.trim(),
                    model: dom.llmModel.value.trim(),
                    apiKey: dom.llmApiKey.value.trim(),
                }),
            });
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "测试失败");
            setLlmFeedback(json.message || (json.ok ? "连接正常" : "测试失败"), json.ok ? "ok" : "error");
        } catch (error) {
            if (error.status === 401) return;
            setLlmFeedback(error.message || "测试失败", "error");
        } finally {
            dom.llmTestBtn.disabled = false;
        }
    }

    async function clearLlm() {
        if (!window.confirm("清除页面保存的模型配置？会回退到环境变量或 config/config.json。")) return;
        try {
            const response = await Auth.apiFetch("/chat/llm", { method: "DELETE" });
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "清除失败");
            renderLlm(json.llm);
            updateComposerState();
            updateChatFoot();
            setLlmFeedback("已清除，当前使用回退配置。", "ok");
        } catch (error) {
            if (error.status === 401) return;
            setLlmFeedback(error.message || "清除失败", "error");
        }
    }

    async function loadConfig() {
        try {
            const [configRes, llmRes] = await Promise.all([
                Auth.apiFetch("/chat/config"),
                Auth.apiFetch("/chat/llm"),
            ]);
            const config = await Auth.parseJson(configRes);
            const llm = await Auth.parseJson(llmRes);
            if (!configRes.ok || !config.res) throw new Error(config.message || "读取助手配置失败");

            state.tools = config.tools || null;
            // renderLlm 会同步 state.configured
            renderLlm(llm && llm.res ? llm.llm : null);
            updateChatFoot();
            updateComposerState();

            if (!state.configured) {
                const canEdit = Boolean(state.user && state.user.role === "admin");
                showNotice(
                    canEdit
                        ? "助手还没接入模型：点右上角齿轮，填写 baseUrl、API Key 与模型名即可。"
                        : "助手还没接入模型：请联系管理员在「AI 助手」页的设置里配置。",
                    "error",
                );
            } else {
                hideNotice();
            }
        } catch (error) {
            if (error.status === 401) return;
            showNotice(error.message || "读取助手配置失败", "error");
        }
    }

    async function loadSessions() {
        try {
            const response = await Auth.apiFetch("/chat/sessions");
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "加载会话失败");
            state.sessions = Array.isArray(json.sessions) ? json.sessions : [];
            renderSessions();
        } catch (error) {
            if (error.status === 401) return;
            showNotice(error.message || "加载会话失败", "error");
        }
    }

    async function createSession() {
        try {
            const response = await Auth.apiFetch("/chat/sessions", { method: "POST" });
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "新建会话失败");
            state.sessions.unshift(json.session);
            state.activeId = json.session.id;
            renderSessions();
            renderMessages([]);
            dom.input.focus();
            return json.session.id;
        } catch (error) {
            if (error.status === 401) return null;
            showNotice(error.message || "新建会话失败", "error");
            return null;
        }
    }

    async function deleteSession(id) {
        if (!window.confirm("删除这个会话及其全部消息？")) return;
        try {
            const response = await Auth.apiFetch(`/chat/sessions/${encodeURIComponent(id)}`, {
                method: "DELETE",
            });
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "删除失败");
            state.sessions = state.sessions.filter((item) => item.id !== id);
            if (state.activeId === id) {
                state.activeId = null;
                renderMessages([]);
                dom.chatEmpty.classList.add("hidden");
            }
            renderSessions();
        } catch (error) {
            if (error.status === 401) return;
            showNotice(error.message || "删除会话失败", "error");
        }
    }

    async function selectSession(id) {
        if (state.streaming) {
            showNotice("正在生成回复，先点「停止」再切换会话", "error");
            return;
        }
        state.activeId = id;
        renderSessions();
        try {
            const response = await Auth.apiFetch(`/chat/sessions/${encodeURIComponent(id)}/messages`);
            const json = await Auth.parseJson(response);
            if (!response.ok || !json.res) throw new Error(json.message || "加载消息失败");
            renderMessages(Array.isArray(json.messages) ? json.messages : []);
        } catch (error) {
            if (error.status === 401) return;
            showNotice(error.message || "加载消息失败", "error");
        }
    }

    // ---------- SSE ----------

    /** 逐行解析 SSE，按 event 名回调；注释行（心跳）直接忽略 */
    async function consumeSse(response, onEvent) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = "";
        let dataLines = [];

        const flush = () => {
            if (dataLines.length > 0) {
                const raw = dataLines.join("\n");
                let data = null;
                try {
                    data = JSON.parse(raw);
                } catch {
                    data = null;
                }
                if (data !== null) onEvent(eventName || "message", data);
            }
            dataLines = [];
            eventName = "";
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index = buffer.indexOf("\n");
            while (index >= 0) {
                const line = buffer.slice(0, index).replace(/\r$/, "");
                buffer = buffer.slice(index + 1);
                if (line === "") {
                    flush();
                } else if (line.startsWith(":")) {
                    // 心跳
                } else if (line.startsWith("event:")) {
                    eventName = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).trim());
                }
                index = buffer.indexOf("\n");
            }
        }
        flush();
    }

    // ---------- 发送 ----------

    /** 表单提交入口：文字与附件至少要有一个 */
    function submitComposer() {
        if (state.streaming || state.uploading > 0) return;
        const text = dom.input.value.trim();
        const ready = state.attachments.filter((item) => item.status === "ready" && item.id > 0);
        if (!text && ready.length === 0) return;
        dom.input.value = "";
        dom.input.style.height = "auto";
        void sendMessage(text, ready);
    }

    async function sendMessage(text, attachments) {
        if (!state.user) {
            showNotice("请先登录后再使用助手", "error");
            return;
        }
        if (!state.configured) {
            showNotice("后端尚未配置 LLM，无法发送", "error");
            return;
        }
        const files = Array.isArray(attachments) ? attachments : [];
        const attachmentIds = files
            .map((item) => Number(item.id))
            .filter((id) => Number.isInteger(id) && id > 0);
        if (!state.activeId) {
            const id = await createSession();
            if (!id) return;
        }

        hideNotice();
        const sessionId = state.activeId;
        dom.chatEmpty.classList.add("hidden");
        dom.messages.appendChild(buildUserMessage(text, files));
        scrollToBottom(true);

        // 流式占位：先建好气泡和工具容器，后面原地更新
        const wrap = node("div", "msg is-assistant");
        wrap.append(node("span", "msg-role", "助手"));
        const tools = node("div", "msg-tools");
        wrap.appendChild(tools);
        const bubble = node("div", "msg-bubble md is-pending");
        wrap.appendChild(bubble);
        dom.messages.appendChild(wrap);
        scrollToBottom(true);

        const pending = new Map();
        let textBuffer = "";
        let finished = false;
        let paintedAt = 0;
        let paintTimer = 0;

        // 流式增量最多 60ms 重绘一次：每个 delta 都整体解析 markdown，长回复会明显卡顿
        const paintBubble = (force) => {
            const now = Date.now();
            if (!force && now - paintedAt < 60) {
                if (!paintTimer) {
                    paintTimer = window.setTimeout(() => {
                        paintTimer = 0;
                        paintBubble(true);
                    }, 60);
                }
                return;
            }
            paintedAt = now;
            paintMarkdown(bubble, textBuffer);
        };

        state.streaming = true;
        state.controller = new AbortController();
        updateComposerState();

        try {
            const response = await Auth.apiFetch(
                `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content: text, attachmentIds }),
                    signal: state.controller.signal,
                },
            );
            if (!response.ok) {
                const json = await Auth.parseJson(response);
                throw new Error(json.message || `请求失败（${response.status}）`);
            }

            // 服务端已接收：把已发送的附件从输入区移除（可能还有其他上传中的）
            if (files.length > 0) {
                const sentKeys = new Set(files.map((item) => item.key));
                state.attachments = state.attachments.filter((item) => !sentKeys.has(item.key));
                renderAttachments();
                updateComposerState();
            }

            await consumeSse(response, (event, data) => {
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
                        arguments: data.arguments,
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
                    bubble.classList.remove("is-pending");
                    // 用服务端落库的数据重绘，保证展示与历史一致
                    wrap.replaceWith(
                        buildAssistantMessage({
                            content: data.content || "",
                            toolCalls: data.toolCalls || [],
                            interrupted: data.interrupted === true,
                        }),
                    );
                    scrollToBottom(false);
                    void loadSessions();
                    return;
                }
                if (event === "error") {
                    finished = true;
                    bubble.classList.remove("is-pending");
                    if (textBuffer) paintBubble(true);
                    else bubble.textContent = "";
                    showNotice(String(data.message || "生成失败"), "error");
                    if (!textBuffer && tools.childElementCount === 0) {
                        wrap.remove();
                    }
                }
            });

            if (!finished) {
                bubble.classList.remove("is-pending");
                if (textBuffer) {
                    paintBubble(true);
                } else {
                    bubble.textContent = "（没有收到回复）";
                }
            }
        } catch (error) {
            bubble.classList.remove("is-pending");
            if (error.name === "AbortError") {
                // 主动停止：服务端已把已生成内容落库，刷新一次会话内容
                paintMarkdown(bubble, textBuffer);
                if (textBuffer) {
                    wrap.appendChild(node("div", "msg-interrupted", "已停止生成"));
                }
                await selectSession(sessionId);
            } else if (error.status === 401) {
                window.location.href = "/pages/index.html";
            } else {
                showNotice(error.message || "发送失败", "error");
                if (!textBuffer) wrap.remove();
            }
        } finally {
            if (paintTimer) {
                window.clearTimeout(paintTimer);
                paintTimer = 0;
            }
            state.streaming = false;
            state.controller = null;
            updateComposerState();
        }
    }

    // ---------- 事件与初始化 ----------

    function bindEvents() {
        dom.newSessionBtn.addEventListener("click", () => void createSession());

        dom.llmSettingsBtn.addEventListener("click", () => openLlmModal());
        dom.llmCloseBtn.addEventListener("click", () => closeLlmModal());
        dom.llmForm.addEventListener("submit", (event) => void saveLlm(event));
        dom.llmTestBtn.addEventListener("click", () => void testLlm());
        dom.llmClearBtn.addEventListener("click", () => void clearLlm());
        dom.llmModal.addEventListener("click", (event) => {
            if (event.target === dom.llmModal) closeLlmModal();
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closeLlmModal();
        });

        dom.composer.addEventListener("submit", (event) => {
            event.preventDefault();
            submitComposer();
        });

        // 附件：点选、拖入窗口、粘贴图片都进同一个上传入口
        dom.attachBtn.addEventListener("click", () => dom.attachInput.click());
        dom.attachInput.addEventListener("change", () => {
            if (dom.attachInput.files) void addFiles(dom.attachInput.files);
            dom.attachInput.value = "";
        });
        dom.input.addEventListener("paste", (event) => {
            const files = event.clipboardData && event.clipboardData.files;
            if (files && files.length > 0) {
                event.preventDefault();
                void addFiles(files);
            }
        });

        const dropZone = dom.messages.closest(".chat-main") || document.body;
        let dragDepth = 0;
        dropZone.addEventListener("dragenter", (event) => {
            if (!dragHasFiles(event)) return;
            event.preventDefault();
            dragDepth += 1;
            dom.dropMask.classList.remove("hidden");
        });
        dropZone.addEventListener("dragover", (event) => {
            if (!dragHasFiles(event)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        });
        dropZone.addEventListener("dragleave", () => {
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) dom.dropMask.classList.add("hidden");
        });
        dropZone.addEventListener("drop", (event) => {
            if (!dragHasFiles(event)) return;
            event.preventDefault();
            dragDepth = 0;
            dom.dropMask.classList.add("hidden");
            const files = event.dataTransfer && event.dataTransfer.files;
            if (files && files.length > 0) void addFiles(files);
        });
        // 拖到窗口外面松手时清掉遮罩
        window.addEventListener("dragend", () => {
            dragDepth = 0;
            dom.dropMask.classList.add("hidden");
        });
        // 阻止浏览器默认行为：否则拖到页面空白处会直接打开文件、丢掉当前会话
        window.addEventListener("dragover", (event) => {
            if (dragHasFiles(event)) event.preventDefault();
        });
        window.addEventListener("drop", (event) => {
            if (dragHasFiles(event)) event.preventDefault();
        });

        dom.stopBtn.addEventListener("click", () => {
            if (state.controller) state.controller.abort();
        });

        dom.input.addEventListener("input", () => {
            dom.input.style.height = "auto";
            dom.input.style.height = `${Math.min(dom.input.scrollHeight, 160)}px`;
        });

        dom.input.addEventListener("keydown", (event) => {
            // 中文输入法选词时的 Enter 不能当发送
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                dom.composer.requestSubmit();
            }
        });

        dom.chatEmpty.addEventListener("click", (event) => {
            const item = event.target.closest("li[data-prompt]");
            if (!item) return;
            dom.input.value = item.dataset.prompt || "";
            dom.input.focus();
        });
    }

    async function init() {
        bindEvents();
        updateComposerState();

        const user = await Auth.loadCurrentUser();
        state.user = user;
        dom.chatUser.textContent = user
            ? `${user.username} · ${ROLE_LABEL[user.role] || user.role}`
            : "未登录";
        dom.navAccountLink.classList.toggle("hidden", !user);
        // 模型配置是全局资源，只有管理员能看到设置入口
        dom.llmSettingsBtn.classList.toggle("hidden", !user || user.role !== "admin");
        dom.chatFoot.textContent = user ? "正在读取助手配置…" : "—";

        if (!user) {
            dom.chatEmpty.classList.remove("hidden");
            dom.chatEmpty.replaceChildren();
            dom.chatEmpty.append(
                node("strong", "", "请先登录"),
                node("span", "", "AI 助手会以你的账号身份调用接口，需要先登录才能使用。"),
            );
            const link = node("a", "btn btn-primary", "前往登录");
            link.href = "/pages/index.html";
            link.style.marginTop = "12px";
            link.style.display = "inline-block";
            dom.chatEmpty.appendChild(link);
            updateComposerState();
            return;
        }

        await loadConfig();
        await loadSessions();
        updateComposerState();

        // 默认选中最近一个会话；没有就保持空态
        if (state.sessions.length > 0) {
            await selectSession(state.sessions[0].id);
        }
        dom.input.focus();
    }

    init();
})();
