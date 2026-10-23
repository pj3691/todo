/* ============================================================
   GitStatus 前端认证工具
   统一 token 存取、API 请求与角色判断，供账号管理页复用
   ============================================================ */
(function (global) {
    "use strict";

    const API_BASE = "/gitstatus/api";
    const TOKEN_KEY = "gitstatus_todo_token";
    const USER_KEY = "gitstatus_todo_user";
    const ROLE_LABELS = { admin: "管理员", readwrite: "读写", readonly: "只读" };
    const STATUS_LABELS = { active: "已启用", disabled: "已禁用", pending: "待审核" };
    const ROLE_LEVEL = { readonly: 1, readwrite: 2, admin: 3 };

    function readStorage(key) {
        try {
            return global.localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            if (value === null || value === undefined) global.localStorage.removeItem(key);
            else global.localStorage.setItem(key, value);
        } catch {
            /* 隐私模式下 localStorage 可能不可用 */
        }
    }

    function safeJsonParse(raw) {
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    const readToken = () => readStorage(TOKEN_KEY) || "";
    const readUser = () => safeJsonParse(readStorage(USER_KEY));

    function saveSession(token, user) {
        writeStorage(TOKEN_KEY, token || null);
        writeStorage(USER_KEY, user ? JSON.stringify(user) : null);
    }

    function clearSession() {
        writeStorage(TOKEN_KEY, null);
        writeStorage(USER_KEY, null);
    }

    const roleLabel = (role) => ROLE_LABELS[role] || role || "未知";
    const statusLabel = (status) => STATUS_LABELS[status] || status || "未知";
    const hasRole = (role, min) => (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[min] || 99);

    async function parseJson(res) {
        try {
            return await res.json();
        } catch {
            return {};
        }
    }

    async function apiFetch(path, options = {}) {
        const headers = new Headers(options.headers || {});
        const token = readToken();
        if (token) headers.set("Authorization", `Bearer ${token}`);
        const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
        if (res.status === 401) {
            clearSession();
            const error = new Error("登录已过期，请重新登录");
            error.status = 401;
            throw error;
        }
        return res;
    }

    async function loadCurrentUser() {
        if (!readToken()) return null;
        try {
            const res = await apiFetch("/auth/me");
            if (!res.ok) return null;
            const json = await parseJson(res);
            if (!json.res || !json.user) return null;
            saveSession(readToken(), json.user);
            return json.user;
        } catch {
            return null;
        }
    }

    async function login(username, password) {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        const json = await parseJson(res);
        if (!res.ok || !json.res) {
            throw new Error(json.message || `登录失败（${res.status}）`);
        }
        saveSession(json.token, json.user);
        return json.user;
    }

    global.GitStatusAuth = {
        API_BASE,
        TOKEN_KEY,
        USER_KEY,
        ROLE_LABELS,
        STATUS_LABELS,
        readToken,
        readUser,
        saveSession,
        clearSession,
        roleLabel,
        statusLabel,
        hasRole,
        apiFetch,
        loadCurrentUser,
        login,
        parseJson,
    };
})(window);
