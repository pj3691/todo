/* ============================================================
   GitStatus 数据共享页
   依赖 auth-client.js 提供的 GitStatusAuth
   ============================================================ */
(function () {
    "use strict";

    const Auth = window.GitStatusAuth;
    const PERMISSION_LABELS = { readonly: "只读", write: "可编辑" };
    const SCOPE_LABELS = { inbox: "收件箱", category: "文件夹" };

    const state = {
        user: null,
        scope: "received",
        shares: [],
        options: null,
        loading: false,
        isAdmin: false,
    };

    const el = {
        authPanel: document.getElementById("authPanel"),
        loginForm: document.getElementById("loginForm"),
        loginUsername: document.getElementById("loginUsername"),
        loginPassword: document.getElementById("loginPassword"),
        loginError: document.getElementById("loginError"),
        loginSubmitBtn: document.getElementById("loginSubmitBtn"),
        pageBody: document.getElementById("pageBody"),
        listTitle: document.getElementById("listTitle"),
        totalCount: document.getElementById("totalCount"),
        shareTableBody: document.getElementById("shareTableBody"),
        listEmpty: document.getElementById("listEmpty"),
        reloadBtn: document.getElementById("reloadBtn"),
        createShareBtn: document.getElementById("createShareBtn"),
        tabs: Array.from(document.querySelectorAll(".share-tab")),
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
        shareModal: document.getElementById("shareModal"),
        shareForm: document.getElementById("shareForm"),
        scopeSelect: document.getElementById("scopeSelect"),
        granteeSelect: document.getElementById("granteeSelect"),
        permissionSelect: document.getElementById("permissionSelect"),
        shareError: document.getElementById("shareError"),
        closeShareBtn: document.getElementById("closeShareBtn"),
        cancelShareBtn: document.getElementById("cancelShareBtn"),
        saveShareBtn: document.getElementById("saveShareBtn"),
        toastContainer: document.getElementById("toastContainer"),
    };

    const escapeHtml = (value) =>
        String(value ?? "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        }[char]));

    function showToast(message, type = "success") {
        if (!el.toastContainer) return;
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span class="toast-icon">${type === "error" ? "!" : "✓"}</span><span>${escapeHtml(message)}</span>`;
        el.toastContainer.appendChild(toast);
        window.setTimeout(() => {
            toast.classList.add("is-leaving");
            window.setTimeout(() => toast.remove(), 220);
        }, 2600);
    }

    function humanizeAuthMessage(message) {
        const map = {
            "account pending approval; please wait for an administrator to review it": "账号正在等待管理员审核，暂时无法登录",
            "account is disabled": "账号已被禁用，请联系管理员",
        };
        return map[message] || message;
    }

    function showLoginError(message) {
        el.loginError.textContent = message;
        el.loginError.classList.remove("hidden");
    }

    function clearLoginError() {
        el.loginError.textContent = "";
        el.loginError.classList.add("hidden");
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
        el.userName.textContent = user.username;
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
                window.location.href = "/pages/todo.html";
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
        el.userLoginBtn.addEventListener("click", () => {
            window.location.href = "/pages/todo.html";
        });
        el.logoutBtn.addEventListener("click", () => {
            Auth.clearSession();
            window.location.reload();
        });
    }

    function scopeLabel(share) {
        if (share.scope === "inbox") return "收件箱";
        return share.categoryPath || share.categoryName || "文件夹已删除";
    }

    function canManage(share) {
        return Boolean(state.user) && (share.ownerId === state.user.id || state.isAdmin);
    }

    function renderRows() {
        el.totalCount.textContent = String(state.shares.length);
        el.listEmpty.classList.toggle("hidden", state.shares.length > 0);
        if (state.shares.length === 0) {
            el.shareTableBody.innerHTML = "";
            return;
        }
        el.shareTableBody.innerHTML = state.shares.map((share) => {
            const manageable = canManage(share);
            const permissionControl = manageable
                ? `<select class="select-input" data-share-permission="${share.id}" aria-label="修改权限">
                       <option value="readonly"${share.permission === "readonly" ? " selected" : ""}>只读</option>
                       <option value="write"${share.permission === "write" ? " selected" : ""}>可编辑</option>
                   </select>
                   <button class="btn btn-sm btn-danger" type="button" data-share-delete="${share.id}">取消共享</button>`
                : `<span class="badge">${PERMISSION_LABELS[share.permission] || share.permission}</span>`;
            return `<tr>
                <td>
                    <div class="scope-cell">
                        <span class="scope-name">${escapeHtml(scopeLabel(share))}</span>
                        <span class="scope-type">${SCOPE_LABELS[share.scope] || share.scope}</span>
                    </div>
                </td>
                <td>${escapeHtml(share.ownerUsername)}</td>
                <td>${escapeHtml(share.granteeUsername)}</td>
                <td><span class="badge">${PERMISSION_LABELS[share.permission] || share.permission}</span></td>
                <td>${escapeHtml(share.updatedAt || share.createdAt || "")}</td>
                <td><div class="row-actions">${permissionControl}</div></td>
            </tr>`;
        }).join("");
    }

    function setScope(scope) {
        state.scope = scope;
        const titles = {
            received: "共享给我的",
            mine: "我共享出去的",
            all: "全部共享",
        };
        el.listTitle.textContent = titles[scope] || "共享列表";
        el.tabs.forEach((tab) => {
            const active = tab.dataset.scope === scope;
            tab.classList.toggle("active", active);
            tab.setAttribute("aria-selected", active ? "true" : "false");
        });
        loadShares();
    }

    let loadSeq = 0;

    async function loadShares() {
        if (!state.user) return;
        const seq = ++loadSeq;
        el.shareTableBody.innerHTML = `<tr><td colspan="6" class="table-empty">加载中…</td></tr>`;
        try {
            const res = await Auth.apiFetch(`/todo-shares?scope=${encodeURIComponent(state.scope)}`);
            const json = await Auth.parseJson(res);
            if (seq !== loadSeq) return;
            if (!res.ok || !json.res) {
                throw new Error(json.message || `加载失败（${res.status}）`);
            }
            state.shares = Array.isArray(json.shares) ? json.shares : [];
            renderRows();
        } catch (error) {
            if (seq !== loadSeq) return;
            el.shareTableBody.innerHTML = "";
            el.listEmpty.classList.remove("hidden");
            el.listEmpty.textContent = error.status === 401 ? "登录已过期，请重新登录" : (error.message || "加载失败");
            if (error.status === 401) {
                state.user = null;
                renderUserUi();
                showAuthPanel();
            }
        }
    }

    async function loadOptions(force = false) {
        if (state.options && !force) return state.options;
        const res = await Auth.apiFetch("/todo-shares/options");
        const json = await Auth.parseJson(res);
        if (!res.ok || !json.res) {
            throw new Error(json.message || "加载共享选项失败");
        }
        state.options = json;
        state.isAdmin = Boolean(json.isAdmin);
        return state.options;
    }

    function showAuthPanel() {
        el.authPanel.classList.remove("hidden");
        el.pageBody.classList.add("hidden");
        el.loginUsername.focus();
    }

    function showPage() {
        el.authPanel.classList.add("hidden");
        el.pageBody.classList.remove("hidden");
    }

    function showShareError(message) {
        el.shareError.textContent = message;
        el.shareError.classList.remove("hidden");
    }

    function clearShareError() {
        el.shareError.textContent = "";
        el.shareError.classList.add("hidden");
    }

    function closeShareModal() {
        el.shareModal.classList.remove("is-open");
        el.shareModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        el.saveShareBtn.disabled = false;
    }

    function openShareModal() {
        if (!state.user) return;
        if (state.user.role === "readonly") {
            showToast("只读账号不能创建共享", "error");
            return;
        }
        clearShareError();
        el.scopeSelect.innerHTML = "";
        el.granteeSelect.innerHTML = "";
        el.shareModal.classList.add("is-open");
        el.shareModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");

        loadOptions()
            .then((options) => {
                const scopeOptions = [];
                scopeOptions.push(
                    `<option value="inbox">收件箱（${Number(options.inboxCount || 0)} 个任务）</option>`,
                );
                for (const category of options.categories || []) {
                    scopeOptions.push(
                        `<option value="category:${category.id}">${escapeHtml(category.path || category.name)}（${Number(category.taskCount || 0)} 个任务）</option>`,
                    );
                }
                el.scopeSelect.innerHTML = scopeOptions.join("");

                const users = options.users || [];
                if (users.length === 0) {
                    el.granteeSelect.innerHTML = `<option value="">暂无可共享的用户</option>`;
                    el.granteeSelect.disabled = true;
                    el.saveShareBtn.disabled = true;
                } else {
                    el.granteeSelect.disabled = false;
                    el.saveShareBtn.disabled = false;
                    el.granteeSelect.innerHTML = users
                        .map((user) => `<option value="${user.id}">${escapeHtml(user.username)}（${escapeHtml(Auth.roleLabel(user.role))}）</option>`)
                        .join("");
                }
            })
            .catch((error) => {
                showShareError(error.message || "加载共享选项失败");
            });
    }

    async function submitShare(event) {
        event.preventDefault();
        clearShareError();
        const scopeValue = String(el.scopeSelect.value || "");
        const granteeId = Number(el.granteeSelect.value);
        if (!scopeValue || !Number.isInteger(granteeId) || granteeId <= 0) {
            showShareError("请选择数据范围和被共享用户");
            return;
        }
        const isInbox = scopeValue === "inbox";
        const categoryId = isInbox ? null : Number(scopeValue.split(":")[1]);
        if (!isInbox && (!Number.isInteger(categoryId) || categoryId <= 0)) {
            showShareError("文件夹无效");
            return;
        }
        const body = {
            granteeId,
            scope: isInbox ? "inbox" : "category",
            permission: el.permissionSelect.value,
        };
        if (categoryId) body.categoryId = categoryId;

        el.saveShareBtn.disabled = true;
        try {
            const res = await Auth.apiFetch("/todo-shares", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showShareError(json.message || `创建失败（${res.status}）`);
                return;
            }
            closeShareModal();
            showToast("共享已保存", "success");
            state.options = null;
            if (state.scope !== "mine" && state.scope !== "received") {
                setScope("mine");
            } else {
                loadShares();
            }
        } catch (error) {
            showShareError(error.message || "创建共享失败");
        } finally {
            el.saveShareBtn.disabled = false;
        }
    }

    async function updatePermission(shareId, permission) {
        try {
            const res = await Auth.apiFetch(`/todo-shares/${shareId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ permission }),
            });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showToast(json.message || "修改权限失败", "error");
                loadShares();
                return;
            }
            showToast("权限已更新", "success");
            const target = state.shares.find((item) => item.id === shareId);
            if (target) target.permission = permission;
        } catch (error) {
            showToast(error.message || "修改权限失败", "error");
        }
    }

    async function removeShare(shareId) {
        const target = state.shares.find((item) => item.id === shareId);
        const label = target ? scopeLabel(target) : "该共享";
        if (!window.confirm(`确定取消「${label}」的共享吗？`)) return;
        try {
            const res = await Auth.apiFetch(`/todo-shares/${shareId}`, { method: "DELETE" });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showToast(json.message || "取消共享失败", "error");
                return;
            }
            state.shares = state.shares.filter((item) => item.id !== shareId);
            renderRows();
            showToast("已取消共享", "success");
        } catch (error) {
            showToast(error.message || "取消共享失败", "error");
        }
    }

    function bindEvents() {
        el.tabs.forEach((tab) => {
            tab.addEventListener("click", () => setScope(tab.dataset.scope));
        });
        el.reloadBtn.addEventListener("click", () => {
            state.options = null;
            loadShares();
        });
        el.createShareBtn.addEventListener("click", openShareModal);
        el.closeShareBtn.addEventListener("click", closeShareModal);
        el.cancelShareBtn.addEventListener("click", closeShareModal);
        el.shareModal.addEventListener("click", (event) => {
            if (event.target === el.shareModal) closeShareModal();
        });
        el.shareForm.addEventListener("submit", submitShare);
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && el.shareModal.classList.contains("is-open")) {
                closeShareModal();
            }
        });
        el.shareTableBody.addEventListener("change", (event) => {
            const select = event.target.closest("[data-share-permission]");
            if (!select) return;
            updatePermission(Number(select.dataset.sharePermission), select.value);
        });
        el.shareTableBody.addEventListener("click", (event) => {
            const button = event.target.closest("[data-share-delete]");
            if (!button) return;
            removeShare(Number(button.dataset.shareDelete));
        });
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
    }

    async function bootstrap() {
        bindEvents();
        bindUserMenu();
        state.user = await Auth.loadCurrentUser();
        renderUserUi();
        if (!state.user) {
            showAuthPanel();
            return;
        }
        showPage();
        try {
            await loadOptions();
        } catch (error) {
            if (error.status === 401) {
                state.user = null;
                renderUserUi();
                showAuthPanel();
                return;
            }
        }
        const allTab = el.tabs.find((tab) => tab.dataset.scope === "all");
        if (allTab) allTab.classList.toggle("hidden", !state.isAdmin);
        el.createShareBtn.classList.toggle("hidden", state.user.role === "readonly");
        setScope("received");
    }

    bootstrap();
})();
