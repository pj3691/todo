/* ============================================================
   GitStatus 项目管理页
   依赖 auth-client.js 提供的 GitStatusAuth
   ============================================================ */
(function () {
    "use strict";

    if (navigator.userAgent.includes("Electron")) {
        document.documentElement.classList.add("desktop-app");
    }

    const Auth = window.GitStatusAuth;
    const TYPE_LABELS = {
        node: "Node.js",
        python: "Python",
        java: "Java",
        go: "Go",
        rust: "Rust",
        php: "PHP",
        dotnet: ".NET",
        custom: "自定义",
    };
    const STATUS_META = {
        stopped: { label: "已停止", className: "is-stopped" },
        starting: { label: "启动中", className: "is-starting" },
        running: { label: "运行中", className: "is-running" },
        stopping: { label: "停止中", className: "is-stopping" },
        error: { label: "异常", className: "is-error" },
    };
    const ACTIVE_STATUSES = ["starting", "running", "stopping"];
    const RUN_STATUS_META = {
        running: { label: "运行中", className: "is-running" },
        stopping: { label: "停止中", className: "is-stopping" },
        success: { label: "已完成", className: "is-success" },
        error: { label: "失败", className: "is-error" },
        stopped: { label: "已停止", className: "is-stopped" },
    };
    const EDITOR_META = {
        vscode: { label: "VS Code" },
        qoder: { label: "Qoder IDE" },
        explorer: { label: "文件资源管理器" },
    };
    const DEFAULT_EDITORS_KEY = "gitstatus_project_default_editors";
    const USAGE_COLLAPSED_KEY = "gitstatus_projects_usage_collapsed";

    const readUsageCollapsed = () => {
        try {
            return localStorage.getItem(USAGE_COLLAPSED_KEY) === "1";
        } catch {
            return false;
        }
    };

    const loadDefaultEditors = () => {
        const defaults = new Map();
        try {
            const raw = localStorage.getItem(DEFAULT_EDITORS_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === "object") {
                Object.entries(parsed).forEach(([id, editor]) => {
                    const projectId = Number(id);
                    if (Number.isInteger(projectId) && EDITOR_META[editor]) {
                        defaults.set(projectId, editor);
                    }
                });
            }
        } catch {
            /* localStorage 不可用时保留 VS Code 默认值 */
        }
        return defaults;
    };

    const state = {
        user: null,
        projects: [],
        editors: { vscode: true, qoder: true, explorer: true },
        editingId: null,
        expandedProjects: new Set(),
        selectedCommands: new Map(),
        defaultEditors: loadDefaultEditors(),
        usage: [],
        usageAvailable: true,
        usageLoading: false,
        usagePolling: false,
        usageTimer: 0,
        usageSampledAt: "",
        usageError: "",
        usageCollapsed: readUsageCollapsed(),
        statusPollTimer: 0,
        statusPolling: false,
        activeProjectId: null,
        terminalMode: "start",
        activeRunId: null,
        activeRunName: "",
        activeRunCommand: "",
        logSeq: 0,
        pollTimer: 0,
        loading: false,
    };

    const el = {
        authPanel: document.getElementById("authPanel"),
        loginForm: document.getElementById("loginForm"),
        loginUsername: document.getElementById("loginUsername"),
        loginPassword: document.getElementById("loginPassword"),
        loginError: document.getElementById("loginError"),
        loginSubmitBtn: document.getElementById("loginSubmitBtn"),
        accessPanel: document.getElementById("accessPanel"),
        pageBody: document.getElementById("pageBody"),
        projectGrid: document.getElementById("projectGrid"),
        projectEmpty: document.getElementById("projectEmpty"),
        projectsWorkspace: document.getElementById("projectsWorkspace"),
        usageSidebar: document.getElementById("usageSidebar"),
        usageCollapseBtn: document.getElementById("usageCollapseBtn"),
        usageRailToggle: document.getElementById("usageRailToggle"),
        usageRailBadge: document.getElementById("usageRailBadge"),
        usageList: document.getElementById("usageList"),
        usageProcessCount: document.getElementById("usageProcessCount"),
        usageCpuTotal: document.getElementById("usageCpuTotal"),
        usageMemoryTotal: document.getElementById("usageMemoryTotal"),
        usageNote: document.getElementById("usageNote"),
        emptyAddProjectBtn: document.getElementById("emptyAddProjectBtn"),
        projectCount: document.getElementById("projectCount"),
        runningCount: document.getElementById("runningCount"),
        refreshBtn: document.getElementById("refreshBtn"),
        toggleAllProjectsBtn: document.getElementById("toggleAllProjectsBtn"),
        addProjectBtn: document.getElementById("addProjectBtn"),
        terminalDrawer: document.getElementById("terminalDrawer"),
        terminalProjectName: document.getElementById("terminalProjectName"),
        terminalStatus: document.getElementById("terminalStatus"),
        terminalPid: document.getElementById("terminalPid"),
        terminalCommand: document.getElementById("terminalCommand"),
        terminalLog: document.getElementById("terminalLog"),
        terminalStopRunBtn: document.getElementById("terminalStopRunBtn"),
        terminalClearBtn: document.getElementById("terminalClearBtn"),
        terminalCloseBtn: document.getElementById("terminalCloseBtn"),
        projectModal: document.getElementById("projectModal"),
        projectForm: document.getElementById("projectForm"),
        projectModalKicker: document.getElementById("projectModalKicker"),
        projectModalTitle: document.getElementById("projectModalTitle"),
        projectPath: document.getElementById("projectPath"),
        projectName: document.getElementById("projectName"),
        projectType: document.getElementById("projectType"),
        projectStartCommand: document.getElementById("projectStartCommand"),
        runCommandRows: document.getElementById("runCommandRows"),
        addRunCommandBtn: document.getElementById("addRunCommandBtn"),
        detectProjectBtn: document.getElementById("detectProjectBtn"),
        projectError: document.getElementById("projectError"),
        closeProjectModalBtn: document.getElementById("closeProjectModalBtn"),
        cancelProjectBtn: document.getElementById("cancelProjectBtn"),
        saveProjectBtn: document.getElementById("saveProjectBtn"),
        toastContainer: document.getElementById("toastContainer"),
        userMenu: document.getElementById("userMenu"),
        userTrigger: document.getElementById("userTrigger"),
        userAvatar: document.getElementById("userAvatar"),
        userName: document.getElementById("userName"),
        userRole: document.getElementById("userRole"),
        popoverStatus: document.getElementById("popoverStatus"),
        popoverLastLogin: document.getElementById("popoverLastLogin"),
        navAccountLink: document.getElementById("navAccountLink"),
        accountManageLink: document.getElementById("accountManageLink"),
        userLoginBtn: document.getElementById("userLoginBtn"),
        logoutBtn: document.getElementById("logoutBtn"),
    };

    const escapeHtml = (value) =>
        String(value ?? "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        }[char]));

    const statusMeta = (status) => STATUS_META[status] || STATUS_META.stopped;
    const runStatusMeta = (status) => RUN_STATUS_META[status] || RUN_STATUS_META.stopped;

    const editorIcon = (editor, size = 15) => {
        if (editor === "vscode") {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#0098FF" aria-hidden="true"><path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"></path></svg>`;
        }
        if (editor === "qoder") {
            return `<img class="editor-icon-image" src="/pages/assets/images/qoder-ide.png" width="${size}" height="${size}" alt="" aria-hidden="true">`;
        }
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="#E4A33D" d="M3.5 5h5.2l2 2H20A1.5 1.5 0 0 1 21.5 8.5v9A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 4 5Z"></path><path fill="#F5C15B" d="M3.5 8h17v9.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5V8Z"></path></svg>`;
    };

    const editorAvailable = (editor) => state.editors[editor] !== false;

    function defaultEditorFor(projectId) {
        const stored = state.defaultEditors.get(Number(projectId));
        if (stored && editorAvailable(stored)) return stored;
        return ["vscode", "qoder", "explorer"].find(editorAvailable) || "vscode";
    }

    function persistDefaultEditors() {
        try {
            localStorage.setItem(
                DEFAULT_EDITORS_KEY,
                JSON.stringify(Object.fromEntries(state.defaultEditors))
            );
        } catch {
            /* localStorage 不可用时只保留当前会话 */
        }
    }

    function setDefaultEditor(projectId, editor) {
        const id = Number(projectId);
        if (!Number.isInteger(id) || !EDITOR_META[editor]) return false;
        if (state.defaultEditors.get(id) === editor) return false;
        state.defaultEditors.set(id, editor);
        persistDefaultEditors();
        return true;
    }

    const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0));

    const formatMemory = (value) => {
        const mb = Number(value);
        if (!Number.isFinite(mb)) return "—";
        return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
    };

    const formatUptime = (value) => {
        if (value === null || value === undefined) return "—";
        const total = Math.max(0, Math.floor(Number(value) || 0));
        if (total < 60) return `${total}s`;
        const minutes = Math.floor(total / 60);
        const hours = Math.floor(minutes / 60);
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        return `${minutes}m ${total % 60}s`;
    };

    function applyUsageCollapsed() {
        const collapsed = Boolean(state.usageCollapsed);
        el.projectsWorkspace?.classList.toggle("is-usage-collapsed", collapsed);
        el.usageSidebar?.classList.toggle("is-collapsed", collapsed);
        el.usageRailToggle?.setAttribute("aria-expanded", String(!collapsed));
        el.usageCollapseBtn?.setAttribute("aria-expanded", String(!collapsed));
    }

    function setUsageCollapsed(collapsed) {
        state.usageCollapsed = Boolean(collapsed);
        try {
            localStorage.setItem(USAGE_COLLAPSED_KEY, state.usageCollapsed ? "1" : "0");
        } catch {
            /* localStorage 不可用时只保留当前会话 */
        }
        applyUsageCollapsed();
        if (!state.usageCollapsed) void loadUsage();
    }

    function updateUsageNote() {
        if (!el.usageNote) return;
        if (state.usageError) {
            el.usageNote.textContent = state.usageError;
            return;
        }
        if (!state.usageAvailable) {
            el.usageNote.textContent = "当前系统无法读取进程占用（PowerShell 或 ps 不可用）。";
            return;
        }
        const date = state.usageSampledAt ? new Date(state.usageSampledAt) : null;
        const time = date && !Number.isNaN(date.getTime())
            ? date.toLocaleTimeString("zh-CN", { hour12: false })
            : "";
        el.usageNote.textContent = `${time ? `最近采样 ${time} · ` : ""}每 2 秒刷新`;
    }

    function renderUsage() {
        const usage = Array.isArray(state.usage) ? state.usage : [];
        const cpuValues = usage
            .map((item) => item.cpuPercent)
            .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
            .map(Number);
        const memoryValues = usage
            .map((item) => item.memoryMb)
            .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
            .map(Number);
        const cpuTotal = cpuValues.reduce((sum, value) => sum + value, 0);
        const memoryTotal = memoryValues.reduce((sum, value) => sum + value, 0);
        const maxMemory = Math.max(1, ...memoryValues);

        if (el.usageProcessCount) el.usageProcessCount.textContent = String(usage.length);
        if (el.usageCpuTotal) el.usageCpuTotal.textContent = cpuValues.length ? `${cpuTotal.toFixed(1)}%` : "—";
        if (el.usageMemoryTotal) el.usageMemoryTotal.textContent = memoryValues.length ? formatMemory(memoryTotal) : "—";
        if (el.usageRailBadge) {
            el.usageRailBadge.textContent = String(usage.length);
            el.usageRailBadge.classList.toggle("hidden", usage.length === 0);
        }

        if (!el.usageList) return;
        if (usage.length === 0) {
            el.usageList.innerHTML = '<div class="usage-empty"><strong>暂无启动中的项目</strong><span>启动项目后，这里会显示进程树占用。</span></div>';
            updateUsageNote();
            return;
        }

        el.usageList.innerHTML = usage.map((item) => {
            const status = statusMeta(item.status);
            const name = escapeHtml(item.name || "未命名项目");
            const cpu = item.cpuPercent === null || item.cpuPercent === undefined
                ? null
                : Number(item.cpuPercent);
            const memory = item.memoryMb === null || item.memoryMb === undefined
                ? null
                : Number(item.memoryMb);
            const cpuBar = cpu === null || !Number.isFinite(cpu) ? 0 : clampPercent(cpu);
            const memoryBar = memory === null || !Number.isFinite(memory)
                ? 0
                : clampPercent((memory / maxMemory) * 100);
            const processCount = Number(item.processCount) || 0;
            const pid = item.pid === null || item.pid === undefined ? "—" : escapeHtml(item.pid);
            const cpuText = cpu !== null && Number.isFinite(cpu) ? `${cpu.toFixed(1)}%` : "—";
            const memoryText = memory !== null && Number.isFinite(memory) ? formatMemory(memory) : "—";
            return `<article class="usage-item">
                <div class="usage-item-head">
                    <span class="usage-item-name" title="${name}">${name}</span>
                    <span class="usage-item-status ${status.className}">${escapeHtml(status.label)}</span>
                </div>
                <div class="usage-metrics">
                    <div class="usage-metric"><span>CPU</span><strong>${cpuText}</strong></div>
                    <div class="usage-metric"><span>内存</span><strong>${memoryText}</strong></div>
                </div>
                <div class="usage-bars" aria-hidden="true">
                    <span class="usage-bar"><i style="width:${cpuBar}%"></i></span>
                    <span class="usage-bar is-memory"><i style="width:${memoryBar}%"></i></span>
                </div>
                <div class="usage-meta">
                    <span>PID ${pid}</span>
                    <span>${processCount} 个进程</span>
                    <span>${formatUptime(item.uptimeSeconds)}</span>
                </div>
            </article>`;
        }).join("");
        updateUsageNote();
    }

    async function loadUsage() {
        if (!state.user || state.usageLoading) return;
        state.usageLoading = true;
        try {
            const json = await api("/projects/usage");
            state.usage = Array.isArray(json.usage) ? json.usage : [];
            state.usageAvailable = json.available !== false;
            state.usageSampledAt = typeof json.sampledAt === "string" ? json.sampledAt : "";
            state.usageError = "";
            renderUsage();
        } catch (error) {
            if (error.status === 401) {
                state.user = null;
                stopUsagePolling();
                renderUserUi();
                showAuthPanel();
            } else if (error.status === 403) {
                stopUsagePolling();
                showAccessPanel();
            } else {
                state.usageAvailable = false;
                state.usageError = error.message || "进程占用读取失败";
                renderUsage();
            }
        } finally {
            state.usageLoading = false;
        }
    }

    function stopUsagePolling() {
        state.usagePolling = false;
        if (state.usageTimer) {
            window.clearTimeout(state.usageTimer);
            state.usageTimer = 0;
        }
    }

    function startUsagePolling() {
        stopUsagePolling();
        state.usagePolling = true;
        const tick = async () => {
            if (!state.usagePolling) return;
            if (!state.user) {
                state.usagePolling = false;
                return;
            }
            if (document.visibilityState !== "hidden") await loadUsage();
            if (!state.usagePolling) return;
            state.usageTimer = window.setTimeout(tick, 2000);
        };
        state.usageTimer = window.setTimeout(tick, 200);
    }

    function showToast(message, type = "success") {
        if (!el.toastContainer) return;
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span class="toast-icon">${type === "error" ? "!" : "✓"}</span><span>${escapeHtml(message)}</span>`;
        el.toastContainer.appendChild(toast);
        window.setTimeout(() => {
            toast.classList.add("is-leaving");
            window.setTimeout(() => toast.remove(), 220);
        }, 2800);
    }

    function humanizeAuthMessage(message) {
        const map = {
            "account pending approval; please wait for an administrator to review it": "账号正在等待管理员审核，暂时无法登录",
            "account is disabled": "账号已被禁用，请联系管理员",
        };
        return map[message] || message;
    }

    async function api(path, options = {}) {
        const response = await Auth.apiFetch(path, options);
        const json = await Auth.parseJson(response);
        if (!response.ok || json.res === false) {
            const error = new Error(json.message || `请求失败（${response.status}）`);
            error.status = response.status;
            throw error;
        }
        return json;
    }

    function showLoginError(message) {
        el.loginError.textContent = message;
        el.loginError.classList.remove("hidden");
    }

    function clearLoginError() {
        el.loginError.textContent = "";
        el.loginError.classList.add("hidden");
    }

    function showAuthPanel() {
        el.authPanel.classList.remove("hidden");
        el.accessPanel.classList.add("hidden");
        el.pageBody.classList.add("hidden");
        stopStatusPolling();
        closeTerminal();
        window.setTimeout(() => el.loginUsername.focus(), 40);
    }

    function showAccessPanel() {
        el.authPanel.classList.add("hidden");
        el.accessPanel.classList.remove("hidden");
        el.pageBody.classList.add("hidden");
        stopStatusPolling();
        closeTerminal();
    }

    function showPage() {
        el.authPanel.classList.add("hidden");
        el.accessPanel.classList.add("hidden");
        el.pageBody.classList.remove("hidden");
    }

    function renderUserUi() {
        const user = state.user;
        if (!user) {
            el.userName.textContent = "未登录";
            el.userRole.textContent = "请先登录";
            el.userAvatar.textContent = "?";
            el.popoverStatus.textContent = "—";
            el.popoverLastLogin.textContent = "—";
            el.navAccountLink.classList.add("hidden");
            el.accountManageLink.classList.add("hidden");
            el.userLoginBtn.classList.remove("hidden");
            el.logoutBtn.classList.add("hidden");
            return;
        }
        el.userName.textContent = user.username || "—";
        el.userRole.textContent = Auth.roleLabel(user.role);
        el.userAvatar.textContent = String(user.username || "?").slice(0, 1).toUpperCase();
        el.popoverStatus.textContent = Auth.statusLabel(user.status);
        el.popoverLastLogin.textContent = user.lastLoginAt || "—";
        el.navAccountLink.classList.toggle("hidden", user.role !== "admin");
        el.accountManageLink.classList.toggle("hidden", user.role !== "admin");
        el.userLoginBtn.classList.add("hidden");
        el.logoutBtn.classList.remove("hidden");
    }

    function bindUserMenu() {
        el.userTrigger.addEventListener("click", (event) => {
            event.stopPropagation();
            if (!state.user) {
                showAuthPanel();
                return;
            }
            const open = el.userMenu.classList.toggle("is-open");
            el.userTrigger.setAttribute("aria-expanded", open ? "true" : "false");
        });
        document.addEventListener("click", (event) => {
            if (el.userMenu.contains(event.target)) return;
            el.userMenu.classList.remove("is-open");
            el.userTrigger.setAttribute("aria-expanded", "false");
        });
        el.userLoginBtn.addEventListener("click", () => showAuthPanel());
        el.logoutBtn.addEventListener("click", () => {
            Auth.clearSession();
            window.location.reload();
        });
    }

    function projectById(id) {
        return state.projects.find((project) => Number(project.id) === Number(id)) || null;
    }

    function projectCardHtml(project) {
        const projectId = Number(project.id);
        const status = statusMeta(project.status);
        const busy = ACTIVE_STATUSES.includes(project.status);
        const canStart = !busy;
        const canStop = busy && project.status !== "stopping";
        const canRestart = project.status === "running";
        const canEdit = !busy;
        const canDelete = !busy;
        const name = escapeHtml(project.name || "未命名项目");
        const projectPath = escapeHtml(project.path || "—");
        const startCommand = String(project.startCommand || project.command || "").trim();
        const runCommands = Array.isArray(project.runCommands) ? project.runCommands : [];
        const typeLabel = TYPE_LABELS[project.type] || project.typeLabel || project.type || "自定义";
        const pid = project.pid ? `PID ${escapeHtml(project.pid)}` : "";
        const expanded = state.expandedProjects.has(projectId);
        const storedCommandId = String(state.selectedCommands.get(projectId) || "");
        const selectedCommand = runCommands.find((item) => String(item.id) === storedCommandId) || runCommands[0];
        const selectedCommandId = selectedCommand ? String(selectedCommand.id) : "";
        const defaultEditor = defaultEditorFor(projectId);
        const defaultEditorAvailable = editorAvailable(defaultEditor);
        const defaultEditorLabel = EDITOR_META[defaultEditor].label;
        const defaultEditorTitle = defaultEditorAvailable
            ? defaultEditor === "explorer"
                ? "在文件管理器中打开"
                : `用 ${defaultEditorLabel} 打开`
            : `未检测到 ${defaultEditorLabel}`;
        const defaultBadge = (editor) => editor === defaultEditor
            ? '<span class="project-open-default">（默认）</span>'
            : "";
        const editorTitle = (available, label) => available ? `用 ${label} 打开` : `未检测到 ${label} 命令行工具`;
        const commandOptions = runCommands.length
            ? runCommands.map((item) => {
                const commandId = String(item.id);
                const label = `${item.name || "命令"} — ${item.command || ""}`;
                return `<option value="${escapeHtml(commandId)}"${commandId === selectedCommandId ? " selected" : ""}>${escapeHtml(label)}</option>`;
            }).join("")
            : '<option value="">暂无运行命令</option>';
        const runCommandHtml = runCommands.length
            ? `<div class="run-command-list">${runCommands.map((item) => {
                const commandName = escapeHtml(item.name || item.command || "命令");
                const commandText = escapeHtml(item.command || "");
                return `<div class="run-command-row">
                    <span class="run-command-name" title="${commandName}">${commandName}</span>
                    <code class="run-command-code" title="${commandText}">${commandText}</code>
                    <button class="btn btn-sm" type="button" data-action="run-command" data-command-id="${Number(item.id)}" title="运行 ${commandName}">运行</button>
                </div>`;
            }).join("")}</div>`
            : '<p class="run-command-empty">暂无运行命令，编辑项目添加</p>';

        return `<article class="project-card${busy ? " is-running" : ""}${project.status === "error" ? " is-error" : ""}${expanded ? " is-expanded" : ""}" data-project-id="${projectId}">
            <div class="project-card-head">
                <div class="project-title-wrap">
                    <h3 class="project-title" title="${name}">${name}</h3>
                    <div class="project-subline">
                        <span class="project-type"><span class="type-dot"></span>${escapeHtml(typeLabel)}</span>
                        <span class="project-path-inline" title="${projectPath}">${projectPath}</span>
                    </div>
                </div>
                <div class="project-head-right">
                    <div class="project-head-topline">
                        <span class="status-pill ${status.className}" title="${escapeHtml(status.label)}">${escapeHtml(status.label)}</span>
                        <button class="project-console-btn" type="button" data-action="terminal" title="打开控制台" aria-label="打开控制台">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6"></path><path d="M12 19h8"></path></svg>
                        </button>
                        <div class="project-open-menu">
                            <div class="project-open-split">
                                <button class="project-open-main is-${defaultEditor}" type="button" data-action="editor" data-editor="${defaultEditor}" title="${escapeHtml(defaultEditorTitle)}" aria-label="${escapeHtml(defaultEditorTitle)}"${defaultEditorAvailable ? "" : " disabled"}>
                                    ${editorIcon(defaultEditor)}
                                </button>
                                <button class="project-open-caret" type="button" data-action="toggle-open-menu" title="选择打开方式" aria-label="选择打开方式" aria-haspopup="menu" aria-expanded="false">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                                </button>
                            </div>
                            <div class="project-open-dropdown hidden" role="menu">
                                <button class="project-open-option" type="button" role="menuitem" data-action="editor" data-editor="explorer" title="在文件管理器中打开">
                                    ${editorIcon("explorer")}
                                    <span>文件资源管理器${defaultBadge("explorer")}</span>
                                </button>
                                <button class="project-open-option" type="button" role="menuitem" data-action="editor" data-editor="vscode" title="${escapeHtml(editorTitle(state.editors.vscode, "VS Code"))}"${state.editors.vscode ? "" : " disabled"}>
                                    ${editorIcon("vscode")}
                                    <span>VS Code${defaultBadge("vscode")}</span>
                                </button>
                                <button class="project-open-option" type="button" role="menuitem" data-action="editor" data-editor="qoder" title="${escapeHtml(editorTitle(state.editors.qoder, "Qoder IDE"))}"${state.editors.qoder ? "" : " disabled"}>
                                    ${editorIcon("qoder")}
                                    <span>Qoder IDE${defaultBadge("qoder")}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    ${pid ? `<span class="project-pid">${pid}</span>` : ""}
                </div>
            </div>

            <div class="project-quick-row">
                <div class="project-quick-actions">
                    <button class="btn btn-sm btn-primary" type="button" data-action="start"${canStart ? "" : " disabled"}>启动</button>
                    <button class="btn btn-sm" type="button" data-action="restart"${canRestart ? "" : " disabled"}>重启</button>
                    <button class="btn btn-sm btn-danger" type="button" data-action="stop"${canStop ? "" : " disabled"}>停止</button>
                </div>
                <div class="project-quick-run">
                    <select class="project-command-select" data-command-select aria-label="选择运行命令"${runCommands.length ? "" : " disabled"}>${commandOptions}</select>
                    <button class="btn btn-sm" type="button" data-action="run-selected"${runCommands.length ? "" : " disabled"}>运行</button>
                </div>
                <button class="btn project-detail-toggle" type="button" data-action="toggle-details" aria-expanded="${expanded ? "true" : "false"}">${expanded ? "收起" : "详情"}</button>
            </div>

            <div class="project-details${expanded ? "" : " hidden"}">
                <div class="project-detail-grid">
                    <div class="project-detail-item">
                        <span class="project-detail-label">启动命令</span>
                        <code class="project-start-command${startCommand ? "" : " is-empty"}" title="${escapeHtml(startCommand || "未配置启动命令")}">${startCommand ? escapeHtml(startCommand) : "未配置启动命令"}</code>
                    </div>
                    <div class="project-detail-item">
                        <span class="project-detail-label">进程</span>
                        <span class="project-detail-value">${pid || "未运行"}</span>
                    </div>
                </div>
                <div class="project-detail-section">
                    <div class="project-detail-section-head"><strong>运行命令</strong><span>${runCommands.length} 条</span></div>
                    ${runCommandHtml}
                </div>
                <div class="project-detail-actions">
                    <button class="btn btn-sm" type="button" data-action="terminal">启动终端</button>
                    <button class="btn btn-sm" type="button" data-action="edit"${canEdit ? "" : " disabled"}>编辑</button>
                    <button class="btn btn-sm btn-danger" type="button" data-action="delete"${canDelete ? "" : " disabled"}>删除</button>
                </div>
            </div>
        </article>`;
    }

    function updateCollapseButton() {
        if (!el.toggleAllProjectsBtn) return;
        const hasExpanded = state.expandedProjects.size > 0;
        el.toggleAllProjectsBtn.textContent = hasExpanded ? "全部收起" : "全部展开";
        el.toggleAllProjectsBtn.disabled = state.projects.length === 0;
    }

    function closeOpenMenus() {
        document.querySelectorAll(".project-open-menu.is-open").forEach((menu) => {
            menu.classList.remove("is-open");
            menu.querySelector(".project-open-caret")?.setAttribute("aria-expanded", "false");
            menu.querySelector(".project-open-dropdown")?.classList.add("hidden");
        });
    }

    function toggleOpenMenu(menu) {
        const wasOpen = menu.classList.contains("is-open");
        closeOpenMenus();
        if (wasOpen) return;
        menu.classList.add("is-open");
        menu.querySelector(".project-open-caret")?.setAttribute("aria-expanded", "true");
        menu.querySelector(".project-open-dropdown")?.classList.remove("hidden");
    }

    function renderProjects() {
        const count = state.projects.length;
        const running = state.projects.filter((project) => ACTIVE_STATUSES.includes(project.status)).length;
        const currentIds = new Set(state.projects.map((project) => Number(project.id)));
        for (const id of state.expandedProjects) {
            if (!currentIds.has(id)) state.expandedProjects.delete(id);
        }
        for (const id of state.selectedCommands.keys()) {
            if (!currentIds.has(id)) state.selectedCommands.delete(id);
        }
        el.projectCount.textContent = String(count);
        el.runningCount.textContent = String(running);
        el.projectEmpty.classList.toggle("hidden", count > 0);
        el.projectGrid.innerHTML = state.projects.map(projectCardHtml).join("");
        updateCollapseButton();

        if (state.activeProjectId && projectById(state.activeProjectId)) {
            const project = projectById(state.activeProjectId);
            if (state.terminalMode === "start") {
                updateTerminalStatus(project.status, project.pid);
            }
        }
        syncStatusPolling();
    }

    function stopStatusPolling() {
        state.statusPolling = false;
        if (state.statusPollTimer) {
            window.clearTimeout(state.statusPollTimer);
            state.statusPollTimer = 0;
        }
    }

    function syncStatusPolling() {
        const pending = state.projects.some(
            (project) => project.status === "starting" || project.status === "stopping"
        );
        if (!pending || !state.user) {
            stopStatusPolling();
            return;
        }
        if (state.statusPolling) return;
        state.statusPolling = true;
        const tick = async () => {
            state.statusPollTimer = 0;
            if (!state.statusPolling) return;
            await loadProjects();
            if (!state.statusPolling) return;
            const stillPending = state.projects.some(
                (project) => project.status === "starting" || project.status === "stopping"
            );
            if (!stillPending) {
                stopStatusPolling();
                return;
            }
            state.statusPollTimer = window.setTimeout(tick, 1000);
        };
        state.statusPollTimer = window.setTimeout(tick, 700);
    }

    function updateTerminalStatus(status, pid, mode = state.terminalMode) {
        const meta = mode === "run" ? runStatusMeta(status) : statusMeta(status);
        el.terminalStatus.className = `status-pill ${meta.className}`;
        el.terminalStatus.textContent = meta.label;
        el.terminalPid.textContent = pid ? `PID ${pid}` : "";
        const showStop = mode === "run" && (status === "running" || status === "stopping");
        el.terminalStopRunBtn.classList.toggle("hidden", !showStop);
        el.terminalStopRunBtn.textContent = status === "stopping" ? "停止中…" : "停止命令";
        el.terminalStopRunBtn.disabled = status === "stopping";
    }

    function stopPolling() {
        if (state.pollTimer) {
            window.clearTimeout(state.pollTimer);
            state.pollTimer = 0;
        }
    }

    function schedulePoll(projectId, delay) {
        stopPolling();
        state.pollTimer = window.setTimeout(() => {
            if (state.activeProjectId === projectId) void loadLogs(false);
        }, delay);
    }

    function appendLogs(logs, reset) {
        if (reset) {
            el.terminalLog.innerHTML = "";
            state.logSeq = 0;
        }
        const entries = Array.isArray(logs) ? logs : [];
        const placeholder = el.terminalLog.querySelector(".terminal-placeholder");
        if (entries.length === 0) {
            if (reset && !placeholder) {
                el.terminalLog.innerHTML = '<span class="terminal-placeholder">暂无输出，启动项目后会显示终端内容</span>';
            }
            return;
        }
        if (placeholder) placeholder.remove();
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
            const line = document.createElement("div");
            line.className = `terminal-entry is-${entry.stream || "stdout"}`;
            const time = document.createElement("span");
            time.className = "terminal-time";
            time.textContent = entry.at || "";
            const text = document.createElement("span");
            text.textContent = entry.text || "";
            line.append(time, text);
            fragment.append(line);
            state.logSeq = Math.max(state.logSeq, Number(entry.seq) || 0);
        }
        el.terminalLog.append(fragment);
        el.terminalLog.scrollTop = el.terminalLog.scrollHeight;
    }

    async function loadLogs(reset) {
        const projectId = state.activeProjectId;
        const mode = state.terminalMode;
        const runId = state.activeRunId;
        if (!projectId || (mode === "run" && !runId)) return;
        stopPolling();
        const after = reset ? 0 : state.logSeq;
        const endpoint = mode === "run"
            ? `/projects/${projectId}/runs/${runId}/logs?after=${after}`
            : `/projects/${projectId}/logs?after=${after}`;
        try {
            const json = await api(endpoint);
            if (
                state.activeProjectId !== projectId ||
                state.terminalMode !== mode ||
                (mode === "run" && state.activeRunId !== runId)
            ) {
                return;
            }
            appendLogs(json.logs, reset);
            state.logSeq = Number(json.nextSeq) || state.logSeq;

            if (mode === "run") {
                updateTerminalStatus(json.status, json.pid, "run");
                if (json.status === "running" || json.status === "stopping") {
                    schedulePoll(projectId, 800);
                }
                return;
            }

            updateTerminalStatus(json.status, json.pid, "start");
            const project = projectById(projectId);
            if (project && (project.status !== json.status || project.pid !== json.pid)) {
                project.status = json.status;
                project.pid = json.pid;
                renderProjects();
            }
            const active = json.status === "starting" || json.status === "running" || json.status === "stopping";
            schedulePoll(projectId, active ? 800 : 1600);
        } catch (error) {
            if (error.status === 401) {
                state.user = null;
                renderUserUi();
                showAuthPanel();
                return;
            }
            if (error.status === 403) {
                showAccessPanel();
                return;
            }
            if (mode === "run" && error.status === 404) {
                showToast("运行记录已失效", "warning");
                closeTerminal();
                return;
            }
            schedulePoll(projectId, 2200);
        }
    }

    function openTerminal(projectId) {
        const project = projectById(projectId);
        if (!project) return;
        const switched = state.activeProjectId !== Number(projectId) || state.terminalMode !== "start";
        state.activeProjectId = Number(projectId);
        state.terminalMode = "start";
        state.activeRunId = null;
        state.activeRunName = "";
        state.activeRunCommand = "";
        if (switched) {
            state.logSeq = 0;
            el.terminalLog.innerHTML = '<span class="terminal-placeholder">正在读取启动进程输出…</span>';
        }
        el.terminalProjectName.textContent = `${project.name || "未命名项目"} · 启动进程`;
        el.terminalCommand.textContent = project.startCommand || project.command || "未配置启动命令";
        updateTerminalStatus(project.status, project.pid, "start");
        el.terminalDrawer.classList.remove("hidden");
        el.terminalDrawer.setAttribute("aria-hidden", "false");
        el.terminalDrawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
        void loadLogs(switched);
    }

    async function runProjectCommand(projectId, commandId) {
        const project = projectById(projectId);
        if (!project) return;
        const command = (Array.isArray(project.runCommands) ? project.runCommands : [])
            .find((item) => Number(item.id) === Number(commandId));
        if (!command) {
            showToast("运行命令不存在，请刷新项目", "warning");
            return;
        }
        try {
            const json = await api(`/projects/${projectId}/commands/${commandId}/run`, {
                method: "POST",
            });
            const run = json.run;
            state.activeProjectId = Number(projectId);
            state.terminalMode = "run";
            state.activeRunId = Number(run.id);
            state.activeRunName = run.name || command.name || "运行命令";
            state.activeRunCommand = run.command || command.command || "";
            state.logSeq = 0;
            el.terminalLog.innerHTML = '<span class="terminal-placeholder">正在读取命令输出…</span>';
            el.terminalProjectName.textContent = `${project.name || "未命名项目"} · ${state.activeRunName}`;
            el.terminalCommand.textContent = state.activeRunCommand;
            updateTerminalStatus(run.status || "running", run.pid, "run");
            el.terminalDrawer.classList.remove("hidden");
            el.terminalDrawer.setAttribute("aria-hidden", "false");
            el.terminalDrawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
            showToast(`正在运行：${state.activeRunName}`);
            void loadLogs(true);
        } catch (error) {
            handleActionError(error, "运行命令失败");
        }
    }

    async function stopActiveRun() {
        if (state.terminalMode !== "run" || !state.activeRunId || !state.activeProjectId) return;
        const projectId = state.activeProjectId;
        const runId = state.activeRunId;
        el.terminalStopRunBtn.disabled = true;
        try {
            await api(`/projects/${projectId}/runs/${runId}/stop`, { method: "POST" });
            showToast("正在停止运行命令");
            if (state.activeProjectId === projectId && state.activeRunId === runId) {
                void loadLogs(false);
            }
        } catch (error) {
            handleActionError(error, "停止运行命令失败");
        } finally {
            if (state.activeRunId === runId) el.terminalStopRunBtn.disabled = false;
        }
    }

    function closeTerminal() {
        stopPolling();
        state.activeProjectId = null;
        state.terminalMode = "start";
        state.activeRunId = null;
        state.activeRunName = "";
        state.activeRunCommand = "";
        state.logSeq = 0;
        el.terminalDrawer.classList.add("hidden");
        el.terminalDrawer.setAttribute("aria-hidden", "true");
        el.terminalStopRunBtn.classList.add("hidden");
    }

    async function startProject(projectId) {
        try {
            await api(`/projects/${projectId}/start`, { method: "POST" });
            openTerminal(projectId);
            showToast("项目已启动，正在读取终端输出");
            await loadProjects();
            void loadUsage();
        } catch (error) {
            handleActionError(error, "启动项目失败");
        }
    }

    async function stopProject(projectId) {
        try {
            await api(`/projects/${projectId}/stop`, { method: "POST" });
            showToast("正在停止项目");
            await loadProjects();
            void loadUsage();
            if (state.activeProjectId === Number(projectId) && state.terminalMode === "start") {
                void loadLogs(false);
            }
        } catch (error) {
            handleActionError(error, "停止项目失败");
        }
    }

    async function restartProject(projectId) {
        try {
            showToast("正在重启项目");
            await api(`/projects/${projectId}/restart`, { method: "POST" });
            openTerminal(projectId);
            showToast("项目已重启，正在读取终端输出");
            await loadProjects();
            void loadUsage();
        } catch (error) {
            handleActionError(error, "重启项目失败");
        }
    }

    async function openEditor(projectId, editor) {
        try {
            const json = await api(`/projects/${projectId}/open-editor`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ editor }),
            });
            showToast(json.message || "已打开编辑器");
        } catch (error) {
            handleActionError(error, "打开编辑器失败");
        }
    }

    async function deleteProject(projectId) {
        const project = projectById(projectId);
        if (!project) return;
        if (ACTIVE_STATUSES.includes(project.status)) {
            showToast("请先停止项目再删除", "warning");
            return;
        }
        if (!window.confirm(`确定删除项目「${project.name}」吗？`)) return;
        try {
            await api(`/projects/${projectId}`, { method: "DELETE" });
            state.expandedProjects.delete(Number(projectId));
            state.selectedCommands.delete(Number(projectId));
            state.defaultEditors.delete(Number(projectId));
            persistDefaultEditors();
            if (state.activeProjectId === Number(projectId)) closeTerminal();
            showToast("项目已删除");
            await loadProjects();
        } catch (error) {
            handleActionError(error, "删除项目失败");
        }
    }

    function addRunCommandRow(command = {}) {
        const row = document.createElement("div");
        row.className = "run-command-editor-row";
        row.dataset.runCommandRow = "1";

        const name = document.createElement("input");
        name.className = "text-input";
        name.type = "text";
        name.placeholder = "名称，例如 构建";
        name.dataset.runName = "1";
        name.value = command.name || "";

        const commandInput = document.createElement("input");
        commandInput.className = "text-input";
        commandInput.type = "text";
        commandInput.placeholder = "命令，例如 npm run build";
        commandInput.dataset.runCommand = "1";
        commandInput.value = command.command || "";

        const remove = document.createElement("button");
        remove.className = "icon-btn";
        remove.type = "button";
        remove.title = "移除这条运行命令";
        remove.setAttribute("aria-label", "移除运行命令");
        remove.dataset.removeRunCommand = "1";
        remove.textContent = "✕";

        row.append(name, commandInput, remove);
        el.runCommandRows.append(row);
    }

    function renderRunCommandRows(commands = []) {
        el.runCommandRows.innerHTML = "";
        if (Array.isArray(commands) && commands.length > 0) {
            commands.forEach((command) => addRunCommandRow(command));
        } else {
            addRunCommandRow();
        }
    }

    function collectRunCommands() {
        return Array.from(el.runCommandRows.querySelectorAll("[data-run-command-row]"))
            .map((row) => ({
                name: String(row.querySelector("[data-run-name]")?.value || "").trim(),
                command: String(row.querySelector("[data-run-command]")?.value || "").trim(),
            }))
            .filter((item) => item.command);
    }

    function fillSuggestedCommands(suggestions) {
        if (!Array.isArray(suggestions) || suggestions.length === 0) return 0;
        const existing = collectRunCommands();
        if (existing.length === 0) {
            renderRunCommandRows(suggestions);
            return suggestions.length;
        }
        const existingCommands = new Set(existing.map((item) => item.command));
        let added = 0;
        for (const suggestion of suggestions) {
            const command = String(suggestion.command || "").trim();
            if (!command || existingCommands.has(command)) continue;
            addRunCommandRow({ name: suggestion.name || command, command });
            existingCommands.add(command);
            added += 1;
        }
        return added;
    }

    function openProjectModal(project = null) {
        state.editingId = project ? Number(project.id) : null;
        el.projectModalKicker.textContent = project ? "Edit Project" : "New Project";
        el.projectModalTitle.textContent = project ? "编辑项目" : "添加项目";
        el.saveProjectBtn.textContent = project ? "保存修改" : "添加项目";
        el.projectPath.value = project?.path || "";
        el.projectName.value = project?.name || "";
        el.projectType.value = project?.type || "auto";
        el.projectStartCommand.value = project?.startCommand || project?.command || "";
        renderRunCommandRows(project?.runCommands || []);
        el.projectError.textContent = "";
        el.projectError.classList.add("hidden");
        el.projectModal.classList.add("is-open");
        el.projectModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        window.setTimeout(() => el.projectPath.focus(), 40);
    }

    function closeProjectModal() {
        el.projectModal.classList.remove("is-open");
        el.projectModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        state.editingId = null;
    }

    async function detectProject() {
        const projectPath = el.projectPath.value.trim();
        if (!projectPath) {
            showToast("请先填写项目地址", "warning");
            el.projectPath.focus();
            return;
        }
        el.detectProjectBtn.disabled = true;
        el.detectProjectBtn.textContent = "识别中…";
        try {
            const json = await api("/projects/detect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: projectPath, type: el.projectType.value }),
            });
            const detection = json.detection || {};
            el.projectPath.value = detection.path || projectPath;
            el.projectType.value = detection.type || "custom";
            if (!el.projectName.value.trim()) el.projectName.value = detection.name || "";
            const startCommand = detection.startCommand || detection.command || "";
            el.projectStartCommand.value = startCommand;
            const suggested = fillSuggestedCommands(detection.commands || []);
            const commandText = startCommand ? `，启动命令：${startCommand}` : "，请手动填写启动命令";
            const suggestedText = suggested > 0 ? `，补充 ${suggested} 条运行命令` : "";
            showToast(`已识别为 ${detection.typeLabel || "自定义项目"}${commandText}${suggestedText}`);
        } catch (error) {
            handleActionError(error, "项目识别失败", true);
        } finally {
            el.detectProjectBtn.disabled = false;
            el.detectProjectBtn.textContent = "识别";
        }
    }

    async function saveProject(event) {
        event.preventDefault();
        const projectPath = el.projectPath.value.trim();
        const name = el.projectName.value.trim();
        const startCommand = el.projectStartCommand.value.trim();
        const commands = collectRunCommands();
        if (!projectPath) {
            el.projectError.textContent = "请输入项目地址";
            el.projectError.classList.remove("hidden");
            return;
        }
        el.projectError.classList.add("hidden");
        el.saveProjectBtn.disabled = true;
        const previousText = el.saveProjectBtn.textContent;
        el.saveProjectBtn.textContent = "保存中…";
        const payload = {
            path: projectPath,
            name,
            type: el.projectType.value,
            startCommand,
            commands,
        };
        try {
            if (state.editingId) {
                await api(`/projects/${state.editingId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                showToast("项目已更新");
            } else {
                await api("/projects", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                showToast("项目已添加");
            }
            closeProjectModal();
            await loadProjects();
        } catch (error) {
            el.projectError.textContent = error.message || "保存项目失败";
            el.projectError.classList.remove("hidden");
        } finally {
            el.saveProjectBtn.disabled = false;
            el.saveProjectBtn.textContent = previousText;
        }
    }

    function handleActionError(error, fallback, showInline = false) {
        if (error.status === 401) {
            state.user = null;
            renderUserUi();
            showAuthPanel();
            return;
        }
        if (error.status === 403) {
            showAccessPanel();
            return;
        }
        if (showInline) {
            el.projectError.textContent = error.message || fallback;
            el.projectError.classList.remove("hidden");
            return;
        }
        showToast(error.message || fallback, "error");
    }

    async function loadProjects() {
        if (state.loading) return;
        state.loading = true;
        try {
            const json = await api("/projects");
            state.projects = Array.isArray(json.projects) ? json.projects : [];
            renderProjects();
        } catch (error) {
            if (error.status === 401) {
                state.user = null;
                renderUserUi();
                showAuthPanel();
            } else if (error.status === 403) {
                showAccessPanel();
            } else {
                showToast(error.message || "加载项目失败", "error");
            }
        } finally {
            state.loading = false;
        }
    }

    async function loadEditors() {
        try {
            const json = await api("/projects/editors");
            if (json.editors && typeof json.editors === "object") {
                state.editors = {
                    vscode: json.editors.vscode !== false,
                    qoder: json.editors.qoder !== false,
                    explorer: json.editors.explorer !== false,
                };
                if (state.projects.length > 0) renderProjects();
            }
        } catch {
            /* 编辑器检测失败时保留默认可用状态，点击时仍会给出后端错误 */
        }
    }

    function bindEvents() {
        el.loginForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            clearLoginError();
            el.loginSubmitBtn.disabled = true;
            try {
                await Auth.login(el.loginUsername.value.trim(), el.loginPassword.value);
                window.location.reload();
            } catch (error) {
                showLoginError(humanizeAuthMessage(error.message) || "登录失败");
            } finally {
                el.loginSubmitBtn.disabled = false;
            }
        });

        el.refreshBtn.addEventListener("click", () => void loadProjects());
        el.usageCollapseBtn?.addEventListener("click", () => setUsageCollapsed(true));
        el.usageRailToggle?.addEventListener("click", () => setUsageCollapsed(false));
        document.addEventListener("visibilitychange", () => {
            if (state.user && document.visibilityState === "visible") void loadUsage();
        });
        el.addProjectBtn.addEventListener("click", () => openProjectModal());
        el.emptyAddProjectBtn.addEventListener("click", () => openProjectModal());
        el.closeProjectModalBtn.addEventListener("click", closeProjectModal);
        el.cancelProjectBtn.addEventListener("click", closeProjectModal);
        el.detectProjectBtn.addEventListener("click", () => void detectProject());
        el.projectForm.addEventListener("submit", saveProject);

        el.projectPath.addEventListener("change", () => {
            if (el.projectName.value.trim()) return;
            const value = el.projectPath.value.trim().replace(/[\\/]+$/, "");
            const base = value.split(/[\\/]/).pop();
            if (base) el.projectName.value = base;
        });

        el.projectModal.addEventListener("click", (event) => {
            if (event.target === el.projectModal) closeProjectModal();
        });

        el.toggleAllProjectsBtn.addEventListener("click", () => {
            const collapseAll = state.expandedProjects.size > 0;
            state.expandedProjects.clear();
            if (!collapseAll) {
                state.projects.forEach((project) => state.expandedProjects.add(Number(project.id)));
            }
            renderProjects();
        });

        el.projectGrid.addEventListener("change", (event) => {
            const select = event.target.closest("[data-command-select]");
            if (!select) return;
            const card = select.closest("[data-project-id]");
            const projectId = Number(card?.dataset.projectId);
            if (Number.isInteger(projectId)) {
                state.selectedCommands.set(projectId, select.value);
            }
        });

        el.projectGrid.addEventListener("click", (event) => {
            const button = event.target.closest("[data-action]");
            if (!button) return;
            const card = button.closest("[data-project-id]");
            const projectId = Number(card?.dataset.projectId);
            if (!Number.isInteger(projectId)) return;
            const action = button.dataset.action;
            if (action === "start") void startProject(projectId);
            else if (action === "restart") void restartProject(projectId);
            else if (action === "stop") void stopProject(projectId);
            else if (action === "terminal") openTerminal(projectId);
            else if (action === "toggle-open-menu") {
                const menu = button.closest(".project-open-menu");
                if (menu) toggleOpenMenu(menu);
            } else if (action === "toggle-details") {
                const expanded = state.expandedProjects.has(projectId);
                if (expanded) state.expandedProjects.delete(projectId);
                else state.expandedProjects.add(projectId);
                const nextExpanded = !expanded;
                const details = card.querySelector(".project-details");
                details?.classList.toggle("hidden", !nextExpanded);
                button.textContent = nextExpanded ? "收起" : "详情";
                button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
                card.classList.toggle("is-expanded", nextExpanded);
                updateCollapseButton();
            } else if (action === "run-selected") {
                const select = card.querySelector("[data-command-select]");
                const commandId = Number(select?.value);
                if (!commandId) {
                    showToast("请选择运行命令", "warning");
                    return;
                }
                void runProjectCommand(projectId, commandId);
            } else if (action === "run-command") {
                void runProjectCommand(projectId, Number(button.dataset.commandId));
            } else if (action === "edit") {
                const project = projectById(projectId);
                if (!project) return;
                if (ACTIVE_STATUSES.includes(project.status)) {
                    showToast("请先停止项目再编辑", "warning");
                    return;
                }
                openProjectModal(project);
            } else if (action === "delete") void deleteProject(projectId);
            else if (action === "editor") {
                const editor = button.dataset.editor;
                if (!editor) return;
                const fromDropdown = Boolean(button.closest(".project-open-dropdown"));
                closeOpenMenus();
                if (fromDropdown && setDefaultEditor(projectId, editor)) {
                    renderProjects();
                }
                void openEditor(projectId, editor);
            }
        });

        el.addRunCommandBtn.addEventListener("click", () => addRunCommandRow());
        el.runCommandRows.addEventListener("click", (event) => {
            const button = event.target.closest("[data-remove-run-command]");
            if (!button) return;
            button.closest("[data-run-command-row]")?.remove();
        });

        el.terminalStopRunBtn.addEventListener("click", () => void stopActiveRun());
        el.terminalClearBtn.addEventListener("click", () => {
            el.terminalLog.innerHTML = '<span class="terminal-placeholder">已清空当前显示，等待新的终端输出…</span>';
        });
        el.terminalCloseBtn.addEventListener("click", closeTerminal);

        document.addEventListener("click", (event) => {
            if (event.target.closest(".project-open-menu")) return;
            closeOpenMenus();
        });

        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            if (document.querySelector(".project-open-menu.is-open")) {
                closeOpenMenus();
            } else if (el.projectModal.classList.contains("is-open")) {
                closeProjectModal();
            } else if (!el.terminalDrawer.classList.contains("hidden")) {
                closeTerminal();
            }
        });
        window.addEventListener("beforeunload", () => {
            stopPolling();
            stopUsagePolling();
            stopStatusPolling();
        });
    }

    async function bootstrap() {
        bindEvents();
        bindUserMenu();
        applyUsageCollapsed();
        state.user = await Auth.loadCurrentUser();
        renderUserUi();
        if (!state.user) {
            showAuthPanel();
            return;
        }
        if (!Auth.hasRole(state.user.role, "readwrite")) {
            showAccessPanel();
            return;
        }
        showPage();
        await loadEditors();
        await loadProjects();
        startUsagePolling();
    }

    bootstrap();
})();
