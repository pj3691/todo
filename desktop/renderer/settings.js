/* ============================================================
   设置窗口渲染逻辑
   - 独立窗口，打开时从主进程取一次完整状态，避免和抽屉式面板互相影响
   - 提醒设置存服务器；大小 / 镜像 / 提醒音 / 调试存本机
   ============================================================ */
(function (global) {
    "use strict";

    const api = global.desktopApi;
    if (!api) return;

    const content = document.getElementById("content");
    const page = document.querySelector(".page");
    const closeButton = document.getElementById("closeSettings");
    if (closeButton) closeButton.addEventListener("click", () => api.closeSettings());
    api.onSettingsShown(() => {
        if (page) page.classList.add("is-shown");
    });
    // 兜底：主进程的 shown 事件极端情况下丢失时，别让卡片一直停在透明态
    global.setTimeout(() => {
        if (page && !page.classList.contains("is-shown")) page.classList.add("is-shown");
    }, 1800);

    const PET_SIZE_MIN = 56;
    const PET_SIZE_MAX = 120;
    const PET_SIZE_DEFAULT = 76;
    const PET_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

    const CLIENT_DEFAULTS = {
        intervalEnabled: true,
        intervalMinutes: 60,
        intervalWithinWorkHours: false,
        workStart: "09:00",
        workEnd: "18:00",
        workStartEnabled: true,
        workEndEnabled: true,
        dueLeadMinutes: 15
    };

    let runtime = null;
    let draft = null;
    let prefs = {
        size: PET_SIZE_DEFAULT,
        mirrored: false,
        mirror: false,
        muted: false,
        debug: false
    };
    let displaySelect = null;
    let assetThumb = null;

    // ---------- 基础工具 ----------
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function makeButton(label, className, onClick) {
        const node = el("button", className, label);
        node.type = "button";
        if (typeof onClick === "function") node.addEventListener("click", onClick);
        return node;
    }

    function toBoundedInt(value, fallback, min, max) {
        if (value === null || value === undefined || value === "") return fallback;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, Math.round(parsed)));
    }

    function normalizeTimeText(value, fallback) {
        const text = String(value || "");
        return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
    }

    function normalizeSettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        return {
            intervalEnabled: source.intervalEnabled !== false,
            intervalMinutes: toBoundedInt(source.intervalMinutes, CLIENT_DEFAULTS.intervalMinutes, 5, 480),
            intervalWithinWorkHours: source.intervalWithinWorkHours === true,
            workStart: normalizeTimeText(source.workStart, CLIENT_DEFAULTS.workStart),
            workEnd: normalizeTimeText(source.workEnd, CLIENT_DEFAULTS.workEnd),
            workStartEnabled: source.workStartEnabled !== false,
            workEndEnabled: source.workEndEnabled !== false,
            dueLeadMinutes: toBoundedInt(source.dueLeadMinutes, CLIENT_DEFAULTS.dueLeadMinutes, 0, 1440),
            petImageUrl: typeof source.petImageUrl === "string" ? source.petImageUrl : ""
        };
    }

    function validateSettingsDraft(value) {
        const intervalMinutes = Number(value.intervalMinutes);
        if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 480) {
            return { error: "提醒间隔需在 5 - 480 分钟之间喵" };
        }
        const dueLeadMinutes = Number(value.dueLeadMinutes);
        if (!Number.isInteger(dueLeadMinutes) || dueLeadMinutes < 0 || dueLeadMinutes > 1440) {
            return { error: "提前提醒需在 0 - 1440 分钟之间喵" };
        }
        const workStart = normalizeTimeText(value.workStart, "");
        const workEnd = normalizeTimeText(value.workEnd, "");
        if (!workStart || !workEnd) return { error: "上下班时间格式不正确喵" };
        if (workEnd <= workStart) return { error: "下班时间要晚于上班时间喵" };
        return {
            settings: {
                intervalEnabled: Boolean(value.intervalEnabled),
                intervalMinutes,
                intervalWithinWorkHours: Boolean(value.intervalWithinWorkHours),
                workStart,
                workEnd,
                workStartEnabled: Boolean(value.workStartEnabled),
                workEndEnabled: Boolean(value.workEndEnabled),
                dueLeadMinutes
            }
        };
    }

    function readPrefs(state) {
        return {
            size: toBoundedInt(state && state.size, PET_SIZE_DEFAULT, PET_SIZE_MIN, PET_SIZE_MAX),
            mirrored: Boolean(state && state.mirrored),
            mirror: Boolean(state && state.mirror),
            muted: Boolean(state && state.muted),
            debug: Boolean(state && state.debug)
        };
    }

    function settingsLabel(title, subtitle) {
        const node = el("div", "set-label");
        node.append(el("strong", "", title), el("small", "", subtitle));
        return node;
    }

    function createSwitch(checked, onChange) {
        const label = el("label", "switch");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(checked);
        input.addEventListener("change", () => onChange(input.checked));
        const track = el("span", "switch-track");
        label.append(input, track);
        return { node: label, input };
    }

    function createCheck(text, checked, onChange) {
        const label = el("label", "check");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(checked);
        input.addEventListener("change", () => onChange(input.checked));
        label.append(input, el("span", "", text));
        return { node: label, input };
    }

    function createNumberInput(value, min, max, step, ariaLabel) {
        const input = el("input", "input");
        input.type = "number";
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.inputMode = "numeric";
        input.value = String(value);
        if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
        return input;
    }

    function createTimeInput(value, ariaLabel) {
        const input = el("input", "input");
        input.type = "time";
        input.step = "60";
        input.value = value;
        if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
        return input;
    }

    function showError(node, message) {
        node.textContent = message;
        node.classList.remove("hidden");
    }

    function hideError(node) {
        node.textContent = "";
        node.classList.add("hidden");
    }

    function showStatus(node, message) {
        node.textContent = message;
        node.classList.remove("hidden");
    }

    function hideStatus(node) {
        node.textContent = "";
        node.classList.add("hidden");
    }

    // 设置窗是无边框浮窗，显示前把量好的卡片尺寸交给主进程
    let sizeFrame = 0;
    function reportSize() {
        if (sizeFrame) return;
        sizeFrame = global.requestAnimationFrame(() => {
            sizeFrame = 0;
            if (!page) return;
            // 用 offset 而不是 getBoundingClientRect：卡片淡入时带 scale，rect 会被缩小
            api.resizeSettings(page.offsetWidth + 32, page.offsetHeight + 32);
        });
    }

    if (page) new ResizeObserver(() => reportSize()).observe(page);

    function updateThumb() {
        if (!assetThumb) return;
        const image = (runtime && runtime.petImage) || "";
        assetThumb.replaceChildren(global.PetVisual.createVisual(image, "桌宠"));
        console.debug("[settings] thumb", image.length, assetThumb.isConnected);
        setTimeout(() => {
            const img = assetThumb && assetThumb.querySelector("img");
            console.debug(
                "[settings] thumb-img",
                img ? { complete: img.complete, w: img.naturalWidth, h: img.naturalHeight, len: img.src.length } : null
            );
        }, 800);
    }

    function fillDisplayOptions() {
        if (!displaySelect || !runtime) return;
        const displays = Array.isArray(runtime.displays) ? runtime.displays : [];
        displaySelect.replaceChildren();
        for (const display of displays) {
            const option = document.createElement("option");
            option.value = String(display.id);
            option.textContent = display.label || `显示器 ${display.id}`;
            displaySelect.append(option);
        }
        const current = String(runtime.currentDisplayId ?? "");
        if (current && displays.some((display) => String(display.id) === current)) {
            displaySelect.value = current;
        }
        displaySelect.disabled = displays.length < 2;
    }

    // ---------- 离线 / 未登录 ----------
    function offlineBanner() {
        const banner = el("div", "banner");
        banner.append(document.createTextNode("后台还没有启动喵，请先在项目根目录启动后端，再点下面的按钮重新连接。"));
        banner.append(el("code", "", String(runtime.serverUrl || "")));
        const row = el("div", "login-actions");
        row.append(makeButton("重新连接", "btn btn-primary", () => api.retry()));
        banner.append(row);
        return banner;
    }

    function loginCard() {
        const card = el("div", "login-card");
        card.append(el("h2", "", "老大还没登录喵"));
        card.append(el("p", "", "登录后我才能帮你盯着当天的待办喵～"));
        const actions = el("div", "login-actions");
        actions.append(
            makeButton("去登录喵", "btn btn-primary", () => api.openLogin()),
            makeButton("隐藏桌宠", "btn btn-muted", () => api.hidePet()),
            makeButton("退出桌宠", "btn btn-muted", () => api.quitApp())
        );
        card.append(actions);
        return card;
    }

    // ---------- 设置区块 ----------
    function buildIntervalSection() {
        const section = el("section", "section");
        const head = el("div", "set-row");
        const intervalSwitch = createSwitch(draft.intervalEnabled, (value) => {
            draft.intervalEnabled = value;
            sync();
        });
        head.append(settingsLabel("间隔提醒", "还有没做完的待办时，定时冒个小泡泡喵"), intervalSwitch.node);

        const row = el("div", "inline-row");
        row.append(el("span", "text", "每"));
        const intervalInput = createNumberInput(draft.intervalMinutes, 5, 480, 5, "提醒间隔分钟数");
        intervalInput.addEventListener("input", () => {
            draft.intervalMinutes = Number(intervalInput.value);
        });
        row.append(intervalInput, el("span", "text", "分钟提醒一次"));

        const workHours = createCheck("仅在工作时间内提醒", draft.intervalWithinWorkHours, (value) => {
            draft.intervalWithinWorkHours = value;
        });

        section.append(
            head,
            row,
            workHours.node,
            el("p", "hint", "示例：老大还有 3 件事未完成喵～")
        );

        function sync() {
            intervalInput.disabled = !draft.intervalEnabled;
            workHours.input.disabled = !draft.intervalEnabled;
        }
        sync();
        return { section, sync };
    }

    function buildWorkSection() {
        const section = el("section", "section");
        section.append(settingsLabel("上下班提醒", "到点提醒老大还有多少事没做完喵"));

        const startRow = el("div", "inline-row");
        const startInput = createTimeInput(draft.workStart, "上班时间");
        startInput.addEventListener("change", () => {
            draft.workStart = startInput.value || "";
        });
        const startSwitch = createSwitch(draft.workStartEnabled, (value) => {
            draft.workStartEnabled = value;
            sync();
        });
        startRow.append(el("span", "text", "上班"), startInput, startSwitch.node);

        const endRow = el("div", "inline-row");
        const endInput = createTimeInput(draft.workEnd, "下班时间");
        endInput.addEventListener("change", () => {
            draft.workEnd = endInput.value || "";
        });
        const endSwitch = createSwitch(draft.workEndEnabled, (value) => {
            draft.workEndEnabled = value;
            sync();
        });
        endRow.append(el("span", "text", "下班"), endInput, endSwitch.node);

        section.append(startRow, endRow, el("p", "hint", "下班时间也作为“只有日期”任务的截止时刻喵。"));

        function sync() {
            startInput.disabled = !draft.workStartEnabled;
            endInput.disabled = !draft.workEndEnabled;
        }
        sync();
        return section;
    }

    function buildDueSection() {
        const section = el("section", "section");
        section.append(settingsLabel("截止提醒", "快到期时提前喊你一声喵"));

        const row = el("div", "inline-row");
        row.append(el("span", "text", "提前"));
        const dueInput = createNumberInput(draft.dueLeadMinutes, 0, 1440, 1, "截止提醒提前分钟数");
        dueInput.addEventListener("input", () => {
            draft.dueLeadMinutes = Number(dueInput.value);
        });
        row.append(dueInput, el("span", "text", "分钟"));

        const chips = el("div", "chips");
        for (const minutes of [5, 15, 30, 60]) {
            const chip = makeButton(minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`, "chip", () => {
                dueInput.value = String(minutes);
                draft.dueLeadMinutes = minutes;
            });
            chips.append(chip);
        }

        section.append(
            row,
            chips,
            el("p", "hint", "设为 0 表示关闭喵；只有日期没有时间的任务按下班时间。")
        );
        return section;
    }

    function buildAssetSection(errorNode, statusNode) {
        const section = el("section", "section");
        section.append(settingsLabel("素材设置", "角色图片保存在服务器，大小与提醒音保存在本机喵"));

        const row = el("div", "asset-row");
        assetThumb = el("span", "asset-thumb");
        updateThumb();

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.className = "hidden";
        fileInput.accept = "image/png,image/jpeg,image/webp,image/gif";

        const importBtn = makeButton("导入图片", "btn", () => fileInput.click());
        const resetBtn = makeButton("恢复默认", "btn", async () => {
            hideError(errorNode);
            hideStatus(statusNode);
            importBtn.disabled = true;
            resetBtn.disabled = true;
            const result = await api.deletePet();
            importBtn.disabled = false;
            resetBtn.disabled = false;
            if (!result || !result.ok) {
                showError(errorNode, (result && result.message) || "恢复默认失败，请稍后再试喵");
                return;
            }
            if (result.settings) runtime.settings = result.settings;
            runtime.petImage = await api.getPetImage();
            updateThumb();
            showStatus(statusNode, "已恢复默认形象喵～");
        });

        fileInput.addEventListener("change", async () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = "";
            if (!file) return;
            hideError(errorNode);
            hideStatus(statusNode);
            if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
                showError(errorNode, "只支持 PNG / JPG / WebP / GIF 喵");
                return;
            }
            if (file.size > PET_IMAGE_MAX_BYTES) {
                showError(errorNode, "图片别超过 2MB 喵");
                return;
            }
            importBtn.disabled = true;
            resetBtn.disabled = true;
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const result = await api.uploadPet(bytes, file.type, file.name || "pet.png");
                if (!result || !result.ok) {
                    showError(errorNode, (result && result.message) || "上传失败，请稍后再试喵");
                    return;
                }
                if (result.settings) runtime.settings = result.settings;
                runtime.petImage = await api.getPetImage();
                updateThumb();
                showStatus(statusNode, "角色图片已更新喵～");
            } catch {
                showError(errorNode, "上传失败，请稍后再试喵");
            } finally {
                importBtn.disabled = false;
                resetBtn.disabled = false;
            }
        });

        row.append(assetThumb, importBtn, resetBtn, fileInput);
        section.append(row, statusNode);

        // 与旧版一致：大小、镜像、提醒音都归在素材设置里
        const sizeRow = el("div", "inline-row");
        sizeRow.append(el("span", "text", "大小"));
        const sizeInput = document.createElement("input");
        sizeInput.type = "range";
        sizeInput.className = "range";
        sizeInput.min = String(PET_SIZE_MIN);
        sizeInput.max = String(PET_SIZE_MAX);
        sizeInput.step = "4";
        sizeInput.value = String(prefs.size);
        sizeInput.setAttribute("aria-label", "桌宠大小");
        const sizeText = el("span", "text", `${prefs.size}px`);
        sizeInput.addEventListener("input", () => {
            prefs.size = toBoundedInt(sizeInput.value, prefs.size, PET_SIZE_MIN, PET_SIZE_MAX);
            sizeText.textContent = `${prefs.size}px`;
            void api.setPreference("size", prefs.size);
        });
        sizeRow.append(sizeInput, sizeText);

        section.append(sizeRow);
        section.append(
            createCheck("镜像角色（默认关闭）", prefs.mirrored, (value) => {
                prefs.mirrored = value;
                void api.setPreference("mirrored", value);
            }).node
        );
        section.append(
            createCheck("贴右侧时镜像转身（默认关闭）", prefs.mirror, (value) => {
                prefs.mirror = value;
                void api.setPreference("mirror", value);
            }).node
        );
        section.append(
            createCheck("提醒音", !prefs.muted, (checked) => {
                prefs.muted = !checked;
                void api.setPreference("muted", prefs.muted);
            }).node
        );
        section.append(
            el(
                "p",
                "hint",
                "图片最大 2MB，支持 PNG / JPG / WebP / GIF；角色图片按账号同步，大小、镜像与提醒音只影响当前桌面端喵。"
            )
        );
        return section;
    }

    function buildDesktopSection() {
        const section = el("section", "section");
        section.append(settingsLabel("桌面桌宠", "桌宠窗口可拖动到任意显示器，可收进 Windows 托盘喵"));

        // 显示器
        const displayRow = el("div", "inline-row");
        displayRow.append(el("span", "text", "显示器"));
        displaySelect = document.createElement("select");
        displaySelect.className = "input select";
        displaySelect.setAttribute("aria-label", "桌宠所在显示器");
        fillDisplayOptions();
        displaySelect.addEventListener("change", () => api.moveToDisplay(displaySelect.value));
        displayRow.append(displaySelect);
        section.append(displayRow);

        // 调试
        section.append(
            createCheck("调试模式：显示桌宠窗口边框", prefs.debug, (value) => {
                prefs.debug = value;
                void api.setPreference("debug", value);
            }).node
        );

        // 桌面动作
        const actions = el("div", "inline-row");
        actions.append(
            makeButton("隐藏桌宠", "btn btn-muted", () => api.hidePet()),
            makeButton("打开待办", "btn", () => api.openTodo(false)),
            makeButton("退出桌宠", "btn btn-muted", () => api.quitApp())
        );
        section.append(actions);
        return section;
    }

    function buildFooter(options) {
        const footer = el("div", "footer");
        if (options && options.withDefaults) {
            footer.append(
                makeButton("恢复默认", "btn btn-muted", () => {
                    if (typeof options.onDefaults === "function") options.onDefaults();
                })
            );
        }
        footer.append(makeButton("返回", "btn", () => api.closeSettings()));
        if (options && options.withSave) {
            const saveBtn = makeButton("保存", "btn btn-primary", () => void save(saveBtn));
            footer.append(saveBtn);
        }
        return footer;
    }

    async function save(saveBtn) {
        const errorNode = content.querySelector(".error");
        if (!errorNode) return;
        const validation = validateSettingsDraft(draft);
        if (validation.error) {
            showError(errorNode, validation.error);
            return;
        }
        hideError(errorNode);
        saveBtn.disabled = true;
        saveBtn.textContent = "保存中…";
        try {
            const result = await api.saveSettings(validation.settings);
            if (!result || !result.ok) {
                showError(errorNode, (result && result.message) || "保存失败喵");
                saveBtn.textContent = "保存";
                return;
            }
            runtime.settings = result.settings;
            draft = normalizeSettings(result.settings);
            saveBtn.textContent = "已保存喵";
            setTimeout(() => {
                if (saveBtn.isConnected) saveBtn.textContent = "保存";
            }, 1600);
        } catch {
            showError(errorNode, "保存失败喵");
            saveBtn.textContent = "保存";
        } finally {
            saveBtn.disabled = false;
        }
    }

    // ---------- 页面 ----------
    function renderForm(initialDraft) {
        draft = normalizeSettings(initialDraft || runtime.settings || CLIENT_DEFAULTS);
        const fragment = document.createDocumentFragment();
        if (runtime.offline) fragment.append(offlineBanner());

        const errorNode = el("p", "error hidden");
        const statusNode = el("p", "status hidden");

        fragment.append(buildIntervalSection().section);
        fragment.append(buildWorkSection());
        fragment.append(buildDueSection());
        fragment.append(buildAssetSection(errorNode, statusNode));
        fragment.append(buildDesktopSection());
        fragment.append(errorNode, statusNode);
        fragment.append(
            buildFooter({
                withDefaults: true,
                withSave: true,
                onDefaults: () => renderForm(CLIENT_DEFAULTS)
            })
        );

        content.replaceChildren(fragment);
        reportSize();
    }

    function renderLoginView() {
        const fragment = document.createDocumentFragment();
        if (runtime.offline) fragment.append(offlineBanner());
        fragment.append(loginCard());
        fragment.append(buildDesktopSection());
        fragment.append(buildFooter({}));
        content.replaceChildren(fragment);
        reportSize();
    }

    function render() {
        if (!runtime) {
            content.replaceChildren(el("p", "hint", "正在读取设置喵…"));
            return;
        }
        prefs = readPrefs(runtime);
        if (!runtime.loggedIn) renderLoginView();
        else renderForm();
    }

    // ---------- 状态同步 ----------
    api.onState((state) => {
        if (!state) return;
        const previous = runtime || {};
        runtime = { ...previous, ...state, petImage: previous.petImage || "" };
        prefs = readPrefs(runtime);
        if (Boolean(previous.loggedIn) !== Boolean(state.loggedIn) || Boolean(previous.offline) !== Boolean(state.offline)) {
            render();
            return;
        }
        fillDisplayOptions();
    });

    api.onPetImage((url) => {
        if (runtime) runtime.petImage = String(url || "");
        updateThumb();
    });

    void (async () => {
        try {
            const state = await api.getSettingsState();
            if (!state) throw new Error("no state");
            runtime = state;
            console.debug("[settings] boot image", String(runtime.petImage || "").length);
            render();
        } catch {
            content.replaceChildren(el("p", "hint", "设置窗口没有拿到主进程状态喵"));
        }
    })();
})(window);
