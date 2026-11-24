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
        powershell: { label: "PowerShell" },
        cmd: { label: "CMD" },
    };
    const DEFAULT_EDITORS_KEY = "gitstatus_project_default_editors";
    const FOLDER_DEFAULT_EDITORS_KEY = "gitstatus_project_folder_default_editors";
    const USAGE_COLLAPSED_KEY = "gitstatus_projects_usage_collapsed";
    const FOLDER_COLLAPSED_KEY = "gitstatus_project_folders_collapsed";
    const ONE_SHOT_KEY = "gitstatus_projects_oneshot_ids";

    const readOneShotIds = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(ONE_SHOT_KEY) || "[]");
            if (!Array.isArray(parsed)) return [];
            return [...new Set(
                parsed
                    .map((value) => Number(value))
                    .filter((value) => Number.isInteger(value) && value > 0)
            )];
        } catch {
            return [];
        }
    };

    const persistOneShotIds = (ids) => {
        try {
            localStorage.setItem(ONE_SHOT_KEY, JSON.stringify(ids));
        } catch {
            /* localStorage 不可用时只保留当前会话 */
        }
    };

    const readCollapsedFolders = () => {
        try {
            const raw = localStorage.getItem(FOLDER_COLLAPSED_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(parsed) ? parsed.map((value) => String(value)) : []);
        } catch {
            return new Set();
        }
    };

    const persistCollapsedFolders = (folders) => {
        try {
            localStorage.setItem(FOLDER_COLLAPSED_KEY, JSON.stringify([...folders]));
        } catch {
            /* localStorage 不可用时只保留当前会话状态 */
        }
    };

    const readUsageCollapsed = () => {
        try {
            return localStorage.getItem(USAGE_COLLAPSED_KEY) === "1";
        } catch {
            return false;
        }
    };

    const loadDefaultFolderEditors = () => {
        const defaults = new Map();
        try {
            const raw = localStorage.getItem(FOLDER_DEFAULT_EDITORS_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === "object") {
                Object.entries(parsed).forEach(([name, editor]) => {
                    if (EDITOR_META[editor]) defaults.set(name, editor);
                });
            }
        } catch {
            /* localStorage 不可用时使用默认资源管理器 */
        }
        return defaults;
    };

    const persistFolderDefaultEditors = () => {
        try {
            localStorage.setItem(
                FOLDER_DEFAULT_EDITORS_KEY,
                JSON.stringify(Object.fromEntries(state.defaultFolderEditors))
            );
        } catch {
            /* localStorage 不可用 */
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
        folders: new Map(),
        editors: { vscode: true, qoder: true, explorer: true, powershell: true, cmd: true },
        editingId: null,
        editingFolderName: null,
        draggingProjectId: null,
        draggingFolderName: null,
        folderDropAfter: false,
        expandedProjects: new Set(),
        selectedCommands: new Map(),
        selectedLinks: new Map(),
        defaultEditors: loadDefaultEditors(),
        defaultFolderEditors: loadDefaultFolderEditors(),
        cloningProjectId: null,
        pendingImport: null,
        usage: [],
        usageAvailable: true,
        usageLoading: false,
        usagePolling: false,
        usageTimer: 0,
        usageSampledAt: "",
        usageError: "",
        usageCollapsed: readUsageCollapsed(),
        oneShotIds: readOneShotIds(),
        portUsagePort: 0,
        collapsedFolders: readCollapsedFolders(),
        statusPollTimer: 0,
        statusPolling: false,
        // 控制台会话集合：key -> { key, projectId, mode, runId, runName, command, status, pid, logSeq, lastUsedAt }
        terminals: new Map(),
        activeTerminalKey: null,
        pollTimer: 0,
        loading: false,
    };

    // 应用内确认弹窗的 Promise resolver（同一时间只允许一个）
    let confirmResolver = null;

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
        addFolderBtn: document.getElementById("addFolderBtn"),
        addProjectBtn: document.getElementById("addProjectBtn"),
        terminalDrawer: document.getElementById("terminalDrawer"),
        terminalTabs: document.getElementById("terminalTabs"),
        terminalCommand: document.getElementById("terminalCommand"),
        terminalPid: document.getElementById("terminalPid"),
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
        projectGitUrl: document.getElementById("projectGitUrl"),
        detectGitUrlBtn: document.getElementById("detectGitUrlBtn"),
        projectType: document.getElementById("projectType"),
        projectFolder: document.getElementById("projectFolder"),
        projectFolderOptions: document.getElementById("projectFolderOptions"),
        projectStartCommand: document.getElementById("projectStartCommand"),
        projectIntro: document.getElementById("projectIntro"),
        projectEditNotice: document.getElementById("projectEditNotice"),
        runCommandRows: document.getElementById("runCommandRows"),
        addRunCommandBtn: document.getElementById("addRunCommandBtn"),
        projectLinkRows: document.getElementById("projectLinkRows"),
        addProjectLinkBtn: document.getElementById("addProjectLinkBtn"),
        detectProjectBtn: document.getElementById("detectProjectBtn"),
        pickProjectPathBtn: document.getElementById("pickProjectPathBtn"),
        pickFolderPathBtn: document.getElementById("pickFolderPathBtn"),
        projectError: document.getElementById("projectError"),
        closeProjectModalBtn: document.getElementById("closeProjectModalBtn"),
        cancelProjectBtn: document.getElementById("cancelProjectBtn"),
        saveProjectBtn: document.getElementById("saveProjectBtn"),
        folderModal: document.getElementById("folderModal"),
        cloneProjectBtn: document.getElementById("cloneProjectBtn"),
        cloneProjectModal: document.getElementById("cloneProjectModal"),
        cloneProjectForm: document.getElementById("cloneProjectForm"),
        cloneGitUrl: document.getElementById("cloneGitUrl"),
        cloneTargetDir: document.getElementById("cloneTargetDir"),
        cloneTargetHint: document.getElementById("cloneTargetHint"),
        cloneProjectError: document.getElementById("cloneProjectError"),
        pickCloneTargetDirBtn: document.getElementById("pickCloneTargetDirBtn"),
        confirmCloneProjectBtn: document.getElementById("confirmCloneProjectBtn"),
        closeCloneProjectModalBtn: document.getElementById("closeCloneProjectModalBtn"),
        cancelCloneProjectBtn: document.getElementById("cancelCloneProjectBtn"),
        exportProjectsBtn: document.getElementById("exportProjectsBtn"),
        importProjectsBtn: document.getElementById("importProjectsBtn"),
        detectAllGitUrlBtn: document.getElementById("detectAllGitUrlBtn"),
        projectsToolbarMore: document.getElementById("projectsToolbarMore"),
        projectsMoreBtn: document.getElementById("projectsMoreBtn"),
        projectsMoreDropdown: document.getElementById("projectsMoreDropdown"),
        importProjectsModal: document.getElementById("importProjectsModal"),
        importProjectsForm: document.getElementById("importProjectsForm"),
        importProjectsFile: document.getElementById("importProjectsFile"),
        importFileName: document.getElementById("importFileName"),
        pickImportFileBtn: document.getElementById("pickImportFileBtn"),
        importProjectsSummary: document.getElementById("importProjectsSummary"),
        importTargetDir: document.getElementById("importTargetDir"),
        pickImportTargetDirBtn: document.getElementById("pickImportTargetDirBtn"),
        importProjectsError: document.getElementById("importProjectsError"),
        confirmImportProjectsBtn: document.getElementById("confirmImportProjectsBtn"),
        cancelImportProjectsBtn: document.getElementById("cancelImportProjectsBtn"),
        closeImportProjectsModalBtn: document.getElementById("closeImportProjectsModalBtn"),
        folderForm: document.getElementById("folderForm"),
        folderModalKicker: document.getElementById("folderModalKicker"),
        folderModalTitle: document.getElementById("folderModalTitle"),
        folderModalHint: document.getElementById("folderModalHint"),
        folderName: document.getElementById("folderName"),
        folderPath: document.getElementById("folderPath"),
        folderError: document.getElementById("folderError"),
        closeFolderModalBtn: document.getElementById("closeFolderModalBtn"),
        cancelFolderBtn: document.getElementById("cancelFolderBtn"),
        saveFolderBtn: document.getElementById("saveFolderBtn"),
        portToolBtn: document.getElementById("portToolBtn"),
        portModal: document.getElementById("portModal"),
        portQueryForm: document.getElementById("portQueryForm"),
        portInput: document.getElementById("portInput"),
        portQueryBtn: document.getElementById("portQueryBtn"),
        portError: document.getElementById("portError"),
        portResult: document.getElementById("portResult"),
        closePortModalBtn: document.getElementById("closePortModalBtn"),
        closePortModalFooterBtn: document.getElementById("closePortModalFooterBtn"),
        oneShotConfigBtn: document.getElementById("oneShotConfigBtn"),
        oneShotStartBtn: document.getElementById("oneShotStartBtn"),
        oneShotModal: document.getElementById("oneShotModal"),
        oneShotList: document.getElementById("oneShotList"),
        oneShotCount: document.getElementById("oneShotCount"),
        oneShotSelectAllBtn: document.getElementById("oneShotSelectAllBtn"),
        oneShotClearBtn: document.getElementById("oneShotClearBtn"),
        oneShotError: document.getElementById("oneShotError"),
        closeOneShotModalBtn: document.getElementById("closeOneShotModalBtn"),
        cancelOneShotBtn: document.getElementById("cancelOneShotBtn"),
        saveOneShotBtn: document.getElementById("saveOneShotBtn"),
        confirmModal: document.getElementById("confirmModal"),
        confirmModalTitle: document.getElementById("confirmModalTitle"),
        confirmModalText: document.getElementById("confirmModalText"),
        confirmActionBtn: document.getElementById("confirmActionBtn"),
        cancelConfirmBtn: document.getElementById("cancelConfirmBtn"),
        closeConfirmModalBtn: document.getElementById("closeConfirmModalBtn"),
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
        if (editor === "powershell") {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><rect x="1.6" y="3" width="20.8" height="18" rx="3.2" fill="#1b4e8c"></rect><rect x="1.6" y="3" width="20.8" height="18" rx="3.2" fill="#2c7fd0" opacity="0.5"></rect><rect x="1.6" y="3" width="20.8" height="4.4" rx="3.2" fill="#0f3560"></rect><path d="M6.2 10.6 9.8 13.4 6.2 16.2" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path><rect x="11.4" y="15" width="6.2" height="1.8" rx="0.9" fill="#fff"></rect></svg>`;
        }
        if (editor === "cmd") {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><rect x="1.6" y="3" width="20.8" height="18" rx="3.2" fill="#1f2428"></rect><rect x="1.6" y="3" width="20.8" height="4.4" rx="3.2" fill="#343b41"></rect><path d="M6.2 10.4 9.6 13.2 6.2 16" fill="none" stroke="#e9edf1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><rect x="11.2" y="14.9" width="5.8" height="1.7" rx="0.85" fill="#e9edf1"></rect></svg>`;
        }
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="#E4A33D" d="M3.5 5h5.2l2 2H20A1.5 1.5 0 0 1 21.5 8.5v9A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 4 5Z"></path><path fill="#F5C15B" d="M3.5 8h17v9.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5V8Z"></path></svg>`;
    };

    const editorAvailable = (editor) => state.editors[editor] !== false;

    function defaultEditorFor(projectId) {
        const stored = state.defaultEditors.get(Number(projectId));
        if (stored && editorAvailable(stored)) return stored;
        return ["vscode", "qoder", "explorer"].find(editorAvailable) || "vscode";
    }

    function defaultFolderEditorFor(folderName) {
        const stored = state.defaultFolderEditors.get(folderName);
        if (stored && editorAvailable(stored)) return stored;
        return ["explorer", "vscode", "qoder"].find(editorAvailable) || "explorer";
    }

    function setFolderDefaultEditor(folderName, editor) {
        if (!editorAvailable(editor)) return false;
        if (state.defaultFolderEditors.get(folderName) === editor) return false;
        state.defaultFolderEditors.set(folderName, editor);
        persistFolderDefaultEditors();
        return true;
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

    const formatCpuPercent = (value) => {
        if (value === null || value === undefined) return "—";
        const percent = Number(value);
        if (!Number.isFinite(percent)) return "—";
        if (percent > 0 && percent < 0.01) return "<0.01%";
        return `${percent.toFixed(2)}%`;
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
        el.usageNote.textContent = `${time ? `最近采样 ${time} · ` : ""}CPU 为整机占比，每 2 秒刷新`;
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
        // CPU 是整机占比，绝对值很小，进度条按本次最大值归一化才有可见差异
        const maxCpu = Math.max(0.01, ...cpuValues);

        if (el.usageProcessCount) el.usageProcessCount.textContent = String(usage.length);
        if (el.usageCpuTotal) el.usageCpuTotal.textContent = cpuValues.length ? formatCpuPercent(cpuTotal) : "—";
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
            const cpuBar = cpu === null || !Number.isFinite(cpu) ? 0 : clampPercent((cpu / maxCpu) * 100);
            const memoryBar = memory === null || !Number.isFinite(memory)
                ? 0
                : clampPercent((memory / maxMemory) * 100);
            const processCount = Number(item.processCount) || 0;
            const pid = item.pid === null || item.pid === undefined ? "—" : escapeHtml(item.pid);
            const cpuText = cpu !== null && Number.isFinite(cpu) ? formatCpuPercent(cpu) : "—";
            const memoryText = memory !== null && Number.isFinite(memory) ? formatMemory(memory) : "—";
            return `<article class="usage-item" data-usage-project="${Number(item.projectId) || 0}" role="button" tabindex="0" aria-label="定位到项目 ${name}">
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

    // 侧边“启动进程”点击后：展开所在文件夹、滚到卡片、打开命令菜单并高亮 2 秒
    function focusProjectCard(projectId) {
        const card = document.querySelector(`.project-card[data-project-id="${projectId}"]`);
        if (!card) {
            showToast("未找到对应的项目卡片");
            return;
        }
        // 只展开所在的文件夹分组，不展开卡片详情
        const folder = card.closest("[data-folder]");
        if (folder?.classList.contains("is-collapsed")) {
            const folderKey = folder.dataset.folder ?? "";
            state.collapsedFolders.delete(folderKey);
            persistCollapsedFolders(state.collapsedFolders);
            folder.classList.remove("is-collapsed");
            folder.querySelector("[data-folder-toggle]")?.setAttribute("aria-expanded", "true");
            updateCollapseButton();
        }
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        const picker = card.querySelector("[data-command-picker]") || card.querySelector("[data-link-picker]");
        if (picker) togglePicker(picker);
        card.classList.remove("is-focus-flash");
        void card.offsetWidth;
        card.classList.add("is-focus-flash");
        window.setTimeout(() => card.classList.remove("is-focus-flash"), 2000);
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
            // 弹窗打开时暂停刷新占用：侧栏是整体重绘，会和弹窗滚动抢帧
            if (document.visibilityState !== "hidden" && !document.body.classList.contains("modal-open")) {
                await loadUsage();
            }
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
        // 账号页也是普通用户管理自己 API 密钥的入口，登录即可见；用户列表仍仅管理员可见
        el.navAccountLink.classList.remove("hidden");
        el.accountManageLink.classList.remove("hidden");
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
        const canRestart = project.status === "running";
        const canDelete = !busy;
        const runMode = ["running", "starting", "stopping"].includes(project.status) ? "stop" : "start";
        const runDisabled = project.status === "stopping";
        const runTitle = project.status === "stopping"
            ? "停止中…"
            : runMode === "stop"
                ? project.status === "starting" ? "停止启动中的项目" : "停止项目"
                : "启动项目";
        const name = escapeHtml(project.name || "未命名项目");
        const projectPath = escapeHtml(project.path || "—");
        const startCommand = String(project.startCommand || project.command || "").trim();
        const runCommands = Array.isArray(project.runCommands) ? project.runCommands : [];
        const links = Array.isArray(project.links) ? project.links : [];
        const intro = String(project.intro || "").trim();
        const gitUrl = String(project.gitUrl || "").trim();
        const typeLabel = TYPE_LABELS[project.type] || project.typeLabel || project.type || "自定义";
        const pid = project.pid ? `PID ${escapeHtml(project.pid)}` : "";
        const expanded = state.expandedProjects.has(projectId);
        const storedCommandId = String(state.selectedCommands.get(projectId) || "");
        const selectedCommand = runCommands.find((item) => String(item.id) === storedCommandId) || runCommands[0];
        const selectedCommandId = selectedCommand ? String(selectedCommand.id) : "";
        const storedLinkId = String(state.selectedLinks.get(projectId) || "");
        const selectedLink = links.find((item) => String(item.id) === storedLinkId) || links[0];
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
        // 触发器只显示名称，下拉里才展开完整命令；触发器自带一个快速运行按钮。
        const commandMenuHtml = runCommands.length
            ? `<div class="project-picker project-command-picker" data-command-picker>
                <div class="project-picker-trigger">
                    <button class="project-picker-toggle" type="button" data-action="toggle-command-picker" title="${escapeHtml(selectedCommand?.command || "")}" aria-haspopup="listbox" aria-expanded="false">
                        <span class="project-picker-label">${escapeHtml(selectedCommand?.name || selectedCommand?.command || "命令")}</span>
                        <svg class="project-picker-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                    </button>
                    <button class="project-picker-quick" type="button" data-action="run-command" data-command-id="${Number(selectedCommand?.id || 0)}" title="运行：${escapeHtml(selectedCommand?.command || "")}" aria-label="运行当前命令">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"></path></svg>
                    </button>
                </div>
                <div class="project-picker-menu hidden" role="listbox">
                    ${runCommands.map((item) => {
                        const commandId = String(item.id);
                        const isSelected = commandId === selectedCommandId;
                        return `<div class="project-picker-option${isSelected ? " is-selected" : ""}" role="option" aria-selected="${isSelected ? "true" : "false"}">
                            <button class="project-picker-option-main" type="button" data-action="select-command" data-command-id="${Number(item.id)}" title="选择：${escapeHtml(item.command || item.name || "")}">
                                <span class="project-picker-option-name">${escapeHtml(item.name || "命令")}</span>
                                <code class="project-picker-option-detail">${escapeHtml(item.command || "")}</code>
                            </button>
                            <button class="project-picker-option-action" type="button" data-action="run-command" data-command-id="${Number(item.id)}" title="运行：${escapeHtml(item.command || item.name || "")}" aria-label="运行命令">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"></path></svg>
                            </button>
                        </div>`;
                    }).join("")}
                </div>
            </div>`
            : "";
        // 项目地址：触发器自带一个用默认浏览器打开的按钮；下拉里可切换地址。
        const linkMenuHtml = links.length
            ? `<div class="project-picker project-link-picker" data-link-picker>
                <div class="project-picker-trigger">
                    <button class="project-picker-toggle" type="button" data-action="toggle-link-picker" title="${escapeHtml(selectedLink?.url || "")}" aria-haspopup="listbox" aria-expanded="false">
                        <svg class="project-picker-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1L11 4.9"></path><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1L13 19"></path></svg>
                        <span class="project-picker-label">${escapeHtml(selectedLink?.name || selectedLink?.url || "项目地址")}</span>
                        <svg class="project-picker-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                    </button>
                    <button class="project-picker-quick" type="button" data-action="open-link" data-link-id="${Number(selectedLink?.id || 0)}" title="用默认浏览器打开：${escapeHtml(selectedLink?.url || "")}" aria-label="用默认浏览器打开">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"></path></svg>
                    </button>
                </div>
                <div class="project-picker-menu hidden" role="listbox">
                    ${links.map((item) => {
                        const linkId = String(item.id);
                        const isSelected = linkId === String(selectedLink?.id ?? "");
                        return `<div class="project-picker-option${isSelected ? " is-selected" : ""}" role="option" aria-selected="${isSelected ? "true" : "false"}">
                            <button class="project-picker-option-main" type="button" data-action="select-link" data-link-id="${Number(item.id)}" title="选择：${escapeHtml(item.url || "")}">
                                <span class="project-picker-option-name">${escapeHtml(item.name || item.url || "地址")}</span>
                                <code class="project-picker-option-detail">${escapeHtml(item.url || "")}</code>
                            </button>
                            <button class="project-picker-option-action" type="button" data-action="open-link" data-link-id="${Number(item.id)}" title="用默认浏览器打开：${escapeHtml(item.url || "")}" aria-label="用默认浏览器打开链接">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"></path></svg>
                            </button>
                        </div>`;
                    }).join("")}
                </div>
            </div>`
            : "";
        // 项目介绍是单条文本，只在展开的详情里展示。
        const introHtml = intro
            ? `<div class="project-detail-section project-detail-intro">
                <div class="project-detail-section-head"><strong>项目介绍</strong></div>
                <p class="project-intro-text">${escapeHtml(intro)}</p>
            </div>`
            : "";
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

        return `<article class="project-card${busy ? " is-running" : ""}${project.status === "error" ? " is-error" : ""}${expanded ? " is-expanded" : ""}" data-project-id="${projectId}" draggable="true">
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
                        <button class="project-icon-btn project-insight-btn" type="button" data-action="insight" title="查看 Git 洞察" aria-label="查看 Git 洞察">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"></path><polyline points="7 14 11 10 15 13 21 6"></polyline></svg>
                        </button>
                        <button class="project-icon-btn project-edit-btn" type="button" data-action="edit" title="编辑项目" aria-label="编辑项目">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                        </button>
                        <button class="project-icon-btn project-delete-btn" type="button" data-action="delete" title="${canDelete ? "删除项目" : "请先停止项目再删除"}" aria-label="删除项目">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 14h10l1-14"></path></svg>
                        </button>
                        <button class="project-icon-btn project-details-toggle${expanded ? " is-expanded" : ""}" type="button" data-action="toggle-details" title="${expanded ? "收起详情" : "展开详情"}" aria-label="${expanded ? "收起详情" : "展开详情"}" aria-expanded="${expanded ? "true" : "false"}">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 7.5h.01"></path></svg>
                        </button>
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
                                <button class="project-open-option" type="button" role="menuitem" data-action="editor" data-editor="powershell" title="${escapeHtml(editorTitle(state.editors.powershell, "PowerShell"))}"${state.editors.powershell ? "" : " disabled"}>
                                    ${editorIcon("powershell")}
                                    <span>在 PowerShell 中打开</span>
                                </button>
                                <button class="project-open-option" type="button" role="menuitem" data-action="editor" data-editor="cmd" title="${escapeHtml(editorTitle(state.editors.cmd, "CMD"))}"${state.editors.cmd ? "" : " disabled"}>
                                    ${editorIcon("cmd")}
                                    <span>在 CMD 中打开</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    ${pid ? `<span class="project-pid">${pid}</span>` : ""}
                </div>
            </div>

            <div class="project-quick-row">
                <div class="project-quick-actions">
                    <button class="project-icon-btn project-run-toggle is-${runMode}" type="button" data-action="toggle-run" title="${runTitle}" aria-label="${runTitle}"${runDisabled ? " disabled" : ""}>
                        ${runMode === "stop"
                            ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"></rect></svg>'
                            : '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"></path></svg>'}
                    </button>
                    <button class="project-icon-btn project-restart-toggle" type="button" data-action="restart" title="重启项目" aria-label="重启项目"${canRestart ? "" : " disabled"}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5"></path><path d="M20 4v7h-7"></path></svg>
                    </button>
                    <button class="project-icon-btn project-pull-btn" type="button" data-action="pull" title="拉取项目到本机" aria-label="拉取项目到本机">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>
                    </button>
                </div>
                <div class="project-quick-run">
                    ${commandMenuHtml}
                    ${linkMenuHtml}
                </div>
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
                    ${gitUrl ? `<div class="project-detail-item">
                        <span class="project-detail-label">Git 远程</span>
                        <code class="project-start-command" title="${escapeHtml(gitUrl)}">${escapeHtml(gitUrl)}</code>
                    </div>` : ""}
                </div>
                ${introHtml}
                <div class="project-detail-section">
                    <div class="project-detail-section-head"><strong>运行命令</strong><span>${runCommands.length} 条</span></div>
                    ${runCommandHtml}
                </div>
                <div class="project-detail-actions">
                    <button class="btn btn-sm" type="button" data-action="terminal">启动终端</button>
                    <button class="btn btn-sm" type="button" data-action="pull">拉取项目</button>
                    <button class="btn btn-sm" type="button" data-action="edit">编辑</button>
                    <button class="btn btn-sm btn-danger" type="button" data-action="delete">删除</button>
                </div>
            </div>
        </article>`;
    }

    function refreshFolderOptions() {
        if (!el.projectFolderOptions) return;
        const folders = [...new Set([
            ...state.folders.keys(),
            ...state.projects
                .map((project) => String(project.folder || "").trim())
                .filter(Boolean),
        ])].sort((a, b) => a.localeCompare(b, "zh-CN"));
        el.projectFolderOptions.innerHTML = folders
            .map((folder) => `<option value="${escapeHtml(folder)}"></option>`)
            .join("");
    }

    function folderNamesInOrder() {
        const ordered = [...state.folders.values()]
            .sort((a, b) => {
                const orderDiff = (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
                return orderDiff || a.name.localeCompare(b.name, "zh-CN");
            })
            .map((folder) => folder.name);
        const extras = [...new Set(
            state.projects
                .map((project) => String(project.folder || "").trim())
                .filter((name) => name && !state.folders.has(name))
        )].sort((a, b) => a.localeCompare(b, "zh-CN"));
        return [...new Set([...ordered, ...extras])];
    }

    function folderSectionHtml(folder, projects) {
        const key = String(folder || "");
        const info = key ? state.folders.get(key) : null;
        const folderPath = String(info?.path || "");
        const collapsed = state.collapsedFolders.has(key);
        const running = projects.filter((project) => ACTIVE_STATUSES.includes(project.status)).length;
        const title = key || "未分组";
        const meta = `${projects.length} 个项目${running > 0 ? ` · <span class="is-running-text">${running} 个运行中</span>` : ""}`;
        const pathText = key ? (folderPath || "未设置路径") : "拖入项目可移出文件夹";
        const defaultEditor = key ? defaultFolderEditorFor(key) : "explorer";
        const defaultEditorLabel = EDITOR_META[defaultEditor].label;
        const folderDefaultBadge = (editor) => editor === defaultEditor
            ? '<span class="project-open-default">（默认）</span>'
            : "";
        const folderEditorTitle = (editor, label) => {
            if (!folderPath) return "请先在文件夹设置中填写路径";
            return editorAvailable(editor) ? `用 ${label} 打开文件夹` : `未检测到 ${label} 命令行工具`;
        };
        const folderOpenOption = (editor, label) => {
            const disabled = !folderPath || !editorAvailable(editor);
            return `<button class="project-open-option" type="button" role="menuitem" data-folder-action="open" data-editor="${editor}" title="${escapeHtml(folderEditorTitle(editor, label))}"${disabled ? " disabled" : ""}>
                ${editorIcon(editor)}
                <span>${escapeHtml(label)}${folderDefaultBadge(editor)}</span>
            </button>`;
        };
        const mainEditorAvailable = editorAvailable(defaultEditor);
        const mainOpenDisabled = !folderPath || !mainEditorAvailable;
        const mainOpenTitle = folderEditorTitle(defaultEditor, defaultEditorLabel);
        const actions = key
            ? `<div class="project-folder-actions">
                    <div class="project-open-menu folder-open-menu">
                        <div class="project-open-split">
                            <button class="project-open-main is-${defaultEditor}" type="button" data-folder-action="open" data-editor="${defaultEditor}" title="${escapeHtml(mainOpenTitle)}" aria-label="${escapeHtml(mainOpenTitle)}"${mainOpenDisabled ? " disabled" : ""}>${editorIcon(defaultEditor)}</button>
                            <button class="project-open-caret" type="button" data-folder-action="toggle-open-menu" title="选择打开方式" aria-label="选择打开方式" aria-haspopup="menu" aria-expanded="false"${folderPath ? "" : " disabled"}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                            </button>
                        </div>
                        <div class="project-open-dropdown hidden" role="menu">
                            ${folderOpenOption("explorer", "文件资源管理器")}
                            ${folderOpenOption("vscode", "VS Code")}
                            ${folderOpenOption("qoder", "Qoder IDE")}
                            ${folderOpenOption("powershell", "PowerShell")}
                            ${folderOpenOption("cmd", "CMD")}
                        </div>
                    </div>
                    <button class="project-folder-action is-settings" type="button" data-folder-action="settings" title="文件夹设置" aria-label="文件夹设置">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                    </button>
                    <button class="project-folder-action is-add-project" type="button" data-folder-action="add-project" title="在「${escapeHtml(title)}」中新建项目" aria-label="在${escapeHtml(title)}中新建项目">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
                    </button>
                </div>`
            : "";
        const body = projects.length > 0
            ? `<div class="project-grid">${projects.map(projectCardHtml).join("")}</div>`
            : `<div class="project-folder-empty">${key ? "拖入项目即可归到此文件夹" : "拖到这里可移出文件夹"}</div>`;
        return `<section class="project-folder${key ? "" : " is-ungrouped"}${collapsed ? " is-collapsed" : ""}" data-folder="${escapeHtml(key)}">
            <div class="project-folder-head">
                ${key ? `<span class="project-folder-grip" data-folder-grip draggable="true" title="拖动调整文件夹顺序" aria-label="拖动调整文件夹顺序"><svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2"></circle><circle cx="9" cy="3" r="1.2"></circle><circle cx="3" cy="8" r="1.2"></circle><circle cx="9" cy="8" r="1.2"></circle><circle cx="3" cy="13" r="1.2"></circle><circle cx="9" cy="13" r="1.2"></circle></svg></span>` : ""}
                <button class="project-folder-toggle" type="button" data-folder-toggle aria-expanded="${collapsed ? "false" : "true"}">
                    <svg class="project-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
                    <span class="project-folder-title-wrap">
                        <span class="project-folder-name" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                        <span class="project-folder-path" title="${escapeHtml(pathText)}">${escapeHtml(pathText)}</span>
                    </span>
                    <span class="project-folder-meta">${meta}</span>
                    <svg class="project-folder-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                </button>
                ${actions}
            </div>
            <div class="project-folder-body">${body}</div>
        </section>`;
    }

    function updateCollapseButton() {
        if (!el.toggleAllProjectsBtn) return;
        const hasExpanded = state.expandedProjects.size > 0;
        const label = hasExpanded ? "全部收起" : "全部展开";
        el.toggleAllProjectsBtn.title = label;
        el.toggleAllProjectsBtn.setAttribute("aria-label", label);
        el.toggleAllProjectsBtn.disabled = state.projects.length === 0;
    }

    function setToolbarMenuOpen(open) {
        if (!el.projectsToolbarMore) return;
        el.projectsToolbarMore.classList.toggle("is-open", open);
        el.projectsMoreBtn.setAttribute("aria-expanded", open ? "true" : "false");
        el.projectsMoreDropdown.classList.toggle("hidden", !open);
    }

    function closeOpenMenus() {
        document.querySelectorAll(".project-open-menu.is-open").forEach((menu) => {
            menu.classList.remove("is-open");
            menu.querySelector(".project-open-caret")?.setAttribute("aria-expanded", "false");
            menu.querySelector(".project-open-dropdown")?.classList.add("hidden");
        });
    }

    function closePickers() {
        document.querySelectorAll(".project-picker.is-open").forEach((picker) => {
            picker.classList.remove("is-open");
            picker.querySelector(".project-picker-menu")?.classList.add("hidden");
            picker.querySelector(".project-picker-trigger")?.setAttribute("aria-expanded", "false");
        });
    }

    function togglePicker(picker) {
        if (!picker) return;
        const wasOpen = picker.classList.contains("is-open");
        closePickers();
        closeOpenMenus();
        if (wasOpen) return;
        picker.classList.add("is-open");
        picker.querySelector(".project-picker-menu")?.classList.remove("hidden");
        picker.querySelector(".project-picker-trigger")?.setAttribute("aria-expanded", "true");
    }

    // 选中后只更新触发器（名称 + hover 完整文本），避免整页重绘丢焦点。
    function applyPickerSelection(picker, option) {
        if (!picker || !option) return;
        picker.querySelectorAll(".project-picker-option").forEach((item) => {
            const active = item === option;
            item.classList.toggle("is-selected", active);
            item.setAttribute("aria-selected", active ? "true" : "false");
        });
        const trigger = picker.querySelector(".project-picker-trigger");
        const label = trigger?.querySelector(".project-picker-label");
        const nameText = option.querySelector(".project-picker-option-name")?.textContent || "";
        const detailText = option.querySelector(".project-picker-option-detail")?.textContent || "";
        if (label) label.textContent = nameText;
        if (trigger) trigger.title = detailText;
        // 快速按钮跟着切换目标，避免选完仍指向旧命令/旧地址
        const quick = picker.querySelector(".project-picker-quick");
        if (quick) {
            const commandId = option.querySelector("[data-command-id]")?.dataset.commandId;
            const linkId = option.querySelector("[data-link-id]")?.dataset.linkId;
            if (commandId) {
                quick.dataset.commandId = commandId;
                quick.title = `运行：${detailText}`;
            }
            if (linkId) {
                quick.dataset.linkId = linkId;
                quick.title = `用默认浏览器打开：${detailText}`;
            }
        }
    }

    function toggleOpenMenu(menu) {
        const wasOpen = menu.classList.contains("is-open");
        closeOpenMenus();
        closePickers();
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
        for (const id of state.selectedLinks.keys()) {
            if (!currentIds.has(id)) state.selectedLinks.delete(id);
        }
        el.projectCount.textContent = String(count);
        el.runningCount.textContent = String(running);

        const grouped = new Map();
        for (const project of state.projects) {
            const folder = String(project.folder || "").trim();
            const list = grouped.get(folder) || [];
            list.push(project);
            grouped.set(folder, list);
        }
        const namedFolders = folderNamesInOrder();
        el.projectEmpty.classList.toggle("hidden", count > 0 || namedFolders.length > 0);
        if (namedFolders.length > 0) {
            el.projectGrid.classList.add("has-folders");
            const sections = namedFolders.map((folder) => folderSectionHtml(folder, grouped.get(folder) || []));
            const ungrouped = grouped.get("") || [];
            // 有项目时保留未分组落点，方便把项目从文件夹拖出来。
            if (ungrouped.length > 0 || count > 0) sections.push(folderSectionHtml("", ungrouped));
            el.projectGrid.innerHTML = sections.join("");
        } else {
            el.projectGrid.classList.remove("has-folders");
            el.projectGrid.innerHTML = state.projects.map(projectCardHtml).join("");
        }
        refreshFolderOptions();
        updateCollapseButton();

        const currentSession = activeTerminal();
        if (currentSession && currentSession.mode === "start") {
            const project = projectById(currentSession.projectId);
            if (project) updateTerminalStatus(project.status, project.pid);
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
            // 弹窗打开时先不重建项目网格，避免与弹窗滚动抢帧
            if (document.body.classList.contains("modal-open")) {
                state.statusPollTimer = window.setTimeout(tick, 1000);
                return;
            }
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

    const terminalSessionKey = (projectId, mode, runId = null) =>
        `p${Number(projectId)}:${mode}${mode === "run" ? `:${Number(runId)}` : ""}`;

    const activeTerminal = () =>
        state.activeTerminalKey ? state.terminals.get(state.activeTerminalKey) || null : null;

    function terminalTitle(session) {
        const project = projectById(session.projectId);
        const base = project?.name || "未命名项目";
        return session.mode === "run" ? `${base} · ${session.runName || "运行命令"}` : `${base} · 启动进程`;
    }

    function ensureTerminalSession({ projectId, mode, runId = null, runName = "", command = "", status = "stopped", pid = null }) {
        const key = terminalSessionKey(projectId, mode, runId);
        let session = state.terminals.get(key);
        if (!session) {
            session = {
                key,
                projectId: Number(projectId),
                mode,
                runId: mode === "run" ? Number(runId) : null,
                runName,
                command,
                status,
                pid,
                logSeq: 0,
                reqId: 0,
                lastUsedAt: 0,
            };
            state.terminals.set(key, session);
        } else {
            if (runName) session.runName = runName;
            if (command) session.command = command;
            if (status) session.status = status;
            session.pid = pid;
        }
        return session;
    }

    function renderTerminalTabs() {
        if (!el.terminalTabs) return;
        el.terminalTabs.innerHTML = [...state.terminals.values()].map((session) => {
            const meta = session.mode === "run" ? runStatusMeta(session.status) : statusMeta(session.status);
            const isActive = session.key === state.activeTerminalKey;
            const title = escapeHtml(terminalTitle(session));
            return `<div class="terminal-tab${isActive ? " is-active" : ""}">
                <button class="terminal-tab-main" type="button" role="tab" aria-selected="${isActive ? "true" : "false"}" data-terminal-tab-select="${escapeHtml(session.key)}" title="${title}">
                    <span class="terminal-tab-dot ${meta.className}" data-terminal-tab-dot="${escapeHtml(session.key)}"></span>
                    <span class="terminal-tab-label">${title}</span>
                </button>
                <button class="terminal-tab-close" type="button" data-terminal-tab-close="${escapeHtml(session.key)}" title="关闭控制台" aria-label="关闭控制台">✕</button>
            </div>`;
        }).join("");
    }

    // 只刷新单个标签的状态点，避免日志轮询时重建整个标签栏
    function syncTerminalTabDot(session) {
        const dot = el.terminalTabs?.querySelector(`[data-terminal-tab-dot="${session.key}"]`);
        if (!dot) return;
        const meta = session.mode === "run" ? runStatusMeta(session.status) : statusMeta(session.status);
        dot.className = `terminal-tab-dot ${meta.className}`;
    }

    function updateTerminalStatus(status, pid) {
        const session = activeTerminal();
        if (!session) return;
        session.status = status;
        session.pid = pid;
        const showStop = session.mode === "run" && (status === "running" || status === "stopping");
        el.terminalStopRunBtn.classList.toggle("hidden", !showStop);
        el.terminalStopRunBtn.textContent = status === "stopping" ? "停止中…" : "停止命令";
        el.terminalStopRunBtn.disabled = status === "stopping";
        el.terminalPid.textContent = pid ? `PID ${pid}` : "";
        syncTerminalTabDot(session);
    }

    function renderTerminalHead() {
        const session = activeTerminal();
        if (!session) return;
        el.terminalCommand.textContent = session.command || "—";
        updateTerminalStatus(session.status, session.pid);
    }

    function activateTerminal(key) {
        const session = state.terminals.get(key);
        if (!session) return;
        stopPolling();
        state.activeTerminalKey = key;
        session.lastUsedAt = Date.now();
        const wasHidden = el.terminalDrawer.classList.contains("hidden");
        el.terminalDrawer.classList.remove("hidden");
        el.terminalDrawer.setAttribute("aria-hidden", "false");
        renderTerminalTabs();
        renderTerminalHead();
        el.terminalLog.innerHTML = '<span class="terminal-placeholder">正在读取终端输出…</span>';
        // 仅在抽屉从隐藏变为可见时滚动定位，切换标签不再带走页面滚动
        if (wasHidden) {
            el.terminalDrawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        void loadLogs(true);
    }

    function hideTerminalDrawer() {
        stopPolling();
        state.activeTerminalKey = null;
        el.terminalDrawer.classList.add("hidden");
        el.terminalDrawer.setAttribute("aria-hidden", "true");
        el.terminalStopRunBtn.classList.add("hidden");
        renderTerminalTabs();
    }

    function closeTerminalTab(key) {
        if (!state.terminals.has(key)) return;
        const wasActive = state.activeTerminalKey === key;
        state.terminals.delete(key);
        if (!wasActive) {
            renderTerminalTabs();
            return;
        }
        stopPolling();
        state.activeTerminalKey = null;
        // 关闭当前标签后切到相邻的其他控制台
        const next = [...state.terminals.values()].pop() || null;
        if (next) activateTerminal(next.key);
        else hideTerminalDrawer();
    }

    // 关闭全部控制台（登出、失去权限等场景）
    function closeTerminal() {
        state.terminals.clear();
        hideTerminalDrawer();
    }

    function closeProjectTerminals(projectId) {
        const id = Number(projectId);
        const keys = [...state.terminals.values()]
            .filter((session) => session.projectId === id)
            .map((session) => session.key);
        keys.forEach((key) => closeTerminalTab(key));
    }

    function stopPolling() {
        if (state.pollTimer) {
            window.clearTimeout(state.pollTimer);
            state.pollTimer = 0;
        }
    }

    // 只对当前激活的标签轮询，切换标签后旧轮询自然失效
    function schedulePoll(delay) {
        stopPolling();
        const key = state.activeTerminalKey;
        state.pollTimer = window.setTimeout(() => {
            if (state.activeTerminalKey === key) void loadLogs(false);
        }, delay);
    }

    function appendLogs(logs, reset, session) {
        if (reset) {
            el.terminalLog.innerHTML = "";
            session.logSeq = 0;
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
            session.logSeq = Math.max(session.logSeq, Number(entry.seq) || 0);
        }
        el.terminalLog.append(fragment);
        el.terminalLog.scrollTop = el.terminalLog.scrollHeight;
    }

    async function loadLogs(reset) {
        const session = activeTerminal();
        if (!session) return;
        const { key, projectId, mode, runId } = session;
        if (mode === "run" && !runId) return;
        stopPolling();
        const reqId = ++session.reqId;
        const after = reset ? 0 : session.logSeq;
        const endpoint = mode === "run"
            ? `/projects/${projectId}/runs/${runId}/logs?after=${after}`
            : `/projects/${projectId}/logs?after=${after}`;
        try {
            const json = await api(endpoint);
            // 请求发起后标签被切换/关闭时丢弃过期响应，避免日志重复
            if (session.reqId !== reqId || state.terminals.get(key) !== session || state.activeTerminalKey !== key) {
                return;
            }
            appendLogs(json.logs, reset, session);
            session.logSeq = Number(json.nextSeq) || session.logSeq;

            if (mode === "run") {
                updateTerminalStatus(json.status, json.pid);
                if (json.status === "running" || json.status === "stopping") {
                    schedulePoll(800);
                } else {
                    // 运行结束后同步清除卡片上的控制台入口标记
                    clearProjectActiveRun(projectId, runId);
                }
                return;
            }

            updateTerminalStatus(json.status, json.pid);
            const project = projectById(projectId);
            if (project && (project.status !== json.status || project.pid !== json.pid)) {
                project.status = json.status;
                project.pid = json.pid;
                renderProjects();
            }
            const active = json.status === "starting" || json.status === "running" || json.status === "stopping";
            schedulePoll(active ? 800 : 1600);
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
                if (session.reqId !== reqId) return;
                showToast("运行记录已失效", "warning");
                clearProjectActiveRun(projectId, runId);
                closeTerminalTab(key);
                return;
            }
            if (session.reqId === reqId && state.activeTerminalKey === key) {
                schedulePoll(2200);
            }
        }
    }

    function openTerminal(projectId) {
        const project = projectById(projectId);
        if (!project) return;
        const session = ensureTerminalSession({
            projectId,
            mode: "start",
            command: project.startCommand || project.command || "未配置启动命令",
            status: project.status,
            pid: project.pid,
        });
        activateTerminal(session.key);
    }

    function clearProjectActiveRun(projectId, runId) {
        const project = projectById(projectId);
        if (!project?.activeRun) return;
        if (Number(project.activeRun.id) !== Number(runId)) return;
        project.activeRun = null;
        renderProjects();
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
            // 记录到项目上，命令运行期间关掉标签后仍能找回控制台入口
            project.activeRun = run;
            renderProjects();
            openRunConsole(projectId, run);
            showToast(`正在运行：${run.name || command.name || "运行命令"}`);
        } catch (error) {
            handleActionError(error, "运行命令失败");
        }
    }

    // 打开指定运行命令的控制台标签
    function openRunConsole(projectId, run) {
        const project = projectById(projectId);
        if (!project || !run) return;
        const runId = Number(run.id);
        if (!runId) return;
        const session = ensureTerminalSession({
            projectId,
            mode: "run",
            runId,
            runName: run.name || "运行命令",
            command: run.command || "",
            status: run.status || "running",
            pid: run.pid,
        });
        activateTerminal(session.key);
    }

    // 卡片上的控制台入口：优先激活该项目最近打开过的标签，其次恢复运行中的命令，最后打开启动进程
    function openProjectConsole(projectId) {
        const id = Number(projectId);
        const existing = [...state.terminals.values()]
            .filter((session) => session.projectId === id)
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
        if (existing) {
            activateTerminal(existing.key);
            return;
        }
        const project = projectById(id);
        if (!project) return;
        const activeRun = project.activeRun;
        if (activeRun && (activeRun.status === "running" || activeRun.status === "stopping")) {
            openRunConsole(id, activeRun);
            return;
        }
        openTerminal(id);
    }

    async function stopActiveRun() {
        const session = activeTerminal();
        if (!session || session.mode !== "run" || !session.runId) return;
        el.terminalStopRunBtn.disabled = true;
        try {
            await api(`/projects/${session.projectId}/runs/${session.runId}/stop`, { method: "POST" });
            showToast("正在停止运行命令");
            if (activeTerminal() === session) void loadLogs(false);
        } catch (error) {
            handleActionError(error, "停止运行命令失败");
        } finally {
            if (activeTerminal() === session) el.terminalStopRunBtn.disabled = false;
        }
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
            const session = activeTerminal();
            if (session && session.mode === "start" && session.projectId === Number(projectId)) {
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

    // 项目路径与 Git 洞察仓库地址比对时忽略大小写、斜杠方向和末尾斜杠
    const normalizeRepoPath = (value) =>
        String(value || "").trim().replace(/\\+/g, "/").replace(/\/+$/, "").toLowerCase();

    async function findInsightRepoByPath(projectPath) {
        const json = await api("/repos");
        const target = normalizeRepoPath(projectPath);
        return (Array.isArray(json.repos) ? json.repos : [])
            .find((repo) => normalizeRepoPath(repo.url) === target) || null;
    }

    // 把项目地址交给 Git 洞察：已收录的仓库直接打开，未收录的创建后跳转
    async function openProjectInsight(projectId, button) {
        const project = projectById(projectId);
        if (!project) return;
        const projectPath = String(project.path || "").trim();
        if (!projectPath) {
            showToast("项目还没有填写地址，无法生成洞察", "warning");
            return;
        }
        if (button) button.disabled = true;
        try {
            const existing = await findInsightRepoByPath(projectPath);
            if (existing) {
                window.location.href = `/pages/index.html?repo=${Number(existing.id)}`;
                return;
            }
            if (!Auth.hasRole(state.user?.role, "readwrite")) {
                showToast("当前账号为只读权限，无法把项目加入 Git 洞察", "warning");
                return;
            }
            showToast("正在读取提交历史，首次添加可能需要一会儿");
            const created = await api("/repos", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: project.name || projectPath, url: projectPath }),
            });
            const repoId = Number(created.repo?.id);
            if (!repoId) throw new Error("未获取到新建仓库编号");
            window.location.href = `/pages/index.html?repo=${repoId}`;
        } catch (error) {
            // 多个入口同时添加同一路径时后端会以 409 拒绝，复查到已有仓库就直接打开
            if (error.status === 409) {
                const existing = await findInsightRepoByPath(projectPath).catch(() => null);
                if (existing) {
                    window.location.href = `/pages/index.html?repo=${Number(existing.id)}`;
                    return;
                }
            }
            handleActionError(error, "打开 Git 洞察失败");
        } finally {
            if (button) button.disabled = false;
        }
    }

    async function deleteProject(projectId) {
        const project = projectById(projectId);
        if (!project) return;
        if (ACTIVE_STATUSES.includes(project.status)) {
            showToast("请先停止项目再删除", "warning");
            return;
        }
        const confirmed = await askConfirm({
            title: "删除项目",
            text: `确定删除「${project.name}」吗？运行命令和项目地址会一并删除，此操作不可撤销。`,
            confirmText: "删除",
        });
        if (!confirmed) return;
        try {
            await api(`/projects/${projectId}`, { method: "DELETE" });
            state.expandedProjects.delete(Number(projectId));
            state.selectedCommands.delete(Number(projectId));
            state.selectedLinks.delete(Number(projectId));
            state.defaultEditors.delete(Number(projectId));
            persistDefaultEditors();
            closeProjectTerminals(projectId);
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

    function addProjectLinkRow(link = {}) {
        const row = document.createElement("div");
        row.className = "project-link-editor-row";
        row.dataset.projectLinkRow = "1";

        const name = document.createElement("input");
        name.className = "text-input";
        name.type = "text";
        name.placeholder = "名称，例如 前台";
        name.dataset.linkName = "1";
        name.maxLength = 120;
        name.value = link.name || "";

        const url = document.createElement("input");
        url.className = "text-input";
        url.type = "text";
        url.placeholder = "地址，例如 https://example.com";
        url.dataset.linkUrl = "1";
        url.value = link.url || "";

        const remove = document.createElement("button");
        remove.className = "icon-btn";
        remove.type = "button";
        remove.title = "移除这个项目地址";
        remove.setAttribute("aria-label", "移除项目地址");
        remove.dataset.removeProjectLink = "1";
        remove.textContent = "✕";

        row.append(name, url, remove);
        el.projectLinkRows.append(row);
    }

    function renderProjectLinkRows(links = []) {
        el.projectLinkRows.innerHTML = "";
        if (Array.isArray(links) && links.length > 0) {
            links.forEach((link) => addProjectLinkRow(link));
        }
    }

    function collectProjectLinks() {
        return Array.from(el.projectLinkRows.querySelectorAll("[data-project-link-row]"))
            .map((row) => ({
                name: String(row.querySelector("[data-link-name]")?.value || "").trim(),
                url: String(row.querySelector("[data-link-url]")?.value || "").trim(),
            }))
            .filter((item) => item.url);
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

    // 项目运行中只允许改名称/文件夹/介绍/地址，启动相关字段保持只读
    function setProjectLaunchConfigLocked(locked) {
        el.projectPath.disabled = locked;
        el.pickProjectPathBtn.disabled = locked;
        el.detectProjectBtn.disabled = locked;
        el.projectType.disabled = locked;
        el.projectStartCommand.disabled = locked;
        el.addRunCommandBtn.disabled = locked;
        el.runCommandRows.querySelectorAll("input, button").forEach((node) => {
            node.disabled = locked;
        });
        el.projectEditNotice?.classList.toggle("hidden", !locked);
    }

    function openProjectModal(project = null, presetFolder = "") {
        const launchLocked = Boolean(project) && ACTIVE_STATUSES.includes(project.status);
        state.editingId = project ? Number(project.id) : null;
        el.projectModalKicker.textContent = project ? "Edit Project" : "New Project";
        el.projectModalTitle.textContent = project ? "编辑项目" : "添加项目";
        el.saveProjectBtn.textContent = project ? "保存修改" : "添加项目";
        el.projectPath.value = project?.path || "";
        el.projectName.value = project?.name || "";
        el.projectGitUrl.value = project?.gitUrl || "";
        el.projectType.value = project?.type || "auto";
        el.projectFolder.value = project?.folder || presetFolder;
        refreshFolderOptions();
        el.projectStartCommand.value = project?.startCommand || project?.command || "";
        el.projectIntro.value = project?.intro || "";
        renderRunCommandRows(project?.runCommands || []);
        renderProjectLinkRows(project?.links || []);
        setProjectLaunchConfigLocked(launchLocked);
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

    async function pickFolderInto(input, button) {
        if (!input || !button) return;
        button.disabled = true;
        button.classList.add("is-picking");
        try {
            const json = await api("/projects/pick-folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initialPath: input.value.trim() }),
            });
            if (json.path) {
                input.value = json.path;
                input.dispatchEvent(new Event("change", { bubbles: true }));
                input.focus();
            }
        } catch (error) {
            handleActionError(error, "打开文件夹选择器失败");
        } finally {
            button.disabled = false;
            button.classList.remove("is-picking");
        }
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

    // 从所选项目目录读取 origin 远程地址，识别不到时允许手动填写
    async function detectGitUrl() {
        const projectPath = el.projectPath.value.trim();
        if (!projectPath) {
            showToast("请先填写项目地址", "warning");
            el.projectPath.focus();
            return;
        }
        el.detectGitUrlBtn.disabled = true;
        const previousText = el.detectGitUrlBtn.textContent;
        el.detectGitUrlBtn.textContent = "识别中…";
        try {
            const json = await api("/projects/detect-git", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: projectPath }),
            });
            if (json.url) {
                el.projectGitUrl.value = json.url;
                showToast("已识别 Git 远程地址");
            } else {
                showToast("未识别到 Git 远程地址，可以手动填写", "warning");
            }
        } catch (error) {
            handleActionError(error, "识别 Git 远程地址失败");
        } finally {
            el.detectGitUrlBtn.disabled = false;
            el.detectGitUrlBtn.textContent = previousText;
        }
    }

    // 拉取项目：不带项目时拉取完成后直接添加；带项目时刷新该项目的本地地址
    function openCloneProjectModal(project = null) {
        if (project && ACTIVE_STATUSES.includes(project.status)) {
            showToast("请先停止项目再拉取代码", "warning");
            return;
        }
        state.cloningProjectId = project ? Number(project.id) : null;
        el.cloneGitUrl.value = project?.gitUrl || "";
        el.cloneTargetDir.value = "";
        el.cloneTargetHint.textContent = project
            ? "拉取完成后会用新目录更新这个项目的地址，并保留启动命令与运行命令"
            : "会在所选文件夹下创建与仓库同名的子目录，子目录已存在且不为空时会中止";
        el.cloneProjectError.textContent = "";
        el.cloneProjectError.classList.add("hidden");
        el.cloneProjectModal.classList.add("is-open");
        el.cloneProjectModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        window.setTimeout(() => el.cloneGitUrl.focus(), 40);
    }

    function closeCloneProjectModal() {
        el.cloneProjectModal.classList.remove("is-open");
        el.cloneProjectModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        state.cloningProjectId = null;
    }

    async function openAddProjectFromClone(cloned, url) {
        const clonedPath = String(cloned.path || "");
        if (!clonedPath) return;
        const detection = cloned.detection || {};
        try {
            // 启动命令能自动识别时一步登记，否则回退到添加表单补齐
            await api("/projects", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: cloned.name || detection.name || "",
                    path: clonedPath,
                    gitUrl: url,
                }),
            });
            showToast("项目已拉取并添加");
            await loadProjects();
        } catch (error) {
            openProjectModal();
            el.projectPath.value = clonedPath;
            el.projectGitUrl.value = url;
            el.projectName.value = cloned.name || detection.name || "";
            el.projectType.value = detection.type || "auto";
            el.projectStartCommand.value = detection.startCommand || detection.command || "";
            renderRunCommandRows(Array.isArray(detection.commands) ? detection.commands : []);
            showToast(error.message || "代码已拉取，请补充启动命令后保存", "warning");
        }
    }

    async function submitCloneProject(event) {
        event.preventDefault();
        const url = el.cloneGitUrl.value.trim();
        const targetDir = el.cloneTargetDir.value.trim();
        const showError = (message) => {
            el.cloneProjectError.textContent = message;
            el.cloneProjectError.classList.remove("hidden");
        };
        if (!url) {
            showError("请输入 Git 远程地址");
            el.cloneGitUrl.focus();
            return;
        }
        if (!targetDir) {
            showError("请选择拉取到的文件夹");
            el.cloneTargetDir.focus();
            return;
        }
        el.cloneProjectError.classList.add("hidden");
        el.confirmCloneProjectBtn.disabled = true;
        el.cancelCloneProjectBtn.disabled = true;
        const previousText = el.confirmCloneProjectBtn.textContent;
        el.confirmCloneProjectBtn.textContent = "拉取中…";
        try {
            const cloned = await api("/projects/clone", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, targetDir }),
            });
            const project = state.cloningProjectId ? projectById(state.cloningProjectId) : null;
            closeCloneProjectModal();
            if (project) {
                await api(`/projects/${project.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: project.name,
                        folder: project.folder || "",
                        intro: project.intro || "",
                        path: cloned.path,
                        startCommand: project.startCommand || project.command || "",
                        gitUrl: url,
                    }),
                });
                showToast("已拉取并更新项目地址");
                await loadProjects();
                return;
            }
            showToast(`已拉取到 ${cloned.path || targetDir}`);
            await openAddProjectFromClone(cloned, url);
        } catch (error) {
            showError(error.message || "拉取项目失败");
        } finally {
            el.confirmCloneProjectBtn.disabled = false;
            el.cancelCloneProjectBtn.disabled = false;
            el.confirmCloneProjectBtn.textContent = previousText;
        }
    }

    // 一键识别：只补全还没有远程地址的项目，已有地址的不覆盖
    async function detectAllGitUrls() {
        const button = el.detectAllGitUrlBtn;
        if (!button || button.disabled) return;
        const label = button.querySelector("span");
        const previousText = label ? label.textContent : "";
        button.disabled = true;
        if (label) label.textContent = "识别中…";
        try {
            const json = await api("/projects/detect-git-all", { method: "POST" });
            const updated = Array.isArray(json.updated) ? json.updated.length : 0;
            const skipped = Array.isArray(json.skipped) ? json.skipped.length : 0;
            const failed = Array.isArray(json.failed) ? json.failed.length : 0;
            const parts = [`已识别 ${updated} 个项目`];
            if (skipped) parts.push(`跳过 ${skipped} 个已有地址`);
            if (failed) parts.push(`${failed} 个未识别到`);
            showToast(parts.join("，"), failed ? "warning" : "success");
            if (updated) await loadProjects();
        } catch (error) {
            handleActionError(error, "识别远程地址失败");
        } finally {
            button.disabled = false;
            if (label) label.textContent = previousText;
        }
    }

    // ---------- 项目导出 / 导入 ----------
    function exportFileName(date = new Date()) {
        const pad = (value) => String(value).padStart(2, "0");
        return `gitstatus-projects-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
    }

    async function exportProjects() {
        const previousText = el.exportProjectsBtn.textContent;
        el.exportProjectsBtn.disabled = true;
        el.exportProjectsBtn.textContent = "导出中…";
        try {
            const response = await Auth.apiFetch("/projects/export");
            if (!response.ok) {
                const json = await Auth.parseJson(response);
                const error = new Error(json.message || `导出失败（${response.status}）`);
                error.status = response.status;
                throw error;
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = exportFileName();
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast("项目信息已导出");
        } catch (error) {
            handleActionError(error, "导出项目失败");
        } finally {
            el.exportProjectsBtn.disabled = false;
            el.exportProjectsBtn.textContent = previousText;
        }
    }

    function setImportError(message) {
        if (!message) {
            el.importProjectsError.textContent = "";
            el.importProjectsError.classList.add("hidden");
            return;
        }
        el.importProjectsError.textContent = message;
        el.importProjectsError.classList.remove("hidden");
    }

    function openImportProjectsModal() {
        state.pendingImport = null;
        el.importProjectsFile.value = "";
        el.importFileName.value = "";
        el.importTargetDir.value = "";
        el.importProjectsSummary.textContent = "导出文件包含项目地址、分类、远程地址、启动与运行命令以及项目介绍";
        setImportError("");
        el.importProjectsModal.classList.add("is-open");
        el.importProjectsModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        window.setTimeout(() => el.pickImportFileBtn.focus(), 40);
    }

    function closeImportProjectsModal() {
        el.importProjectsModal.classList.remove("is-open");
        el.importProjectsModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        state.pendingImport = null;
    }

    async function handleImportFileChange() {
        const file = el.importProjectsFile.files && el.importProjectsFile.files[0];
        if (!file) return;
        el.importFileName.value = file.name;
        setImportError("");
        try {
            const payload = JSON.parse(await file.text());
            if (!payload || payload.format !== "gitstatus-projects") {
                throw new Error("不是由 GitStatus 导出的项目文件");
            }
            const projects = Array.isArray(payload.projects) ? payload.projects : [];
            if (!projects.length) throw new Error("导入文件里没有项目");
            const folders = Array.isArray(payload.folders) ? payload.folders : [];
            const exportedAt = payload.exportedAt ? `，导出于 ${payload.exportedAt}` : "";
            const baseDir = payload.baseDir ? `，原根目录 ${payload.baseDir}` : "";
            state.pendingImport = payload;
            el.importProjectsSummary.textContent = `共 ${projects.length} 个项目、${folders.length} 个文件夹${exportedAt}${baseDir}`;
        } catch (error) {
            state.pendingImport = null;
            el.importProjectsSummary.textContent = "导出文件包含项目地址、分类、远程地址、启动与运行命令以及项目介绍";
            setImportError(
                error instanceof SyntaxError ? "文件不是有效的 JSON" : error.message || "读取导入文件失败"
            );
        }
    }

    async function submitImportProjects(event) {
        event.preventDefault();
        if (!state.pendingImport) {
            setImportError("请先选择导出的 JSON 文件");
            return;
        }
        setImportError("");
        const previousText = el.confirmImportProjectsBtn.textContent;
        el.confirmImportProjectsBtn.disabled = true;
        el.cancelImportProjectsBtn.disabled = true;
        el.confirmImportProjectsBtn.textContent = "导入中…";
        try {
            const json = await api("/projects/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    data: state.pendingImport,
                    baseDir: el.importTargetDir.value.trim(),
                }),
            });
            closeImportProjectsModal();
            const skipped = Array.isArray(json.skipped) ? json.skipped : [];
            const failed = Array.isArray(json.failed) ? json.failed : [];
            const missing = Array.isArray(json.missing) ? json.missing : [];
            const parts = [`已导入 ${json.created || 0} 个项目`];
            if (skipped.length) parts.push(`跳过 ${skipped.length} 个已存在`);
            if (failed.length) parts.push(`失败 ${failed.length} 个`);
            showToast(parts.join("，"), failed.length ? "warning" : "success");
            if (failed.length) {
                showToast(failed[0].message || "部分项目导入失败", "error");
            }
            if (missing.length) {
                showToast(`${missing.length} 个项目目录在本机还不存在，可用「拉取项目」克隆后再启动`, "warning");
            }
            await loadProjects();
        } catch (error) {
            setImportError(error.message || "导入项目失败");
        } finally {
            el.confirmImportProjectsBtn.disabled = false;
            el.cancelImportProjectsBtn.disabled = false;
            el.confirmImportProjectsBtn.textContent = previousText;
        }
    }

    async function saveProject(event) {
        event.preventDefault();
        const projectPath = el.projectPath.value.trim();
        const name = el.projectName.value.trim();
        const startCommand = el.projectStartCommand.value.trim();
        const commands = collectRunCommands();
        const intro = el.projectIntro.value.trim();
        const links = collectProjectLinks();
        const editingProject = state.editingId ? projectById(state.editingId) : null;
        const launchLocked = Boolean(editingProject) && ACTIVE_STATUSES.includes(editingProject.status);
        if (!projectPath) {
            el.projectError.textContent = "请输入项目地址";
            el.projectError.classList.remove("hidden");
            return;
        }
        const invalidLink = links.find((item) => !/^https?:\/\//i.test(item.url));
        if (invalidLink) {
            el.projectError.textContent = `项目地址需以 http:// 或 https:// 开头：${invalidLink.url}`;
            el.projectError.classList.remove("hidden");
            return;
        }
        el.projectError.classList.add("hidden");
        el.saveProjectBtn.disabled = true;
        const previousText = el.saveProjectBtn.textContent;
        el.saveProjectBtn.textContent = "保存中…";
        const payload = {
            name,
            folder: el.projectFolder.value.trim(),
            intro,
            links,
            gitUrl: el.projectGitUrl.value.trim(),
        };
        // 运行中的项目不提交启动配置，避免后端判定为修改启动命令
        if (!launchLocked) {
            Object.assign(payload, {
                path: projectPath,
                type: el.projectType.value,
                startCommand,
                commands,
            });
        }
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

    function openFolderModal(folder = null) {
        state.editingFolderName = folder?.name || null;
        el.folderModalKicker.textContent = folder ? "Edit Folder" : "New Folder";
        el.folderModalTitle.textContent = folder ? "文件夹设置" : "新建文件夹";
        el.folderModalHint.textContent = folder
            ? "可以修改文件夹名称和路径，项目会跟随文件夹移动"
            : "给文件夹设置一个名称和可选的项目根路径";
        el.saveFolderBtn.textContent = folder ? "保存设置" : "新建文件夹";
        el.folderName.value = folder?.name || "";
        el.folderPath.value = folder?.path || "";
        el.folderError.textContent = "";
        el.folderError.classList.add("hidden");
        el.folderModal.classList.add("is-open");
        el.folderModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        window.setTimeout(() => el.folderName.focus(), 40);
    }

    function closeFolderModal() {
        el.folderModal.classList.remove("is-open");
        el.folderModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        state.editingFolderName = null;
    }

    async function saveFolder(event) {
        event.preventDefault();
        const name = el.folderName.value.trim();
        if (!name) {
            el.folderError.textContent = "请输入文件夹名称";
            el.folderError.classList.remove("hidden");
            return;
        }
        el.folderError.classList.add("hidden");
        el.saveFolderBtn.disabled = true;
        const previousText = el.saveFolderBtn.textContent;
        el.saveFolderBtn.textContent = "保存中…";
        const editing = state.editingFolderName;
        const payload = {
            name: editing || name,
            path: el.folderPath.value.trim(),
        };
        if (editing) payload.newName = name;
        try {
            await api("/projects/folders", {
                method: editing ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            closeFolderModal();
            await loadProjects();
            showToast(editing ? "文件夹已更新" : "文件夹已创建");
        } catch (error) {
            el.folderError.textContent = error.message || "保存文件夹失败";
            el.folderError.classList.remove("hidden");
        } finally {
            el.saveFolderBtn.disabled = false;
            el.saveFolderBtn.textContent = previousText;
        }
    }

    function openPortModal() {
        el.portError.classList.add("hidden");
        el.portModal.classList.add("is-open");
        el.portModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        window.setTimeout(() => el.portInput.focus(), 40);
    }

    function closePortModal() {
        el.portModal.classList.remove("is-open");
        el.portModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
    }

    function showPortError(message) {
        el.portError.textContent = message;
        el.portError.classList.remove("hidden");
    }

    function renderPortUsage(connections, port) {
        el.portError.classList.add("hidden");
        if (!Array.isArray(connections) || connections.length === 0) {
            el.portResult.innerHTML = `<p class="port-empty">端口 ${port} 当前没有被占用</p>`;
            return;
        }
        el.portResult.innerHTML = `<div class="port-list">${connections.map((item) => {
            const processName = escapeHtml(item.processName || "未知进程");
            const pid = Number(item.pid) || 0;
            const detail = [`PID ${pid}`, item.protocol, item.localAddress, item.state]
                .filter(Boolean)
                .map((value) => escapeHtml(value))
                .join(" · ");
            return `<div class="port-row">
                <div class="port-row-main">
                    <span class="port-row-title" title="${processName}">${processName}</span>
                    <span class="port-row-meta">${detail}</span>
                </div>
                <button class="btn btn-sm btn-danger" type="button" data-port-kill="${pid}" title="结束 PID ${pid}">结束进程</button>
            </div>`;
        }).join("")}</div>`;
    }

    async function queryPortUsage() {
        const port = Number(el.portInput.value);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            showPortError("请输入 1-65535 之间的端口号");
            return;
        }
        el.portQueryBtn.disabled = true;
        el.portQueryBtn.textContent = "查询中…";
        try {
            const json = await api(`/projects/ports/${port}`);
            state.portUsagePort = port;
            renderPortUsage(json.connections, port);
        } catch (error) {
            showPortError(error.message || "查询端口占用失败");
        } finally {
            el.portQueryBtn.disabled = false;
            el.portQueryBtn.textContent = "查询";
        }
    }

    async function killPortProcess(pid) {
        const port = state.portUsagePort;
        if (!port || !Number.isInteger(pid) || pid <= 0) return;
        const button = el.portResult.querySelector(`[data-port-kill="${pid}"]`);
        const name = button?.closest(".port-row")?.querySelector(".port-row-title")?.textContent || "该进程";
        if (!window.confirm(`确定结束「${name}」(PID ${pid}) 吗？进程会被立即终止。`)) return;
        if (button) button.disabled = true;
        try {
            const json = await api(`/projects/ports/${port}/kill`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pid }),
            });
            showToast(json.message || "已结束进程");
            await queryPortUsage();
        } catch (error) {
            showPortError(error.message || "结束进程失败");
            if (button) button.disabled = false;
        }
    }

    function updateOneShotButton() {
        const count = state.oneShotIds.length;
        el.oneShotStartBtn.title = count
            ? `一键启动已配置的 ${count} 个项目`
            : "一键启动（尚未配置，点击先配置）";
        el.oneShotStartBtn.classList.toggle("is-empty", count === 0);
    }

    function updateOneShotCount() {
        const count = el.oneShotList.querySelectorAll("[data-oneshot-id]:checked").length;
        el.oneShotCount.textContent = `已选 ${count} 个`;
    }

    function renderOneShotList() {
        if (state.projects.length === 0) {
            el.oneShotList.innerHTML = '<p class="oneshot-empty">还没有项目，请先添加项目</p>';
            updateOneShotCount();
            return;
        }
        const selected = new Set(state.oneShotIds);
        el.oneShotList.innerHTML = state.projects.map((project) => {
            const id = Number(project.id);
            const name = escapeHtml(project.name || "未命名项目");
            const folder = String(project.folder || "").trim() || "未分组";
            const statusLabel = statusMeta(project.status).label;
            return `<label class="oneshot-row">
                <input type="checkbox" data-oneshot-id="${id}"${selected.has(id) ? " checked" : ""}>
                <span class="oneshot-row-main">
                    <span class="oneshot-row-name" title="${name}">${name}</span>
                    <span class="oneshot-row-meta">${escapeHtml(folder)} · ${escapeHtml(statusLabel)}</span>
                </span>
            </label>`;
        }).join("");
        updateOneShotCount();
    }

    function openOneShotModal() {
        el.oneShotError.classList.add("hidden");
        renderOneShotList();
        el.oneShotModal.classList.add("is-open");
        el.oneShotModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
    }

    function closeOneShotModal() {
        el.oneShotModal.classList.remove("is-open");
        el.oneShotModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
    }

    // 一键启动配置同步到后端，桌面端托盘“一键启动后台”读取的就是这份数据
    async function syncOneShotToServer(ids) {
        try {
            const json = await api("/projects/quickstart", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectIds: ids }),
            });
            // 后端会过滤掉已不存在的项目，以它返回的列表为准，避免本地镜像与后端漂移
            const saved = Array.isArray(json.projectIds)
                ? json.projectIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
                : [];
            if (saved.length !== ids.length) {
                state.oneShotIds = saved;
                persistOneShotIds(saved);
            }
        } catch {
            /* 后端不可用时只保留本地配置 */
        }
    }

    async function syncOneShotFromServer() {
        try {
            const json = await api("/projects/quickstart");
            const ids = Array.isArray(json.projectIds)
                ? json.projectIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
                : [];
            if (ids.length > 0 || state.oneShotIds.length === 0) {
                state.oneShotIds = ids;
                persistOneShotIds(ids);
                updateOneShotButton();
                return;
            }
            await syncOneShotToServer(state.oneShotIds);
        } catch {
            /* 忽略：本地配置仍可用 */
        }
    }

    function saveOneShotConfig() {
        const ids = Array.from(el.oneShotList.querySelectorAll("[data-oneshot-id]:checked"))
            .map((node) => Number(node.dataset.oneshotId))
            .filter((id) => Number.isInteger(id) && id > 0);
        state.oneShotIds = ids;
        persistOneShotIds(ids);
        void syncOneShotToServer(ids).then(() => updateOneShotButton());
        updateOneShotButton();
        closeOneShotModal();
        showToast(ids.length ? `已保存 ${ids.length} 个一键启动项目` : "已清空一键启动配置");
    }

    async function startOneShotProjects() {
        if (state.oneShotIds.length === 0) {
            showToast("还没有配置一键启动项目", "warning");
            openOneShotModal();
            return;
        }
        const targets = state.oneShotIds.map((id) => projectById(id)).filter(Boolean);
        if (targets.length === 0) {
            showToast("配置的项目已不存在，请重新配置", "warning");
            openOneShotModal();
            return;
        }
        const pending = targets.filter((project) => !ACTIVE_STATUSES.includes(project.status));
        if (pending.length === 0) {
            showToast("配置的项目都已在运行或启动中", "warning");
            return;
        }
        const previousTitle = el.oneShotStartBtn.title;
        el.oneShotStartBtn.disabled = true;
        el.oneShotStartBtn.title = "正在启动…";
        let started = 0;
        let failed = 0;
        // 顺序启动，避免同时拉起多个服务时端口冲突
        for (const project of pending) {
            try {
                await api(`/projects/${project.id}/start`, { method: "POST" });
                started += 1;
            } catch (error) {
                if (error.status !== 409) failed += 1;
            }
        }
        el.oneShotStartBtn.disabled = false;
        el.oneShotStartBtn.title = previousTitle;
        await loadProjects();
        void loadUsage();
        if (failed > 0) showToast(`一键启动完成：成功 ${started} 个，失败 ${failed} 个`, "warning");
        else showToast(`已一键启动 ${started} 个项目`);
    }

    function askConfirm({ title = "确认操作", text = "", confirmText = "确定" } = {}) {
        if (confirmResolver) settleConfirm(false);
        el.confirmModalTitle.textContent = title;
        el.confirmModalText.textContent = text;
        el.confirmActionBtn.textContent = confirmText;
        el.confirmModal.classList.add("is-open");
        el.confirmModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        window.setTimeout(() => el.confirmActionBtn.focus(), 30);
        return new Promise((resolve) => {
            confirmResolver = resolve;
        });
    }

    function settleConfirm(result) {
        el.confirmModal.classList.remove("is-open");
        el.confirmModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        const resolve = confirmResolver;
        confirmResolver = null;
        if (resolve) resolve(Boolean(result));
    }

    async function openFolderEditor(name, editor) {
        try {
            const json = await api("/projects/folders/open-editor", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, editor }),
            });
            showToast(json.message || "已打开文件夹");
        } catch (error) {
            handleActionError(error, "打开文件夹失败");
        }
    }

    async function reorderFolder(source, target, after) {
        if (!source || !target || source === target) return;
        const names = folderNamesInOrder();
        if (!names.includes(source) || !names.includes(target)) return;
        const next = names.filter((name) => name !== source);
        const targetIndex = next.indexOf(target);
        if (targetIndex < 0) return;
        next.splice(targetIndex + (after ? 1 : 0), 0, source);
        next.forEach((name, index) => {
            const folder = state.folders.get(name);
            if (folder) folder.sortOrder = (index + 1) * 10;
        });
        renderProjects();
        try {
            await api("/projects/folders/reorder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ names: next }),
            });
            await loadProjects();
            showToast("文件夹顺序已更新");
        } catch (error) {
            await loadProjects();
            handleActionError(error, "更新文件夹顺序失败");
        }
    }

    async function moveProjectToFolder(projectId, folder) {
        const project = projectById(projectId);
        if (!project || String(project.folder || "") === folder) return;
        const previousFolder = project.folder || "";
        project.folder = folder;
        renderProjects();
        try {
            await api(`/projects/${projectId}/folder`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ folder }),
            });
            await loadProjects();
            showToast(folder ? `已移动到「${folder}」` : "已移出文件夹");
        } catch (error) {
            project.folder = previousFolder;
            renderProjects();
            handleActionError(error, "移动项目失败");
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
            state.folders = new Map(
                (Array.isArray(json.folders) ? json.folders : [])
                    .filter((folder) => folder && typeof folder.name === "string")
                    .map((folder) => [folder.name, folder])
            );
            renderProjects();
            void syncOneShotFromServer();
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
                    powershell: json.editors.powershell !== false,
                    cmd: json.editors.cmd !== false,
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
        el.projectsMoreBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            setToolbarMenuOpen(!el.projectsToolbarMore.classList.contains("is-open"));
        });
        // 点菜单项、点菜单外部或按 Esc 都收起，避免遮盖下方内容
        el.projectsMoreDropdown.addEventListener("click", (event) => {
            if (event.target.closest("button")) setToolbarMenuOpen(false);
        });
        document.addEventListener("click", (event) => {
            if (el.projectsToolbarMore.contains(event.target)) return;
            setToolbarMenuOpen(false);
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") setToolbarMenuOpen(false);
        });
        el.usageCollapseBtn?.addEventListener("click", () => setUsageCollapsed(true));
        el.usageRailToggle?.addEventListener("click", () => setUsageCollapsed(false));
        // 启动进程列表：点击卡片定位到对应项目并展开菜单
        el.usageList?.addEventListener("click", (event) => {
            const item = event.target.closest("[data-usage-project]");
            if (!item) return;
            const projectId = Number(item.dataset.usageProject);
            if (Number.isFinite(projectId)) focusProjectCard(projectId);
        });
        el.usageList?.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            const item = event.target.closest("[data-usage-project]");
            if (!item) return;
            event.preventDefault();
            const projectId = Number(item.dataset.usageProject);
            if (Number.isFinite(projectId)) focusProjectCard(projectId);
        });
        document.addEventListener("visibilitychange", () => {
            if (state.user && document.visibilityState === "visible") void loadUsage();
        });
        el.addProjectBtn.addEventListener("click", () => openProjectModal());
        el.emptyAddProjectBtn.addEventListener("click", () => openProjectModal());
        el.addFolderBtn.addEventListener("click", () => openFolderModal());
        el.cloneProjectBtn.addEventListener("click", () => openCloneProjectModal());
        el.closeCloneProjectModalBtn.addEventListener("click", closeCloneProjectModal);
        el.cancelCloneProjectBtn.addEventListener("click", closeCloneProjectModal);
        el.cloneProjectForm.addEventListener("submit", submitCloneProject);
        el.pickCloneTargetDirBtn.addEventListener("click", () => void pickFolderInto(el.cloneTargetDir, el.pickCloneTargetDirBtn));
        el.exportProjectsBtn.addEventListener("click", () => void exportProjects());
        el.importProjectsBtn.addEventListener("click", openImportProjectsModal);
        el.detectAllGitUrlBtn.addEventListener("click", () => void detectAllGitUrls());
        el.closeImportProjectsModalBtn.addEventListener("click", closeImportProjectsModal);
        el.cancelImportProjectsBtn.addEventListener("click", closeImportProjectsModal);
        el.importProjectsForm.addEventListener("submit", submitImportProjects);
        el.pickImportFileBtn.addEventListener("click", () => el.importProjectsFile.click());
        el.importProjectsFile.addEventListener("change", () => void handleImportFileChange());
        el.pickImportTargetDirBtn.addEventListener("click", () => void pickFolderInto(el.importTargetDir, el.pickImportTargetDirBtn));
        el.importProjectsModal.addEventListener("click", (event) => {
            if (event.target === el.importProjectsModal) closeImportProjectsModal();
        });
        el.closeFolderModalBtn.addEventListener("click", closeFolderModal);
        el.cancelFolderBtn.addEventListener("click", closeFolderModal);
        el.folderForm.addEventListener("submit", saveFolder);
        el.closeProjectModalBtn.addEventListener("click", closeProjectModal);
        el.cancelProjectBtn.addEventListener("click", closeProjectModal);
        el.detectProjectBtn.addEventListener("click", () => void detectProject());
        el.detectGitUrlBtn.addEventListener("click", () => void detectGitUrl());
        el.pickProjectPathBtn.addEventListener("click", () => void pickFolderInto(el.projectPath, el.pickProjectPathBtn));
        el.pickFolderPathBtn.addEventListener("click", () => void pickFolderInto(el.folderPath, el.pickFolderPathBtn));
        el.projectForm.addEventListener("submit", saveProject);

        el.portToolBtn.addEventListener("click", openPortModal);
        el.closePortModalBtn.addEventListener("click", closePortModal);
        el.closePortModalFooterBtn.addEventListener("click", closePortModal);
        el.portModal.addEventListener("click", (event) => {
            if (event.target === el.portModal) closePortModal();
        });
        el.portQueryForm.addEventListener("submit", (event) => {
            event.preventDefault();
            void queryPortUsage();
        });
        el.portResult.addEventListener("click", (event) => {
            const button = event.target.closest("[data-port-kill]");
            if (!button) return;
            void killPortProcess(Number(button.dataset.portKill));
        });

        el.oneShotConfigBtn.addEventListener("click", openOneShotModal);
        el.oneShotStartBtn.addEventListener("click", () => void startOneShotProjects());
        el.closeOneShotModalBtn.addEventListener("click", closeOneShotModal);
        el.cancelOneShotBtn.addEventListener("click", closeOneShotModal);
        el.saveOneShotBtn.addEventListener("click", saveOneShotConfig);
        el.oneShotModal.addEventListener("click", (event) => {
            if (event.target === el.oneShotModal) closeOneShotModal();
        });
        el.oneShotList.addEventListener("change", updateOneShotCount);
        el.oneShotSelectAllBtn.addEventListener("click", () => {
            el.oneShotList.querySelectorAll("[data-oneshot-id]").forEach((node) => {
                node.checked = true;
            });
            updateOneShotCount();
        });
        el.oneShotClearBtn.addEventListener("click", () => {
            el.oneShotList.querySelectorAll("[data-oneshot-id]").forEach((node) => {
                node.checked = false;
            });
            updateOneShotCount();
        });

        el.confirmActionBtn.addEventListener("click", () => settleConfirm(true));
        el.cancelConfirmBtn.addEventListener("click", () => settleConfirm(false));
        el.closeConfirmModalBtn.addEventListener("click", () => settleConfirm(false));
        el.confirmModal.addEventListener("click", (event) => {
            if (event.target === el.confirmModal) settleConfirm(false);
        });

        el.projectPath.addEventListener("change", () => {
            if (el.projectName.value.trim()) return;
            const value = el.projectPath.value.trim().replace(/[\\/]+$/, "");
            const base = value.split(/[\\/]/).pop();
            if (base) el.projectName.value = base;
        });

        el.projectModal.addEventListener("click", (event) => {
            if (event.target === el.projectModal) closeProjectModal();
        });
        el.cloneProjectModal.addEventListener("click", (event) => {
            if (event.target === el.cloneProjectModal) closeCloneProjectModal();
        });
        el.folderModal.addEventListener("click", (event) => {
            if (event.target === el.folderModal) closeFolderModal();
        });

        el.toggleAllProjectsBtn.addEventListener("click", () => {
            const collapseAll = state.expandedProjects.size > 0;
            state.expandedProjects.clear();
            if (!collapseAll) {
                state.projects.forEach((project) => state.expandedProjects.add(Number(project.id)));
            }
            renderProjects();
        });

        el.projectGrid.addEventListener("click", (event) => {
            const folderAction = event.target.closest("[data-folder-action]");
            if (folderAction) {
                const section = folderAction.closest("[data-folder]");
                const folderName = section?.dataset.folder || "";
                if (!folderName) return;
                if (folderAction.dataset.folderAction === "settings") {
                    openFolderModal(state.folders.get(folderName) || { name: folderName, path: "" });
                    return;
                }
                if (folderAction.dataset.folderAction === "add-project") {
                    openProjectModal(null, folderName);
                    return;
                }
                if (folderAction.dataset.folderAction === "toggle-open-menu") {
                    const menu = folderAction.closest(".project-open-menu");
                    if (menu) toggleOpenMenu(menu);
                    return;
                }
                if (folderAction.dataset.folderAction === "open") {
                    const editor = folderAction.dataset.editor;
                    if (!editor) return;
                    const fromDropdown = Boolean(folderAction.closest(".project-open-dropdown"));
                    closeOpenMenus();
                    if (fromDropdown && setFolderDefaultEditor(folderName, editor)) {
                        renderProjects();
                    }
                    void openFolderEditor(folderName, editor);
                }
                return;
            }
            const folderToggle = event.target.closest("[data-folder-toggle]");
            if (folderToggle) {
                const section = folderToggle.closest("[data-folder]");
                const key = section?.dataset.folder ?? "";
                if (state.collapsedFolders.has(key)) state.collapsedFolders.delete(key);
                else state.collapsedFolders.add(key);
                persistCollapsedFolders(state.collapsedFolders);
                const nextCollapsed = state.collapsedFolders.has(key);
                section?.classList.toggle("is-collapsed", nextCollapsed);
                folderToggle.setAttribute("aria-expanded", nextCollapsed ? "false" : "true");
                return;
            }
            const button = event.target.closest("[data-action]");
            if (!button) return;
            const card = button.closest("[data-project-id]");
            const projectId = Number(card?.dataset.projectId);
            if (!Number.isInteger(projectId)) return;
            const action = button.dataset.action;
            if (action === "start") void startProject(projectId);
            else if (action === "restart") void restartProject(projectId);
            else if (action === "stop") void stopProject(projectId);
            else if (action === "toggle-run") {
                const project = projectById(projectId);
                if (!project) return;
                if (project.status === "running" || project.status === "starting") {
                    void stopProject(projectId);
                } else if (project.status !== "stopping") {
                    void startProject(projectId);
                }
            }
            else if (action === "terminal") openProjectConsole(projectId);
            else if (action === "toggle-command-picker") {
                togglePicker(button.closest("[data-command-picker]"));
            } else if (action === "select-command") {
                const picker = button.closest("[data-command-picker]");
                const option = button.closest(".project-picker-option");
                const commandId = Number(button.dataset.commandId);
                if (!picker || !option || !Number.isInteger(commandId) || commandId <= 0) return;
                applyPickerSelection(picker, option);
                state.selectedCommands.set(projectId, String(commandId));
                closePickers();
            } else if (action === "toggle-link-picker") {
                togglePicker(button.closest("[data-link-picker]"));
            } else if (action === "select-link") {
                const picker = button.closest("[data-link-picker]");
                const option = button.closest(".project-picker-option");
                const linkId = Number(button.dataset.linkId);
                if (!picker || !option || !Number.isInteger(linkId) || linkId <= 0) return;
                applyPickerSelection(picker, option);
                state.selectedLinks.set(projectId, String(linkId));
                closePickers();
            } else if (action === "open-link") {
                const picker = button.closest("[data-link-picker]");
                const option = button.closest(".project-picker-option");
                const project = projectById(projectId);
                const link = (Array.isArray(project?.links) ? project.links : [])
                    .find((item) => Number(item.id) === Number(button.dataset.linkId));
                if (!link) {
                    showToast("项目地址不存在，请刷新项目", "warning");
                    return;
                }
                if (picker && option) applyPickerSelection(picker, option);
                state.selectedLinks.set(projectId, String(link.id));
                closePickers();
                window.open(link.url, "_blank", "noopener,noreferrer");
            }
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
                const detailsTitle = nextExpanded ? "收起详情" : "展开详情";
                button.setAttribute("title", detailsTitle);
                button.setAttribute("aria-label", detailsTitle);
                button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
                button.classList.toggle("is-expanded", nextExpanded);
                card.classList.toggle("is-expanded", nextExpanded);
                updateCollapseButton();
            } else if (action === "run-command") {
                closePickers();
                void runProjectCommand(projectId, Number(button.dataset.commandId));
            } else if (action === "insight") {
                void openProjectInsight(projectId, button);
            } else if (action === "pull") {
                const project = projectById(projectId);
                if (project) openCloneProjectModal(project);
            } else if (action === "edit") {
                const project = projectById(projectId);
                if (!project) return;
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

        const clearProjectDropHighlights = () => {
            document.querySelectorAll(".project-folder.is-drag-over").forEach((node) => {
                node.classList.remove("is-drag-over", "is-drop-after");
            });
        };

        el.projectGrid.addEventListener("dragstart", (event) => {
            const folderGrip = event.target.closest("[data-folder-grip]");
            if (folderGrip) {
                const section = folderGrip.closest("[data-folder]");
                const folder = section?.dataset.folder || "";
                if (!folder) return;
                state.draggingFolderName = folder;
                state.folderDropAfter = false;
                section.classList.add("is-dragging");
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", `folder:${folder}`);
                }
                return;
            }
            if (event.target.closest("button, a, input, select, textarea")) return;
            const card = event.target.closest("[data-project-id]");
            if (!card) return;
            const projectId = Number(card.dataset.projectId);
            if (!Number.isInteger(projectId)) return;
            state.draggingProjectId = projectId;
            card.classList.add("is-dragging");
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(projectId));
            }
        });

        el.projectGrid.addEventListener("dragend", (event) => {
            const card = event.target.closest("[data-project-id]");
            card?.classList.remove("is-dragging");
            document.querySelectorAll(".project-folder.is-dragging").forEach((node) => {
                node.classList.remove("is-dragging");
            });
            state.draggingProjectId = null;
            state.draggingFolderName = null;
            state.folderDropAfter = false;
            clearProjectDropHighlights();
        });

        el.projectGrid.addEventListener("dragover", (event) => {
            if (!state.draggingProjectId && !state.draggingFolderName) return;
            const section = event.target.closest("[data-folder]");
            if (!section) return;
            if (state.draggingFolderName && !section.dataset.folder) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            const rect = section.getBoundingClientRect();
            const after = Boolean(state.draggingFolderName) && event.clientY > rect.top + rect.height / 2;
            state.folderDropAfter = after;
            if (!section.classList.contains("is-drag-over")) {
                clearProjectDropHighlights();
                section.classList.add("is-drag-over");
            }
            section.classList.toggle("is-drop-after", after);
        });

        el.projectGrid.addEventListener("dragleave", (event) => {
            const section = event.target.closest("[data-folder]");
            if (section && !section.contains(event.relatedTarget)) {
                section.classList.remove("is-drag-over", "is-drop-after");
            }
        });

        el.projectGrid.addEventListener("drop", (event) => {
            const section = event.target.closest("[data-folder]");
            if (!section) return;
            const folder = section.dataset.folder || "";
            if (state.draggingFolderName) {
                if (!folder) return;
                event.preventDefault();
                const source = state.draggingFolderName;
                const after = state.folderDropAfter;
                state.draggingFolderName = null;
                state.folderDropAfter = false;
                clearProjectDropHighlights();
                void reorderFolder(source, folder, after);
                return;
            }
            if (!state.draggingProjectId) return;
            event.preventDefault();
            const projectId = state.draggingProjectId;
            state.draggingProjectId = null;
            clearProjectDropHighlights();
            if (section.classList.contains("is-collapsed")) {
                state.collapsedFolders.delete(folder);
                persistCollapsedFolders(state.collapsedFolders);
                section.classList.remove("is-collapsed");
                section.querySelector("[data-folder-toggle]")?.setAttribute("aria-expanded", "true");
            }
            void moveProjectToFolder(projectId, folder);
        });

        el.addRunCommandBtn.addEventListener("click", () => addRunCommandRow());
        el.runCommandRows.addEventListener("click", (event) => {
            const button = event.target.closest("[data-remove-run-command]");
            if (!button) return;
            button.closest("[data-run-command-row]")?.remove();
        });

        el.addProjectLinkBtn.addEventListener("click", () => addProjectLinkRow());
        el.projectLinkRows.addEventListener("click", (event) => {
            const button = event.target.closest("[data-remove-project-link]");
            if (!button) return;
            button.closest("[data-project-link-row]")?.remove();
        });

        el.terminalStopRunBtn.addEventListener("click", () => void stopActiveRun());
        el.terminalTabs.addEventListener("click", (event) => {
            const closeBtn = event.target.closest("[data-terminal-tab-close]");
            if (closeBtn) {
                closeTerminalTab(closeBtn.dataset.terminalTabClose);
                return;
            }
            const selectBtn = event.target.closest("[data-terminal-tab-select]");
            if (selectBtn) activateTerminal(selectBtn.dataset.terminalTabSelect);
        });
        el.terminalClearBtn.addEventListener("click", () => {
            el.terminalLog.innerHTML = '<span class="terminal-placeholder">已清空当前显示，等待新的终端输出…</span>';
        });
        el.terminalCloseBtn.addEventListener("click", closeTerminal);

        document.addEventListener("click", (event) => {
            if (!event.target.closest(".project-picker")) closePickers();
            if (event.target.closest(".project-open-menu")) return;
            closeOpenMenus();
        });

        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            if (el.confirmModal.classList.contains("is-open")) {
                settleConfirm(false);
            } else if (document.querySelector(".project-picker.is-open")) {
                closePickers();
            } else if (document.querySelector(".project-open-menu.is-open")) {
                closeOpenMenus();
            } else if (el.projectModal.classList.contains("is-open")) {
                closeProjectModal();
            } else if (el.folderModal.classList.contains("is-open")) {
                closeFolderModal();
            } else if (el.portModal.classList.contains("is-open")) {
                closePortModal();
            } else if (el.oneShotModal.classList.contains("is-open")) {
                closeOneShotModal();
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
        updateOneShotButton();
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
