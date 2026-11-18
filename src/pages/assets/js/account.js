/* ============================================================
   GitStatus 账号管理页
   依赖 auth-client.js 提供的 GitStatusAuth
   ============================================================ */
(function () {
    "use strict";

    const Auth = window.GitStatusAuth;
    const state = {
        user: null,
        users: [],
        total: 0,
        page: 1,
        pageSize: 20,
        search: "",
        role: "",
        status: "",
        editingId: null,
        transferSource: null,
    };

    const el = {
        userMenu: document.getElementById("userMenu"),
        userTrigger: document.getElementById("userTrigger"),
        userAvatar: document.getElementById("userAvatar"),
        userName: document.getElementById("userName"),
        userRole: document.getElementById("userRole"),
        popoverStatus: document.getElementById("popoverStatus"),
        popoverLastLogin: document.getElementById("popoverLastLogin"),
        accountManageLink: document.getElementById("accountManageLink"),
        userLoginBtn: document.getElementById("userLoginBtn"),
        logoutBtn: document.getElementById("logoutBtn"),
        navAccountLink: document.getElementById("navAccountLink"),
        deniedState: document.getElementById("deniedState"),
        deniedTitle: document.getElementById("deniedTitle"),
        deniedMessage: document.getElementById("deniedMessage"),
        userToolbar: document.getElementById("userToolbar"),
        pageBody: document.getElementById("pageBody"),
        searchInput: document.getElementById("searchInput"),
        roleFilter: document.getElementById("roleFilter"),
        statusFilter: document.getElementById("statusFilter"),
        reloadBtn: document.getElementById("reloadBtn"),
        createUserBtn: document.getElementById("createUserBtn"),
        totalCount: document.getElementById("totalCount"),
        pendingCount: document.getElementById("pendingCount"),
        userTableBody: document.getElementById("userTableBody"),
        listEmpty: document.getElementById("listEmpty"),
        pageInfo: document.getElementById("pageInfo"),
        pagination: document.getElementById("pagination"),
        toastContainer: document.getElementById("toastContainer"),
        userModal: document.getElementById("userModal"),
        userModalTitle: document.getElementById("userModalTitle"),
        userModalHint: document.getElementById("userModalHint"),
        closeUserModalBtn: document.getElementById("closeUserModalBtn"),
        cancelUserBtn: document.getElementById("cancelUserBtn"),
        userForm: document.getElementById("userForm"),
        formUsername: document.getElementById("formUsername"),
        formPassword: document.getElementById("formPassword"),
        passwordRequired: document.getElementById("passwordRequired"),
        passwordHint: document.getElementById("passwordHint"),
        formRole: document.getElementById("formRole"),
        formStatus: document.getElementById("formStatus"),
        roleAdminOption: document.getElementById("roleAdminOption"),
        roleHint: document.getElementById("roleHint"),
        formError: document.getElementById("formError"),
        saveUserBtn: document.getElementById("saveUserBtn"),
        transferModal: document.getElementById("transferModal"),
        transferForm: document.getElementById("transferForm"),
        transferSourceName: document.getElementById("transferSourceName"),
        transferTargetSelect: document.getElementById("transferTargetSelect"),
        transferError: document.getElementById("transferError"),
        closeTransferBtn: document.getElementById("closeTransferBtn"),
        cancelTransferBtn: document.getElementById("cancelTransferBtn"),
        confirmTransferBtn: document.getElementById("confirmTransferBtn"),
        apiKeysCard: document.getElementById("apiKeysCard"),
        apiKeyCount: document.getElementById("apiKeyCount"),
        apiKeyName: document.getElementById("apiKeyName"),
        apiKeyExpires: document.getElementById("apiKeyExpires"),
        createApiKeyBtn: document.getElementById("createApiKeyBtn"),
        apiKeyIssued: document.getElementById("apiKeyIssued"),
        apiKeyValue: document.getElementById("apiKeyValue"),
        copyApiKeyBtn: document.getElementById("copyApiKeyBtn"),
        apiKeyTableBody: document.getElementById("apiKeyTableBody"),
        apiKeyEmpty: document.getElementById("apiKeyEmpty"),
    };

    let searchTimer = 0;

    function showToast(message, type = "success") {
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        const icon = document.createElement("span");
        icon.className = "toast-icon";
        icon.textContent = type === "error" ? "!" : type === "warning" ? "!" : "✓";
        const text = document.createElement("span");
        text.textContent = message;
        toast.append(icon, text);
        el.toastContainer.appendChild(toast);
        window.setTimeout(() => {
            toast.classList.add("is-leaving");
            window.setTimeout(() => toast.remove(), 220);
        }, 2600);
    }

    function renderHeaderUser(user) {
        el.userAvatar.textContent = user ? String(user.username || "?").slice(0, 1).toUpperCase() : "?";
        el.userName.textContent = user ? user.username : "未登录";
        el.userRole.textContent = user ? Auth.roleLabel(user.role) : "请先登录";
        el.popoverStatus.textContent = user ? Auth.statusLabel(user.status) : "—";
        el.popoverLastLogin.textContent = user && user.lastLoginAt ? user.lastLoginAt : "—";
        el.logoutBtn.classList.toggle("hidden", !user);
        el.userLoginBtn.classList.toggle("hidden", Boolean(user));
        el.accountManageLink.classList.add("hidden");
        // 当前就在账号页，导航链接对已登录用户可见即可
        el.navAccountLink.classList.toggle("hidden", !user);
    }

    function showDenied(title, message) {
        el.deniedTitle.textContent = title;
        el.deniedMessage.textContent = message;
        el.deniedState.classList.remove("hidden");
        el.pageBody.classList.add("hidden");
    }

    function handleAuthError(error) {
        if (error && error.status === 401) {
            showDenied("登录已过期", "请重新登录后再访问账号管理。");
            renderHeaderUser(null);
            return;
        }
        showToast(error?.message || "请求失败", "error");
    }

    function roleBadge(role) {
        const span = document.createElement("span");
        span.className = "badge";
        if (role === "admin") span.classList.add("badge-success");
        else if (role === "readwrite") span.classList.add("badge-info");
        span.textContent = Auth.roleLabel(role);
        return span;
    }

    function statusBadge(status) {
        const span = document.createElement("span");
        span.className = "badge";
        if (status === "pending") span.classList.add("badge-warning");
        else if (status === "disabled") span.classList.add("badge-danger");
        else span.classList.add("badge-success");
        span.textContent = Auth.statusLabel(status);
        return span;
    }

    function renderTable() {
        el.userTableBody.textContent = "";
        el.totalCount.textContent = String(state.total);
        if (!state.users.length) {
            el.listEmpty.classList.remove("hidden");
            return;
        }
        el.listEmpty.classList.add("hidden");

        for (const user of state.users) {
            const tr = document.createElement("tr");

            const idCell = document.createElement("td");
            idCell.className = "user-id-cell";
            idCell.textContent = `#${user.id}`;

            const nameCell = document.createElement("td");
            nameCell.className = "user-name-cell";
            nameCell.textContent = user.username;

            const roleCell = document.createElement("td");
            roleCell.appendChild(roleBadge(user.role));

            const statusCell = document.createElement("td");
            statusCell.appendChild(statusBadge(user.status));

            const createdCell = document.createElement("td");
            createdCell.textContent = user.createdAt || "—";

            const loginCell = document.createElement("td");
            loginCell.textContent = user.lastLoginAt || "—";

            const actionCell = document.createElement("td");
            const actions = document.createElement("div");
            actions.className = "row-actions";

            if (user.status === "pending") {
                // 待审核账号只提供通过 / 拒绝，拒绝即删除该用户数据
                const approveBtn = document.createElement("button");
                approveBtn.type = "button";
                approveBtn.className = "btn btn-sm btn-primary";
                approveBtn.textContent = "通过";
                approveBtn.title = "通过审核，允许该用户登录";
                approveBtn.dataset.action = "approve";
                approveBtn.dataset.id = String(user.id);

                const rejectBtn = document.createElement("button");
                rejectBtn.type = "button";
                rejectBtn.className = "btn btn-sm btn-danger";
                rejectBtn.textContent = "拒绝";
                rejectBtn.title = "拒绝注册并删除该用户数据";
                rejectBtn.dataset.action = "reject";
                rejectBtn.dataset.id = String(user.id);

                actions.append(approveBtn, rejectBtn);
            } else {
                const editBtn = document.createElement("button");
                editBtn.type = "button";
                editBtn.className = "btn btn-sm";
                editBtn.textContent = "编辑";
                editBtn.dataset.action = "edit";
                editBtn.dataset.id = String(user.id);

                const transferBtn = document.createElement("button");
                transferBtn.type = "button";
                transferBtn.className = "btn btn-sm";
                transferBtn.textContent = "迁移";
                transferBtn.title = "把该用户的待办数据迁移给其他用户";
                transferBtn.dataset.action = "transfer";
                transferBtn.dataset.id = String(user.id);

                const deleteBtn = document.createElement("button");
                deleteBtn.type = "button";
                deleteBtn.className = "btn btn-sm btn-danger";
                deleteBtn.textContent = "删除";
                deleteBtn.dataset.action = "delete";
                deleteBtn.dataset.id = String(user.id);
                if (state.user && user.id === state.user.id) {
                    deleteBtn.disabled = true;
                    deleteBtn.title = "不能删除当前登录账号";
                }

                actions.append(editBtn, transferBtn, deleteBtn);
            }
            actionCell.appendChild(actions);

            tr.append(idCell, nameCell, roleCell, statusCell, createdCell, loginCell, actionCell);
            el.userTableBody.appendChild(tr);
        }
    }

    function renderPagination() {
        const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
        el.pageInfo.textContent = `${state.page} / ${totalPages}`;
        el.pagination.textContent = "";

        const prev = document.createElement("button");
        prev.type = "button";
        prev.className = "page-btn";
        prev.textContent = "◀ 上一页";
        prev.disabled = state.page <= 1;
        prev.addEventListener("click", () => {
            if (state.page <= 1) return;
            state.page -= 1;
            loadUsers();
        });

        const next = document.createElement("button");
        next.type = "button";
        next.className = "page-btn";
        next.textContent = "下一页 ▶";
        next.disabled = state.page >= totalPages;
        next.addEventListener("click", () => {
            if (state.page >= totalPages) return;
            state.page += 1;
            loadUsers();
        });

        el.pagination.append(prev, next);
    }

    async function loadUsers() {
        const params = new URLSearchParams({
            page: String(state.page),
            pageSize: String(state.pageSize),
        });
        if (state.search) params.set("search", state.search);
        if (state.role) params.set("role", state.role);
        if (state.status) params.set("status", state.status);

        try {
            const res = await Auth.apiFetch(`/users?${params.toString()}`);
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showToast(json.message || `加载用户失败（${res.status}）`, "error");
                return;
            }
            state.users = Array.isArray(json.users) ? json.users : [];
            state.total = Number(json.total) || 0;
            if (el.pendingCount) el.pendingCount.textContent = String(Number(json.pendingCount) || 0);
            renderTable();
            renderPagination();
        } catch (error) {
            handleAuthError(error);
        }
    }

    function clearFormError() {
        el.formError.classList.add("hidden");
        el.formError.textContent = "";
    }

    function showFormError(message) {
        el.formError.textContent = message;
        el.formError.classList.remove("hidden");
    }

    function openModal() {
        el.userModal.classList.add("is-open");
        el.userModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
    }

    function closeModal() {
        el.userModal.classList.remove("is-open");
        el.userModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        state.editingId = null;
    }

    function openCreateModal() {
        state.editingId = null;
        el.userModalTitle.textContent = "新建用户";
        el.userModalHint.textContent = "创建账号并分配角色";
        el.formUsername.value = "";
        el.formPassword.value = "";
        el.passwordRequired.classList.remove("hidden");
        el.passwordHint.textContent = "至少 6 个字符";
        el.formRole.disabled = false;
        el.formStatus.disabled = false;
        el.formRole.value = "readonly";
        el.formStatus.value = "active";
        if (el.roleAdminOption) el.roleAdminOption.disabled = true;
        if (el.roleHint) {
            el.roleHint.textContent = "系统仅有唯一管理员，不支持创建或转移管理员角色。";
        }
        clearFormError();
        openModal();
        window.setTimeout(() => el.formUsername.focus(), 60);
    }

    function openEditModal(user) {
        state.editingId = user.id;
        const isSelf = Boolean(state.user && user.id === state.user.id);
        el.userModalTitle.textContent = "编辑用户";
        el.userModalHint.textContent = `用户 #${user.id} · 密码留空表示不修改`;
        el.formUsername.value = user.username;
        el.formPassword.value = "";
        el.passwordRequired.classList.add("hidden");
        el.passwordHint.textContent = "留空则保持原密码不变";
        el.formRole.value = user.role;
        el.formStatus.value = user.status;
        // 不能修改自己的角色与状态；管理员角色不支持转移
        el.formRole.disabled = isSelf;
        el.formStatus.disabled = isSelf;
        if (el.roleAdminOption) el.roleAdminOption.disabled = true;
        if (el.roleHint) {
            if (isSelf) {
                el.roleHint.textContent = "不能修改自己的角色与状态。";
            } else if (user.role === "admin") {
                el.roleHint.textContent = "当前管理员账号。";
            } else {
                el.roleHint.textContent = "";
            }
        }
        clearFormError();
        openModal();
        window.setTimeout(() => el.formUsername.focus(), 60);
    }

    async function submitUserForm(event) {
        event.preventDefault();
        const username = el.formUsername.value.trim();
        const password = el.formPassword.value;
        const role = el.formRole.value;
        const status = el.formStatus.value;

        if (!username) {
            showFormError("请输入用户名");
            return;
        }
        if (!state.editingId && password.length < 6) {
            showFormError("新建用户的密码至少 6 个字符");
            return;
        }
        if (state.editingId && password && password.length < 6) {
            showFormError("新密码至少 6 个字符");
            return;
        }

        const editingUser = state.editingId
            ? state.users.find((item) => item.id === state.editingId)
            : null;
        if (role === "admin" && (!editingUser || editingUser.role !== "admin")) {
            showFormError("系统仅有唯一管理员，不支持创建或转移管理员角色");
            return;
        }

        const body = { username, role, status };
        if (password) body.password = password;

        el.saveUserBtn.disabled = true;
        try {
            const path = state.editingId ? `/users/${state.editingId}` : "/users";
            const method = state.editingId ? "PATCH" : "POST";
            const res = await Auth.apiFetch(path, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showFormError(json.message || `保存失败（${res.status}）`);
                return;
            }
            const wasEditing = Boolean(state.editingId);
            closeModal();
            await loadUsers();
            showToast(wasEditing ? "用户已更新" : "用户已创建", "success");
        } catch (error) {
            handleAuthError(error);
        } finally {
            el.saveUserBtn.disabled = false;
        }
    }

    async function deleteUser(user) {
        if (state.user && user.id === state.user.id) {
            showToast("不能删除当前登录账号", "warning");
            return;
        }
        const confirmed = window.confirm(`确定删除用户「${user.username}」？其待办数据会一并删除。`);
        if (!confirmed) return;
        try {
            const res = await Auth.apiFetch(`/users/${user.id}`, { method: "DELETE" });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showToast(json.message || `删除失败（${res.status}）`, "error");
                return;
            }
            if (state.users.length === 1 && state.page > 1) state.page -= 1;
            await loadUsers();
            showToast("用户已删除", "success");
        } catch (error) {
            handleAuthError(error);
        }
    }

    async function approveUser(user) {
        const confirmed = window.confirm(
            `通过用户「${user.username}」的注册申请？通过后该账号即可登录。`,
        );
        if (!confirmed) return;
        try {
            const res = await Auth.apiFetch(`/users/${user.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "active" }),
            });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showToast(json.message || `审核失败（${res.status}）`, "error");
                return;
            }
            await loadUsers();
            showToast("已通过审核，该账号现在可以登录", "success");
        } catch (error) {
            handleAuthError(error);
        }
    }

    async function rejectUser(user) {
        const confirmed = window.confirm(
            `拒绝用户「${user.username}」的注册申请？拒绝后该用户数据会被删除，且无法登录。`,
        );
        if (!confirmed) return;
        try {
            const res = await Auth.apiFetch(`/users/${user.id}`, { method: "DELETE" });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showToast(json.message || `拒绝失败（${res.status}）`, "error");
                return;
            }
            if (state.users.length === 1 && state.page > 1) state.page -= 1;
            await loadUsers();
            showToast("已拒绝并删除该账号", "success");
        } catch (error) {
            handleAuthError(error);
        }
    }

    function showTransferError(message) {
        el.transferError.textContent = message;
        el.transferError.classList.remove("hidden");
    }

    function closeTransferModal() {
        el.transferModal.classList.remove("is-open");
        el.transferModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        el.confirmTransferBtn.disabled = false;
        state.transferSource = null;
    }

    async function openTransferModal(user) {
        state.transferSource = user;
        el.transferSourceName.value = `${user.username}（#${user.id}）`;
        el.transferError.classList.add("hidden");
        el.transferError.textContent = "";
        el.transferTargetSelect.textContent = "";
        el.confirmTransferBtn.disabled = false;

        const loadingOption = document.createElement("option");
        loadingOption.value = "";
        loadingOption.textContent = "加载用户列表...";
        el.transferTargetSelect.appendChild(loadingOption);

        el.transferModal.classList.add("is-open");
        el.transferModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");

        try {
            const res = await Auth.apiFetch("/users?page=1&pageSize=100&status=active");
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showTransferError(json.message || `加载用户列表失败（${res.status}）`);
                return;
            }
            const candidates = (Array.isArray(json.users) ? json.users : []).filter(
                (item) => item.id !== user.id,
            );
            el.transferTargetSelect.textContent = "";
            if (!candidates.length) {
                const emptyOption = document.createElement("option");
                emptyOption.value = "";
                emptyOption.textContent = "没有可用的目标用户";
                el.transferTargetSelect.appendChild(emptyOption);
                el.confirmTransferBtn.disabled = true;
                return;
            }
            for (const candidate of candidates) {
                const option = document.createElement("option");
                option.value = String(candidate.id);
                option.textContent = `${candidate.username}（${Auth.roleLabel(candidate.role)}）`;
                el.transferTargetSelect.appendChild(option);
            }
        } catch (error) {
            handleAuthError(error);
        }
    }

    async function submitTransfer(event) {
        event.preventDefault();
        const source = state.transferSource;
        const targetId = Number(el.transferTargetSelect.value);
        if (!source) return;
        if (!Number.isInteger(targetId) || targetId <= 0) {
            showTransferError("请选择目标用户");
            return;
        }
        const targetLabel =
            el.transferTargetSelect.selectedOptions[0]?.textContent || `#${targetId}`;
        const confirmed = window.confirm(
            `确定将「${source.username}」的全部待办数据迁移给「${targetLabel}」？\n迁移后源用户的分类、标签、待办和图片会被清空。`,
        );
        if (!confirmed) return;

        el.confirmTransferBtn.disabled = true;
        try {
            const res = await Auth.apiFetch(`/users/${source.id}/transfer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUserId: targetId }),
            });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                showTransferError(json.message || `迁移失败（${res.status}）`);
                return;
            }
            const stats = json.stats || {};
            closeTransferModal();
            await loadUsers();
            showToast(
                `迁移完成：${stats.todos || 0} 个待办、${stats.categories || 0} 个分类、${stats.tags || 0} 个标签、${stats.attachments || 0} 个附件`,
                "success",
            );
        } catch (error) {
            handleAuthError(error);
        } finally {
            el.confirmTransferBtn.disabled = false;
        }
    }

    function bindEvents() {
        el.createApiKeyBtn.addEventListener("click", () => void createApiKey());
        el.copyApiKeyBtn.addEventListener("click", () => void copyIssuedKey());
        el.reloadBtn.addEventListener("click", () => loadUsers());
        el.createUserBtn.addEventListener("click", openCreateModal);
        el.roleFilter.addEventListener("change", () => {
            state.role = el.roleFilter.value;
            state.page = 1;
            loadUsers();
        });
        el.statusFilter.addEventListener("change", () => {
            state.status = el.statusFilter.value;
            state.page = 1;
            loadUsers();
        });
        el.searchInput.addEventListener("input", () => {
            window.clearTimeout(searchTimer);
            searchTimer = window.setTimeout(() => {
                state.search = el.searchInput.value.trim();
                state.page = 1;
                loadUsers();
            }, 300);
        });

        el.userTableBody.addEventListener("click", (event) => {
            const button = event.target.closest("button[data-action]");
            if (!button) return;
            const id = Number(button.dataset.id);
            const user = state.users.find((item) => item.id === id);
            if (!user) return;
            if (button.dataset.action === "edit") openEditModal(user);
            else if (button.dataset.action === "transfer") openTransferModal(user);
            else if (button.dataset.action === "delete") deleteUser(user);
            else if (button.dataset.action === "approve") approveUser(user);
            else if (button.dataset.action === "reject") rejectUser(user);
        });

        el.userForm.addEventListener("submit", submitUserForm);
        el.closeUserModalBtn.addEventListener("click", closeModal);
        el.cancelUserBtn.addEventListener("click", closeModal);
        el.userModal.addEventListener("click", (event) => {
            if (event.target === el.userModal) closeModal();
        });

        el.transferForm.addEventListener("submit", submitTransfer);
        el.closeTransferBtn.addEventListener("click", closeTransferModal);
        el.cancelTransferBtn.addEventListener("click", closeTransferModal);
        el.transferModal.addEventListener("click", (event) => {
            if (event.target === el.transferModal) closeTransferModal();
        });

        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            if (el.userModal.classList.contains("is-open")) closeModal();
            if (el.transferModal.classList.contains("is-open")) closeTransferModal();
        });

        el.logoutBtn.addEventListener("click", () => {
            if (!window.confirm("确定退出当前账号？")) return;
            Auth.clearSession();
            window.location.href = "/pages/index.html";
        });

        el.userLoginBtn.addEventListener("click", () => {
            window.location.href = "/pages/index.html";
        });

        el.userTrigger.addEventListener("click", (event) => {
            event.stopPropagation();
            if (!state.user) {
                window.location.href = "/pages/index.html";
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
    }

    // ---------- 我的 API 密钥 ----------

    function renderApiKeys(keys) {
        el.apiKeyCount.textContent = String(keys.length);
        el.apiKeyTableBody.replaceChildren();
        el.apiKeyEmpty.classList.toggle("hidden", keys.length > 0);

        for (const key of keys) {
            const row = document.createElement("tr");

            const nameCell = document.createElement("td");
            nameCell.className = "user-name-cell";
            nameCell.textContent = key.name;

            const prefixCell = document.createElement("td");
            const prefix = document.createElement("span");
            prefix.className = "api-key-prefix";
            prefix.textContent = `${key.prefix}…`;
            prefixCell.appendChild(prefix);

            const createdCell = document.createElement("td");
            createdCell.textContent = key.createdAt || "—";

            const usedCell = document.createElement("td");
            usedCell.textContent = key.lastUsedAt || "—";

            const expiresCell = document.createElement("td");
            expiresCell.textContent = key.expiresAt || "永久";

            const actionCell = document.createElement("td");
            const revokeBtn = document.createElement("button");
            revokeBtn.className = "btn btn-sm btn-ghost";
            revokeBtn.type = "button";
            revokeBtn.textContent = "吊销";
            revokeBtn.addEventListener("click", () => void revokeApiKey(key));
            actionCell.appendChild(revokeBtn);

            row.append(nameCell, prefixCell, createdCell, usedCell, expiresCell, actionCell);
            el.apiKeyTableBody.appendChild(row);
        }
    }

    async function loadApiKeys() {
        try {
            const res = await Auth.apiFetch("/auth/api-keys");
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                throw new Error(json.message || `加载失败（${res.status}）`);
            }
            renderApiKeys(Array.isArray(json.apiKeys) ? json.apiKeys : []);
        } catch (error) {
            if (error.status === 401) return;
            showToast(error.message || "加载 API 密钥失败", "error");
        }
    }

    async function createApiKey() {
        const name = el.apiKeyName.value.trim();
        if (!name) {
            showToast("请先填写密钥名称", "warning");
            el.apiKeyName.focus();
            return;
        }
        const expiresRaw = el.apiKeyExpires.value.trim();
        el.createApiKeyBtn.disabled = true;
        try {
            const res = await Auth.apiFetch("/auth/api-keys", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name,
                    ...(expiresRaw ? { expiresInDays: Number(expiresRaw) } : {}),
                }),
            });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                throw new Error(json.message || `创建失败（${res.status}）`);
            }
            el.apiKeyName.value = "";
            el.apiKeyExpires.value = "";
            el.apiKeyValue.textContent = json.key || "";
            el.apiKeyIssued.classList.remove("hidden");
            showToast("密钥已创建，请立即保存", "success");
            await loadApiKeys();
        } catch (error) {
            if (error.status === 401) return;
            showToast(error.message || "创建密钥失败", "error");
        } finally {
            el.createApiKeyBtn.disabled = false;
        }
    }

    async function revokeApiKey(key) {
        if (!window.confirm(`确定吊销密钥「${key.name}」？已在使用的地方会立即失效。`)) return;
        try {
            const res = await Auth.apiFetch(`/auth/api-keys/${Number(key.id)}`, {
                method: "DELETE",
            });
            const json = await Auth.parseJson(res);
            if (!res.ok || !json.res) {
                throw new Error(json.message || `吊销失败（${res.status}）`);
            }
            showToast("密钥已吊销", "success");
            await loadApiKeys();
        } catch (error) {
            if (error.status === 401) return;
            showToast(error.message || "吊销密钥失败", "error");
        }
    }

    async function copyIssuedKey() {
        const value = el.apiKeyValue.textContent || "";
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            showToast("已复制到剪贴板", "success");
        } catch {
            // 非安全上下文没有剪贴板 API，退回选中文本让用户手动复制
            const range = document.createRange();
            range.selectNodeContents(el.apiKeyValue);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            showToast("请手动复制选中的密钥", "warning");
        }
    }

    async function init() {
        bindEvents();
        const user = await Auth.loadCurrentUser();
        renderHeaderUser(user);
        if (!user) {
            showDenied("请先登录", "登录后可以在这里管理自己的 API 密钥。");
            return;
        }
        state.user = user;
        // 密钥属于账号自身资源，所有角色都能管理；用户列表仍只对管理员开放
        el.apiKeysCard.classList.remove("hidden");
        await loadApiKeys();
        if (!Auth.hasRole(user.role, "admin")) {
            // 非管理员不显示用户管理工具栏，只保留自己的密钥卡片
            el.userToolbar.classList.add("hidden");
            el.pageBody.classList.add("hidden");
            return;
        }
        el.pageBody.classList.remove("hidden");
        await loadUsers();
    }

    init();
})();
