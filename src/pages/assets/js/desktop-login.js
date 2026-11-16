/* ============================================================
   GitStatus 桌宠桌面版登录页
   登录成功后通知 Electron 关闭登录窗并刷新桌宠
   ============================================================ */
(function (global) {
    "use strict";

    const form = document.getElementById("loginForm");
    const usernameInput = document.getElementById("username");
    const passwordInput = document.getElementById("password");
    const submitBtn = document.getElementById("loginSubmit");
    const errorNode = document.getElementById("loginError");
    let finished = false;

    function showError(message) {
        errorNode.textContent = message;
        errorNode.classList.remove("hidden");
    }

    function clearError() {
        errorNode.textContent = "";
        errorNode.classList.add("hidden");
    }

    function finishLogin() {
        if (finished) return;
        finished = true;
        if (global.desktopApi?.loginDone) {
            // Electron 主进程需要拿到 token 才能代渲染进程请求接口
            const token = global.GitStatusAuth?.readToken?.() || "";
            global.desktopApi.loginDone(token);
            return;
        }
        // 在普通浏览器里打开时退回网页端
        global.location.href = "/pages/todo.html";
    }

    // 已有有效登录态时直接唤醒桌宠，避免重复登录
    async function restoreSession() {
        if (!global.GitStatusAuth.readToken()) return;
        const user = await global.GitStatusAuth.loadCurrentUser();
        if (user) finishLogin();
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearError();
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        if (!username || !password) {
            showError("账号和密码都要填喵");
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = "登录中…";
        try {
            await global.GitStatusAuth.login(username, password);
            submitBtn.textContent = "登录成功喵";
            finishLogin();
        } catch (error) {
            showError(error.message || "登录失败喵");
            submitBtn.disabled = false;
            submitBtn.textContent = "登录";
        }
    });

    void restoreSession();
})(window);
