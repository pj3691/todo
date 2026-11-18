/* ============================================================
   GitStatus 通用桌宠挂件
   - 零外部依赖、零网络资源（图形为内联 SVG）
   - 拖拽 + 边角吸附 + 贴边镜像
   - 点击查看当天待办摘要，提醒事件由 /todo-widget/summary 推送
   - 适配桌面与移动端（触摸拖拽、气泡自适应宽度）
   使用方式：引入 pet-widget.css 与本脚本即可，默认自动初始化；
   需要自定义时在引入前设置 window.GITSTATUS_PET_CONFIG。
   ============================================================ */
(function (global) {
    "use strict";

    if (global.__gitstatusPetLoaded) return;
    global.__gitstatusPetLoaded = true;

    const DEFAULTS = {
        // 接口前缀，默认与项目保持一致
        apiBase: "/gitstatus/api",
        // 桌面版模式：位置由 Electron 窗口控制，拖拽移动窗口
        desktop: false,
        // 桌面版局部舞台：桌宠固定在舞台右下角，拖拽时移动整个窗口
        desktopStage: false,
        // 桌面版：首次没有保存位置时的初始区域（虚拟桌面内的局部坐标）
        initialPosition: null,
        // 待办页面地址
        todoUrl: "/pages/todo.html",
        // 可选：自定义桌宠图片（png/gif/webp）。为空时使用内置内联 SVG
        // 例："/pages/assets/pet/whale.png"
        petImage: "",
        petImageAlt: "桌宠",
        // 素材大小保存在本机浏览器；角色图片由后端按账号保存
        petSizeKey: "gitstatus_pet_size_v1",
        // 手动镜像：角色基础朝向始终翻转
        petMirroredKey: "gitstatus_pet_mirrored_v1",
        // 贴边镜像：贴右侧时自动转身
        petMirrorKey: "gitstatus_pet_mirror_v1",
        petSize: 76,
        petSizeMin: 56,
        petSizeMax: 120,
        petImageMaxBytes: 2 * 1024 * 1024,
        // 与 todo / account 页共用的登录态存储键
        tokenKey: "gitstatus_todo_token",
        positionKey: "gitstatus_pet_position_v1",
        seenKey: "gitstatus_pet_seen_events_v1",
        mutedKey: "gitstatus_pet_muted_v1",
        debugFrameKey: "gitstatus_pet_debug_frame_v1",
        intervalLastKey: "gitstatus_pet_interval_last_v1",
        workStateKey: "gitstatus_pet_work_state_v1",
        settingsStampKey: "gitstatus_pet_settings_stamp",
        // 轮询间隔（毫秒）
        pollMs: 25000,
        // 本地提醒检查间隔（间隔提醒 / 上下班提醒）
        tickMs: 15000,
        // 上下班提醒的生效窗口，避免打开页面太晚仍弹出
        workGraceMinutes: 10,
        summaryAutoHideMs: 10000,
        reminderAutoHideMs: 30000,
        idleAfterMs: 60000,
        // 判定为拖拽的最小位移
        dragThreshold: 4,
        // 吸附边缘的判定距离
        snapDistance: 56,
        // 初始定位（距右下角的距离）
        margin: 18
    };

    // 允许在 script 标签上直接配置，便于只改一行就替换桌宠图片
    const scriptElement = document.currentScript;
    const scriptConfig = {};
    if (scriptElement && scriptElement.dataset) {
        if (scriptElement.dataset.petImage) scriptConfig.petImage = scriptElement.dataset.petImage;
        if (scriptElement.dataset.petApi) scriptConfig.apiBase = scriptElement.dataset.petApi;
        if (scriptElement.dataset.petTodoUrl) scriptConfig.todoUrl = scriptElement.dataset.petTodoUrl;
    }

    const state = {
        config: {
            ...DEFAULTS,
            ...scriptConfig,
            ...(global.GITSTATUS_PET_CONFIG || {})
        },
        inited: false,
        root: null,
        avatar: null,
        badge: null,
        bubble: null,
        mini: null,
        miniBody: null,
        menuBtn: null,
        miniOpen: false,
        miniTimer: 0,
        miniNotice: null,
        remotePetImage: "",
        remotePetImageUrl: "",
        assetThumb: null,
        petSize: 76,
        petMirrored: false,
        petMirror: false,
        lastSync: "",
        summary: null,
        settings: null,
        tokenPresent: false,
        muted: false,
        debugFrame: false,
        seen: new Set(),
        queue: [],
        bubbleOpen: false,
        bubbleType: "",
        hideTimer: 0,
        pollTimer: 0,
        tickTimer: 0,
        idleTimer: 0,
        alertTimer: 0,
        requestSeq: 0,
        hoverBubble: false,
        stageAnchor: null,
        // 松手后等待主进程展开舞台并回传锚点，期间暂停页面自行重排
        awaitingStageLayout: false,
        drag: null,
        audioCtx: null
    };

    // ------------------------------------------------------------
    // 基础工具
    // ------------------------------------------------------------
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

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
            /* 隐私模式下忽略 */
        }
    }

    function readJson(key, fallback) {
        const raw = readStorage(key);
        if (!raw) return fallback;
        try {
            return JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    function currentToken() {
        return String(readStorage(state.config.tokenKey) || "").trim();
    }

    function petSize() {
        return state.root ? state.root.getBoundingClientRect().width || 76 : 76;
    }

    // ------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------
    const PET_SVG = `
        <svg class="pet-svg" viewBox="0 0 120 120" fill="none" aria-hidden="true" focusable="false">
            <defs>
                <linearGradient id="petBodyGradient" x1="65" y1="34" x2="65" y2="92" gradientUnits="userSpaceOnUse">
                    <stop stop-color="#3aa971"></stop>
                    <stop offset="1" stop-color="#196b46"></stop>
                </linearGradient>
            </defs>
            <ellipse cx="63" cy="107" rx="28" ry="5.5" fill="rgba(12,42,27,0.16)"></ellipse>
            <path d="M33 61c-7-6-14-8-19-6 2 6 6 9 11 10-6 3-9 8-9 14 7-1 13-5 17-11z" fill="#1b7a4f"></path>
            <ellipse cx="65" cy="63" rx="36" ry="28" fill="url(#petBodyGradient)"></ellipse>
            <ellipse cx="62" cy="75" rx="27" ry="14" fill="#dff2e6" opacity="0.92"></ellipse>
            <path d="M55 88c5 4 14 4 19-1-4 6-14 7-19 1z" fill="#bfe3cd"></path>
            <ellipse cx="52" cy="83" rx="9" ry="5" fill="#1b7a4f" opacity="0.5" transform="rotate(18 52 83)"></ellipse>
            <circle cx="84" cy="55" r="5.2" fill="#ffffff"></circle>
            <circle class="pet-eye" cx="84" cy="55" r="2.7" fill="#10281b"></circle>
            <circle cx="93" cy="53" r="1.4" fill="#ffffff"></circle>
            <path d="M78 68c4 3 9 3 13 0" stroke="#14563a" stroke-width="2.2" stroke-linecap="round"></path>
            <circle cx="71" cy="39" r="2.6" fill="#9fd9b8" opacity="0.8"></circle>
            <circle cx="79" cy="32" r="1.8" fill="#9fd9b8" opacity="0.6"></circle>
        </svg>
    `;

    function createPetVisual() {
        const imageUrl = String(state.remotePetImage || state.config.petImage || "").trim();
        if (imageUrl) {
            const img = document.createElement("img");
            img.className = "pet-image";
            img.src = imageUrl;
            img.alt = state.config.petImageAlt || "桌宠";
            img.decoding = "async";
            img.draggable = false;
            // 图片缺失或格式不支持时回退到内置造型，避免桌宠消失
            img.addEventListener(
                "error",
                () => {
                    img.replaceWith(createSvgVisual());
                },
                { once: true }
            );
            return img;
        }
        return createSvgVisual();
    }

    function createSvgVisual() {
        const svgDoc = new DOMParser().parseFromString(PET_SVG.trim(), "text/html");
        return svgDoc.body.firstElementChild || el("span", "pet-svg");
    }

    // 参考仓库的气泡是 SVG：大椭圆 + 两个小圆（尾巴不压在大椭圆上）
    const MINI_BUBBLE_SVG = `
        <svg class="pet-mini-bg" viewBox="0 0 300 300" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <ellipse class="pet-mini-shape" cx="150" cy="150" rx="145" ry="145"
                vector-effect="non-scaling-stroke"></ellipse>
            <ellipse class="pet-mini-dot" cx="248" cy="282" rx="14" ry="11"
                vector-effect="non-scaling-stroke"></ellipse>
            <ellipse class="pet-mini-dot is-small" cx="264" cy="314" rx="8" ry="6"
                vector-effect="non-scaling-stroke"></ellipse>
        </svg>
    `;

    function createMiniBubbleBg() {
        const svgDoc = new DOMParser().parseFromString(MINI_BUBBLE_SVG.trim(), "text/html");
        return svgDoc.body.firstElementChild || el("span", "pet-mini-bg");
    }

    // ------------------------------------------------------------
    // 素材（角色图片来自后端，大小保存在本机）
    // ------------------------------------------------------------
    function readPetAssetSettings() {
        // 角色图片由后端按账号保存，这里只读取本机的显示偏好
        state.petSize = toBoundedInt(
            readStorage(state.config.petSizeKey),
            state.config.petSize,
            state.config.petSizeMin,
            state.config.petSizeMax
        );
        // 默认不镜像，导入的素材保持原本朝向
        state.petMirrored = readStorage(state.config.petMirroredKey) === "1";
        state.petMirror = readStorage(state.config.petMirrorKey) === "1";
    }

    function refreshPetVisual() {
        const squish = state.root?.querySelector(".pet-squish");
        if (squish) squish.replaceChildren(createPetVisual());
    }

    function refreshAssetThumb() {
        if (state.assetThumb?.isConnected) {
            state.assetThumb.replaceChildren(createPetVisual());
        }
    }

    function applyPetSize(persist) {
        if (!state.root) return;
        state.root.style.setProperty("--pet-scale", String(state.petSize / 76));
        if (persist) writeStorage(state.config.petSizeKey, String(state.petSize));
        const rect = state.root.getBoundingClientRect();
        applyPosition(rect.left, rect.top, false);
    }

    function revokeRemotePetImage() {
        if (state.remotePetImage) {
            try {
                URL.revokeObjectURL(state.remotePetImage);
            } catch {
                /* 忽略释放失败 */
            }
        }
        state.remotePetImage = "";
    }

    /**
     * 桌面桌宠素材如果是纯色背景图，按边缘连通区域抠掉背景。
     * 只处理 PNG/JPEG/WebP 静态图，避免破坏 GIF 动画。
     */
    function createTransparentPetImageUrl(blob) {
        if (!blob || /gif/i.test(blob.type || "")) return Promise.resolve(URL.createObjectURL(blob));
        return new Promise((resolve) => {
            const sourceUrl = URL.createObjectURL(blob);
            const image = new Image();
            image.decoding = "async";
            image.onerror = () => resolve(sourceUrl);
            image.onload = () => {
                try {
                    const maxSide = 1024;
                    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
                    const width = Math.max(1, Math.round(image.naturalWidth * scale));
                    const height = Math.max(1, Math.round(image.naturalHeight * scale));
                    const canvas = document.createElement("canvas");
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext("2d", { willReadFrequently: true });
                    if (!context) {
                        resolve(sourceUrl);
                        return;
                    }
                    context.drawImage(image, 0, 0, width, height);
                    const imageData = context.getImageData(0, 0, width, height);
                    const data = imageData.data;
                    const corners = [
                        [0, 0],
                        [width - 1, 0],
                        [0, height - 1],
                        [width - 1, height - 1]
                    ].map(([x, y]) => {
                        const offset = (y * width + x) * 4;
                        return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
                    });
                    if (corners.filter((corner) => corner[3] < 16).length >= 3) {
                        resolve(sourceUrl);
                        return;
                    }
                    const background = corners
                        .filter((corner) => corner[3] >= 16)
                        .reduce(
                            (acc, corner) => [
                                acc[0] + corner[0] / 4,
                                acc[1] + corner[1] / 4,
                                acc[2] + corner[2] / 4,
                                acc[3] + corner[3] / 4
                            ],
                            [0, 0, 0, 0]
                        );
                    const tolerance = 28;
                    const cornerMatches = corners.filter(
                        (corner) => corner[3] < 16 ||
                            Math.sqrt(
                                (corner[0] - background[0]) ** 2 +
                                (corner[1] - background[1]) ** 2 +
                                (corner[2] - background[2]) ** 2
                            ) <= tolerance
                    ).length;
                    if (cornerMatches < 3) {
                        resolve(sourceUrl);
                        return;
                    }
                    const total = width * height;
                    const visited = new Uint8Array(total);
                    const queue = new Uint32Array(total);
                    let head = 0;
                    let tail = 0;
                    const matchesBackground = (index) => {
                        const offset = index * 4;
                        if (data[offset + 3] < 16) return true;
                        const dr = data[offset] - background[0];
                        const dg = data[offset + 1] - background[1];
                        const db = data[offset + 2] - background[2];
                        return Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance;
                    };
                    const enqueue = (index) => {
                        if (visited[index] || !matchesBackground(index)) return;
                        visited[index] = 1;
                        data[index * 4 + 3] = 0;
                        queue[tail++] = index;
                    };
                    for (let x = 0; x < width; x += 1) {
                        enqueue(x);
                        enqueue((height - 1) * width + x);
                    }
                    for (let y = 1; y < height - 1; y += 1) {
                        enqueue(y * width);
                        enqueue(y * width + width - 1);
                    }
                    while (head < tail) {
                        const index = queue[head++];
                        const x = index % width;
                        const y = Math.floor(index / width);
                        if (x > 0) enqueue(index - 1);
                        if (x < width - 1) enqueue(index + 1);
                        if (y > 0) enqueue(index - width);
                        if (y < height - 1) enqueue(index + width);
                    }
                    if (tail / total < 0.02) {
                        resolve(sourceUrl);
                        return;
                    }
                    context.putImageData(imageData, 0, 0);
                    canvas.toBlob((result) => {
                        if (result) {
                            URL.revokeObjectURL(sourceUrl);
                            resolve(URL.createObjectURL(result));
                        } else {
                            resolve(sourceUrl);
                        }
                    }, "image/png");
                } catch {
                    resolve(sourceUrl);
                }
            };
            image.src = sourceUrl;
        });
    }

    /** 按设置里的 petImageUrl 取图；图片接口需要登录态，因此先取 Blob 再展示 */
    async function syncRemotePetImage(url, force) {
        const target = String(url || "");
        if (!force && target === state.remotePetImageUrl) return;
        if (!target) {
            revokeRemotePetImage();
            state.remotePetImageUrl = "";
            refreshPetVisual();
            refreshAssetThumb();
            return;
        }
        const token = currentToken();
        if (!token) return;
        try {
            const res = await fetch(target, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store"
            });
            if (!res.ok) {
                revokeRemotePetImage();
                refreshPetVisual();
                refreshAssetThumb();
                return;
            }
            const blob = await res.blob();
            const objectUrl = await createTransparentPetImageUrl(blob);
            revokeRemotePetImage();
            state.remotePetImage = objectUrl;
            state.remotePetImageUrl = target;
            refreshPetVisual();
            refreshAssetThumb();
        } catch {
            // 网络异常时保留当前形象
        }
    }

    async function uploadPetImage(file) {
        if (!file) return { error: "没有选择图片喵" };
        if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
            return { error: "只支持 PNG / JPG / WebP / GIF 喵" };
        }
        if (file.size > state.config.petImageMaxBytes) {
            return { error: "图片别超过 2MB 喵" };
        }
        const token = currentToken();
        if (!token) return { error: "登录已过期，请重新登录喵" };
        try {
            const form = new FormData();
            form.append("file", file, file.name || "pet.png");
            const res = await fetch(`${state.config.apiBase}/todo-widget/assets/pet`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
                body: form
            });
            let json = {};
            try {
                json = await res.json();
            } catch {
                /* 响应不是 JSON 时按失败处理 */
            }
            if (!res.ok || !json.res) {
                return { error: json.message || `上传失败（${res.status}）` };
            }
            if (json.settings) state.settings = normalizeClientSettings(json.settings);
            await syncRemotePetImage(state.settings?.petImageUrl || "", true);
            return { ok: true };
        } catch {
            return { error: "上传失败，请稍后再试喵" };
        }
    }

    async function removePetImage() {
        const token = currentToken();
        if (!token) return { error: "登录已过期，请重新登录喵" };
        try {
            const res = await fetch(`${state.config.apiBase}/todo-widget/assets/pet`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` }
            });
            let json = {};
            try {
                json = await res.json();
            } catch {
                /* 响应不是 JSON 时按失败处理 */
            }
            if (!res.ok || !json.res) {
                return { error: json.message || `恢复默认失败（${res.status}）` };
            }
            if (json.settings) state.settings = normalizeClientSettings(json.settings);
            await syncRemotePetImage("", true);
            return { ok: true };
        } catch {
            return { error: "恢复默认失败，请稍后再试喵" };
        }
    }

    function buildAddTodoHref() {
        const base = String(state.config.todoUrl || "/pages/todo.html");
        const separator = base.includes("?") ? "&" : "?";
        return `${base}${separator}add=1`;
    }

    function createDom() {
        const root = el("div", "pet-widget");
        root.id = "gitstatusPet";

        const bubble = el("div", "pet-bubble");
        bubble.setAttribute("role", "dialog");
        bubble.setAttribute("aria-label", "桌宠提示");
        bubble.setAttribute("aria-hidden", "true");

        const mini = el("div", "pet-mini");
        mini.setAttribute("role", "status");
        mini.setAttribute("aria-live", "polite");
        const miniBody = el("div", "pet-mini-body");
        mini.append(createMiniBubbleBg(), miniBody);

        const menuBtn = el("button", "pet-menu-btn");
        menuBtn.type = "button";
        menuBtn.setAttribute("aria-label", "打开桌宠面板");
        menuBtn.title = "打开桌宠面板";
        for (let index = 0; index < 3; index += 1) {
            menuBtn.append(el("span", "pet-menu-line"));
        }

        const addBtn = el("a", "pet-add-btn", "+");
        addBtn.href = buildAddTodoHref();
        addBtn.title = "新建待办";
        addBtn.setAttribute("aria-label", "去待办页新建待办");
        addBtn.setAttribute("data-pet-add", "1");

        // 桌面版快捷入口：打开待办列表页（网页版不显示）
        const todoBtn = state.config.desktop && global.desktopApi?.openTodo
            ? el("button", "pet-todo-btn")
            : null;
        if (todoBtn) {
            todoBtn.type = "button";
            todoBtn.title = "打开待办页面";
            todoBtn.setAttribute("aria-label", "打开待办页面");
            todoBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17"/><path d="M8 3.2v3.6M16 3.2v3.6"/><path d="M9 14.4l2 2 4-4.4"/></svg>';
            todoBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                global.desktopApi.openTodo();
            });
        }

        const avatar = el("button", "pet-avatar");
        avatar.type = "button";
        avatar.setAttribute("aria-haspopup", "dialog");
        avatar.setAttribute("aria-expanded", "false");
        avatar.setAttribute("aria-label", "桌宠喵：点击查看今天的待办");

        const badge = el("span", "pet-badge");
        badge.setAttribute("aria-hidden", "true");
        const zzz = el("span", "pet-zzz", "z");
        zzz.setAttribute("aria-hidden", "true");
        const flip = el("span", "pet-flip");
        const float = el("span", "pet-float");
        const squish = el("span", "pet-squish");
        squish.append(createPetVisual());
        float.append(squish);
        flip.append(float);
        avatar.append(badge, zzz, flip);

        root.append(bubble, mini, menuBtn, addBtn);
        if (todoBtn) root.append(todoBtn);
        root.append(avatar);
        document.body.append(root);

        state.root = root;
        state.avatar = avatar;
        state.bubble = bubble;
        state.mini = mini;
        state.miniBody = miniBody;
        state.menuBtn = menuBtn;
        state.badge = root.querySelector(".pet-badge");
    }

    // ------------------------------------------------------------
    // 位置与拖拽
    // ------------------------------------------------------------
    function maxLeft() {
        return Math.max(4, global.innerWidth - petSize() - 4);
    }

    function maxTop() {
        return Math.max(4, global.innerHeight - petSize() - 4);
    }

    // 高 DPI 下把坐标对齐到物理像素：125% / 150% 缩放下 CSS 小数也会落在
    // 半个物理像素上，浏览器合成时插值，表现为边缘发虚、拖动时闪。
    function alignCssPixel(value) {
        const dpr = Number(global.devicePixelRatio) || 1;
        return Math.round(value * dpr) / dpr;
    }

    function applyPosition(left, top, persist) {
        const size = petSize();
        const nextLeft = clamp(left, 4, maxLeft());
        const nextTop = clamp(top, 4, maxTop());
        state.root.style.left = `${alignCssPixel(nextLeft)}px`;
        state.root.style.top = `${alignCssPixel(nextTop)}px`;
        state.root.style.right = "auto";
        state.root.style.bottom = "auto";
        // 默认造型朝右：位于右半屏时镜像，让它始终朝向页面中心
        const centerX = nextLeft + size / 2;
        const isRight = centerX > global.innerWidth / 2;
        // 是否镜像由用户设置决定：手动镜像决定基础朝向，贴边镜像在此基础上再翻一次
        const flipped = (state.petMirror && isRight) !== state.petMirrored;
        state.root.classList.toggle("is-flipped", flipped);
        // 小气泡与快捷按钮跟随当前朝向：镜像后沿中线反射到另一侧
        state.root.classList.toggle("is-right", isRight !== flipped);
        if (state.bubbleOpen) placeBubble();
        if (persist) {
            writeStorage(
                state.config.positionKey,
                JSON.stringify({ left: nextLeft, top: nextTop })
            );
            reportDesktopPosition(nextLeft, nextTop);
        }
        return { left: nextLeft, top: nextTop };
    }

    // 把桌宠屏幕坐标报告给主进程，用于更新托盘/登录窗口所在的显示器
    function reportDesktopPosition(left, top) {
        if (!state.config.desktop || !global.desktopApi?.reportPetPosition) return;
        const size = petSize();
        global.desktopApi.reportPetPosition(
            global.screenX + left + size / 2,
            global.screenY + top + size / 2
        );
    }

    function restorePosition() {
        if (state.config.desktopStage) {
            const size = petSize();
            applyPosition(
                global.innerWidth - size - state.config.margin,
                global.innerHeight - size - state.config.margin,
                false
            );
            return;
        }
        const saved = readJson(state.config.positionKey, null);
        const size = petSize();
        if (saved && Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
            applyPosition(Number(saved.left), Number(saved.top), false);
            return;
        }
        const initial = state.config.initialPosition;
        if (
            initial &&
            Number.isFinite(Number(initial.left)) &&
            Number.isFinite(Number(initial.top)) &&
            Number.isFinite(Number(initial.width)) &&
            Number.isFinite(Number(initial.height))
        ) {
            applyPosition(
                Number(initial.left) + Number(initial.width) - size - state.config.margin,
                Number(initial.top) + Number(initial.height) - size - state.config.margin,
                false
            );
            return;
        }
        applyPosition(
            global.innerWidth - size - state.config.margin,
            global.innerHeight - size - state.config.margin,
            false
        );
    }

    function snapPosition(left, top) {
        const size = petSize();
        const snap = state.config.snapDistance;
        let nextLeft = left;
        let nextTop = top;
        if (left <= snap) nextLeft = 10;
        else if (global.innerWidth - (left + size) <= snap) nextLeft = global.innerWidth - size - 10;
        if (global.innerHeight - (top + size) <= snap) nextTop = global.innerHeight - size - 10;
        else if (top <= snap) nextTop = 10;
        return applyPosition(nextLeft, nextTop, true);
    }

    function onPointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        if (!state.avatar.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();

        const rect = state.root.getBoundingClientRect();
        const avatarRect = state.avatar.getBoundingClientRect();
        const cursor = global.desktopApi?.getCursorPoint?.() || null;
        state.drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            offsetX: event.clientX - avatarRect.left,
            offsetY: event.clientY - avatarRect.top,
            moved: false,
            windowDrag: Boolean(
                state.config.desktopStage &&
                    global.desktopApi?.setDesktopDragging &&
                    global.desktopApi?.getCursorPoint &&
                    global.desktopApi?.startWindowDrag &&
                    global.desktopApi?.windowDragTick &&
                    global.desktopApi?.endWindowDrag
            ),
            windowStarted: false,
            startCursorX: Number.isFinite(cursor?.x) ? cursor.x : event.screenX,
            startCursorY: Number.isFinite(cursor?.y) ? cursor.y : event.screenY,
            lastScreenX: event.screenX,
            lastScreenY: event.screenY,
            startPetLeft: global.screenX + rect.left,
            startPetTop: global.screenY + rect.top,
            windowX: global.screenX,
            windowY: global.screenY,
            workArea: {
                x: global.screen.availLeft || 0,
                y: global.screen.availTop || 0,
                width: global.screen.availWidth || global.innerWidth,
                height: global.screen.availHeight || global.innerHeight
            },
            frame: 0
        };
        // 在指针按下时就停掉 hover guard，避免拖动开始的第一帧
        // 被 setIgnoreMouseEvents 切换打断而出现方向性闪烁。
        if (state.drag.windowDrag) {
            global.desktopApi.setDesktopDragging(true);
        }
        state.root.classList.add("is-pressed");
        try {
            state.avatar.setPointerCapture(event.pointerId);
        } catch {
            /* 部分浏览器不支持时忽略 */
        }
        global.addEventListener("pointermove", onPointerMove, { passive: false });
        global.addEventListener("pointerup", onPointerUp);
        global.addEventListener("pointercancel", onPointerUp);
        wake();
    }

    function onPointerMove(event) {
        const drag = state.drag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < state.config.dragThreshold) return;
        if (!drag.moved) {
            drag.moved = true;
            state.root.classList.add("is-dragging");
            hideBubble();
            hideMini();
        }
        if (event.cancelable) event.preventDefault();
        if (drag.windowDrag) {
            drag.lastScreenX = event.screenX;
            drag.lastScreenY = event.screenY;
            if (!drag.windowStarted) {
                drag.windowStarted = true;
                // 把光标在桌宠内的偏移交给主进程，由它逐帧 setPosition 移动窗口；
                // 拖动全程不改窗口尺寸，页面内容也不重绘，避免透明窗 resize 闪烁。
                console.debug("[pet] drag-start", global.innerWidth, global.innerHeight, petSize(), drag.offsetX, drag.offsetY);
                global.desktopApi.startWindowDrag?.(petSize(), drag.offsetX, drag.offsetY);
                const step = () => {
                    if (state.drag !== drag) return;
                    global.desktopApi.windowDragTick?.();
                    drag.frame = global.requestAnimationFrame(step);
                };
                drag.frame = global.requestAnimationFrame(step);
            }
            return;
        }
        // 桌面舞台的旧兜底路径：直接移动窗口并同步页面内位置
        if (state.config.desktopStage && global.desktopApi?.getCursorPoint) {
            applyDesktopDrag(drag);
            return;
        }
        applyPosition(drag.left + dx, drag.top + dy, false);
    }

    function applyDesktopDrag(drag) {
        const size = petSize();
        const margin = state.config.margin;
        const stageWidth = global.innerWidth;
        const stageHeight = global.innerHeight;
        const area = drag.workArea;
        const cursor = global.desktopApi.getCursorPoint?.();
        const cursorX = Number.isFinite(cursor?.x) ? cursor.x : drag.lastScreenX;
        const cursorY = Number.isFinite(cursor?.y) ? cursor.y : drag.lastScreenY;
        const targetPetLeft = clamp(
            drag.startPetLeft + (cursorX - drag.startCursorX),
            area.x,
            area.x + area.width - size
        );
        const targetPetTop = clamp(
            drag.startPetTop + (cursorY - drag.startCursorY),
            area.y,
            area.y + area.height - size
        );
        let nextWindowX = drag.windowX;
        let nextWindowY = drag.windowY;
        let localX = targetPetLeft - nextWindowX;
        let localY = targetPetTop - nextWindowY;
        const maxLocalX = stageWidth - size - margin;
        const maxLocalY = stageHeight - size - margin;
        if (localX < margin || localX > maxLocalX) {
            const anchorX = Math.max(margin, Math.min(maxLocalX, (stageWidth - size) / 2));
            nextWindowX = clamp(
                targetPetLeft - anchorX,
                area.x,
                Math.max(area.x, area.x + area.width - stageWidth)
            );
            localX = targetPetLeft - nextWindowX;
        }
        if (localY < margin || localY > maxLocalY) {
            const anchorY = Math.max(margin, Math.min(maxLocalY, (stageHeight - size) / 2));
            nextWindowY = clamp(
                targetPetTop - anchorY,
                area.y,
                Math.max(area.y, area.y + area.height - stageHeight)
            );
            localY = targetPetTop - nextWindowY;
        }
        // 窗口和桌宠位置在同一帧一起改，窗口只在大范围换位时移动，
        // 不再像之前那样每帧移动整块透明窗口，也不会在松手时缩放舞台。
        if (nextWindowX !== drag.windowX || nextWindowY !== drag.windowY) {
            global.moveTo(Math.round(nextWindowX), Math.round(nextWindowY));
            drag.windowX = nextWindowX;
            drag.windowY = nextWindowY;
        }
        // 用当前真实窗口位置反算局部坐标，窗口移动若晚一帧生效，
        // 桌宠仍会保持在光标下，而不是跟着窗口一起跳。
        const actualWindowX = Number.isFinite(global.screenX) ? global.screenX : nextWindowX;
        const actualWindowY = Number.isFinite(global.screenY) ? global.screenY : nextWindowY;
        localX = targetPetLeft - actualWindowX;
        localY = targetPetTop - actualWindowY;
        state.root.style.left = `${alignCssPixel(localX)}px`;
        state.root.style.top = `${alignCssPixel(localY)}px`;
        state.root.style.right = "auto";
        state.root.style.bottom = "auto";
        const isRight = targetPetLeft + size / 2 > area.x + area.width / 2;
        const flipped = (state.petMirror && isRight) !== state.petMirrored;
        state.root.classList.toggle("is-flipped", flipped);
        state.root.classList.toggle("is-right", isRight !== flipped);
    }

    function onPointerUp(event) {
        const drag = state.drag;
        if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
        state.drag = null;
        if (drag.frame) {
            global.cancelAnimationFrame(drag.frame);
            drag.frame = 0;
        }
        state.root.classList.remove("is-pressed", "is-dragging");
        global.removeEventListener("pointermove", onPointerMove);
        global.removeEventListener("pointerup", onPointerUp);
        global.removeEventListener("pointercancel", onPointerUp);

        if (drag.windowDrag) {
            if (!drag.moved) {
                global.desktopApi.setDesktopDragging?.(false);
                toggleMini();
                return;
            }
            // 主进程按松手位置把舞台展开回完整尺寸并回传锚点，
            // 内部会清掉拖动状态并保存位置。
            state.awaitingStageLayout = true;
            console.debug("[pet] drag-end", global.innerWidth, global.innerHeight);
            global.desktopApi.endWindowDrag?.();
            // 兜底：主进程没有可用的布局信息时，自己按锚点归位
            global.setTimeout(() => {
                if (!state.awaitingStageLayout) return;
                state.awaitingStageLayout = false;
                applyStageAnchor(state.stageAnchor || { right: true, bottom: true });
            }, 400);
            if (state.queue.length > 0) {
                window.setTimeout(showNextReminder, 300);
            }
            return;
        }

        if (!drag.moved) {
            toggleMini();
            return;
        }
        const rect = state.root.getBoundingClientRect();
        snapPosition(rect.left, rect.top);
        // 拖拽期间被压下的提醒，松手后再弹出
        if (state.queue.length > 0) {
            window.setTimeout(showNextReminder, 300);
        }
    }

    // ------------------------------------------------------------
    // 气泡
    // ------------------------------------------------------------
    function placeBubble() {
        if (!state.bubbleOpen) return;
        const rect = state.avatar.getBoundingClientRect();
        const maxWidth = state.bubbleType === "settings" ? 384 : 322;
        const width = Math.min(maxWidth, global.innerWidth - 24);
        state.bubble.style.width = `${width}px`;
        const height = state.bubble.offsetHeight;
        const edge = 10;
        const gap = 12;
        const maxLeft = Math.max(edge, global.innerWidth - width - edge);
        const maxTop = Math.max(edge, global.innerHeight - height - edge);
        // 四向避让：优先左上/右上，再尝试下方；仍放不下时夹到舞台边界。
        const leftCandidates = [rect.right - width + 4, rect.left - 4];
        const topCandidates = [rect.top - height - gap, rect.bottom + gap];
        let position = null;
        for (const top of topCandidates) {
            for (const left of leftCandidates) {
                if (left >= edge && left <= maxLeft && top >= edge && top <= maxTop) {
                    position = { left, top };
                    break;
                }
            }
            if (position) break;
        }
        if (!position) {
            position = {
                left: clamp(leftCandidates[0], edge, maxLeft),
                top: clamp(topCandidates[0], edge, maxTop)
            };
        }
        state.bubble.style.left = `${Math.round(position.left)}px`;
        state.bubble.style.top = `${Math.round(position.top)}px`;
    }

    function showBubble(content, type) {
        hideMini();
        state.bubble.replaceChildren(content);
        state.bubbleOpen = true;
        state.bubbleType = type;
        state.hoverBubble = false;
        state.bubble.classList.add("is-open");
        state.bubble.setAttribute("aria-hidden", "false");
        state.avatar.setAttribute("aria-expanded", "true");
        placeBubble();
        global.requestAnimationFrame(placeBubble);
        scheduleHide(type);
        wake();
    }

    function hideBubble() {
        if (!state.bubbleOpen) return;
        state.bubbleOpen = false;
        state.bubbleType = "";
        state.hoverBubble = false;
        state.bubble.classList.remove("is-open");
        state.bubble.setAttribute("aria-hidden", "true");
        state.avatar.setAttribute("aria-expanded", "false");
        clearTimer("hideTimer");
        if (state.queue.length > 0) {
            window.setTimeout(showNextReminder, 500);
        }
    }

    // ------------------------------------------------------------
    // 左键小气泡（只报数，不展开完整面板）
    // ------------------------------------------------------------
    function pickRandom(list) {
        return list[Math.floor(Math.random() * list.length)] || "";
    }

    const MINI_GOODBYE_LINES = [
        "老大下次再见喵",
        "那我先眯一会儿喵",
        "桌宠先退到托盘里喵",
        "有事再喊我喵",
        "我先藏起来喵，随叫随到喵",
        "拜拜喵，记得休息喵",
        "下次见喵，别太累啦喵",
        "我先去打个盹喵",
        "桌宠下班啦喵",
        "想我的时候点托盘喵",
        "老大再见喵，喵在托盘等你喵",
        "先撤啦喵，回头见喵"
    ];

    const MINI_WELCOME_LINES = [
        "老大我又回来了喵",
        "想我了没喵",
        "桌宠归位喵",
        "我回来啦喵",
        "接着陪你盯待办喵",
        "刚刚眯了一小会儿喵",
        "老大我在这儿喵",
        "又见面啦喵",
        "待办交给我喵",
        "我回来继续陪你喵",
        "喵回来啦，今天也要加油喵",
        "老大好喵，我一直在托盘里待命喵"
    ];

    function renderMini() {
        if (!state.mini) return;
        const nodes = [];

        // 隐藏 / 回来时的临时小气泡，优先于待办状态
        if (state.miniNotice) {
            const notice = state.miniNotice;
            nodes.push(el("span", "pet-mini-kicker", notice.kicker));
            nodes.push(el("span", "pet-mini-text-lg", notice.text));
            if (notice.sub) nodes.push(el("span", "pet-mini-sub", notice.sub));
            state.miniBody.replaceChildren(...nodes);
            return;
        }

        if (!currentToken()) {
            nodes.push(el("span", "pet-mini-kicker", "桌宠喵"));
            nodes.push(el("span", "pet-mini-text-lg", "老大还没登录喵"));
            state.miniBody.replaceChildren(...nodes);
            return;
        }
        if (!state.summary) {
            nodes.push(el("span", "pet-mini-kicker", "桌宠喵"));
            nodes.push(el("span", "pet-mini-text-lg", "让喵看看待办喵…"));
            state.miniBody.replaceChildren(...nodes);
            return;
        }

        const { pending, overdue, completed, total } = currentStats();
        nodes.push(
            el("span", "pet-mini-kicker", pickRandom(["待办喵", "喵喵日报", "今日待办喵"]))
        );

        // 大号数字：有待办时显示未完成数，全部完成时显示总数，没有待办显示 0
        const bigValue = pending > 0 ? pending : total;
        const bigUnit = pending > 0 ? "条没做完" : total > 0 ? "条全清喵" : "条待办喵";
        const main = el("span", "pet-mini-main");
        main.append(el("strong", "", String(bigValue)), el("span", "", bigUnit));
        nodes.push(main);

        let title = "";
        let sub = "";
        const chips = [];
        const nextWhen = state.summary.nextReminder
            ? formatTrigger(state.summary.nextReminder.triggerAt, state.summary.today)
            : "";
        const completedChip = pickRandom([
            `完成 ${completed}/${total} 喵`,
            `已完成 ${completed}/${total} 喵`
        ]);
        const overdueChip = pickRandom([
            `逾期 ${overdue} 条喵`,
            `${overdue} 条逾期了喵`
        ]);

        if (total === 0) {
            // 今天完全没有待办
            title = pickRandom([
                "今天没事喵，耍起喵～",
                "今天一条待办都没有喵，摸鱼时间到啦～",
                "今天清清静静喵，老大好好休息喵",
                "今天待办空空如也喵，可以放心玩啦～",
                "今天没有任务喵，喵陪你晒太阳喵～",
                "今天清闲得很喵，要不要来点新计划喵？"
            ]);
            sub = pickRandom([
                "有想做的事再记下来喵～",
                "喵先陪你发会儿呆喵～",
                "记得给自己留点休息时间喵～",
                "摸鱼也要记得喝水喵～",
                "没有待办也是一种幸福喵～"
            ]);
            chips.push({ text: pickRandom(["耍起喵", "摸鱼喵", "休息喵"]), cls: "is-done" });
        } else if (pending === 0) {
            // 今天的待办全部完成
            title = pickRandom([
                `今天所有 ${total} 条待办都完成啦喵！`,
                `${total} 条待办全部搞定喵，老大真棒！`,
                `今天 ${total} 条全清喵，收工收工喵～`,
                `${total} 条全部完成喵，今天效率满分喵！`,
                `今天的 ${total} 条待办被老大清空啦喵！`
            ]);
            sub = pickRandom([
                "奖励一个摸摸头喵～",
                "可以去耍了喵，明天见喵～",
                "老大今天超厉害的喵！",
                "记得给自己倒杯水喵～",
                "喵批准你今天提前收工喵～"
            ]);
            chips.push({
                text: pickRandom([`全清 ${total} 条`, `${total} 条全清喵`]),
                cls: "is-done"
            });
        } else if (overdue > 0 && overdue >= pending) {
            // 没做完的全都逾期了
            title = pickRandom([
                `今天还有 ${pending} 条没做完喵，全都逾期了喵…`,
                `完了完了喵，${overdue} 条全逾期了喵…`,
                `今天 ${pending} 条待办全超时了喵，老大快看喵！`
            ]);
            sub = pickRandom([
                "老大快救火喵！",
                "先挑一条最急的搞定喵！",
                "喵陪你一起救火喵～"
            ]);
            chips.push({ text: overdueChip, cls: "is-danger" });
        } else if (pending === 1) {
            // 只剩最后一条
            if (completed === 0 && total === 1) {
                title = pickRandom([
                    "今天只有 1 条待办喵，搞定就收工喵～",
                    "今天只有 1 条喵，做完就能耍啦喵～",
                    "喵！今天只有 1 条待办，老大搞定它喵！"
                ]);
                sub = pickRandom(["一条就能收工喵～", "喵陪你一起完成喵～"]);
            } else {
                title = pickRandom([
                    "只剩最后 1 条啦喵！",
                    "就差最后 1 条啦喵，冲鸭喵～",
                    "最后 1 条喵，搞定就全清喵～"
                ]);
                sub =
                    completed > 0
                        ? pickRandom([
                              `已经完成 ${completed} 条，再坚持一下喵～`,
                              "就差临门一脚喵～",
                              "最后一条也别放过喵～"
                          ])
                        : pickRandom(["老大冲刺一下喵～", "一条就能收工喵～"]);
            }
            chips.push({ text: completedChip, cls: "" });
        } else if (completed === 0) {
            // 一条都还没完成
            if (pending >= 8) {
                title = pickRandom([
                    `今天一下来了 ${pending} 条待办喵，老大别慌喵～`,
                    `${pending} 条待办排队报到喵，慢慢来喵～`,
                    `今天任务有点多喵，${pending} 条待办等着老大喵～`
                ]);
                sub = pickRandom([
                    "喵帮你盯着，一条一条来喵～",
                    "先做最急的那条喵～",
                    "别慌，喵陪着你喵～"
                ]);
            } else {
                title = pickRandom([
                    `今天还有 ${pending} 条待办喵，一共 ${total} 条待办喵`,
                    `老大，今天 ${pending} 条还没动喵，一共 ${total} 条喵`,
                    `今天 ${pending} 条待办在等你喵，老大加油喵`,
                    `今天 ${total} 条待办都还热乎着喵，${pending} 条等你开工喵`,
                    `${pending} 条待办一字排开喵，老大先挑一条喵`
                ]);
                sub = pickRandom([
                    "老大加油喵～",
                    "一条一条来喵～",
                    "先从最重要的一条开始吧喵～",
                    "喵给你递上第一杯咖啡喵～",
                    "慢慢来，做完一条就少一条喵～"
                ]);
            }
            chips.push({
                text: pickRandom([`共 ${total} 条喵`, `今天共 ${total} 条喵`]),
                cls: ""
            });
        } else if (completed >= pending) {
            // 完成过半
            title = pickRandom([
                `已经完成 ${completed} 条啦喵，还剩 ${pending} 条～`,
                `完成 ${completed} 条喵，只剩 ${pending} 条啦，胜利在望喵！`,
                `${completed} 条搞定喵，${pending} 条收尾啦喵～`,
                `进度过半喵，还剩 ${pending} 条就能全清喵！`
            ]);
            sub = pickRandom([
                "胜利在望喵！",
                "再冲一下就能全清啦喵～",
                "老大今天状态真好喵～",
                "最后几步别松劲喵～"
            ]);
            chips.push({ text: completedChip, cls: "" });
        } else {
            // 完成不足一半
            title = pickRandom([
                `今天还有 ${pending} 条待办喵，一共 ${total} 条待办喵`,
                `还剩 ${pending} 条喵，已经完成 ${completed} 条啦～`,
                `今天 ${pending} 条待办排着队喵，老大继续喵～`
            ]);
            sub = pickRandom([
                `已经完成 ${completed} 条，老大加油喵～`,
                "才刚开始喵，慢慢来～",
                "喵相信老大喵～"
            ]);
            chips.push({ text: completedChip, cls: "" });
        }

        if (overdue > 0 && overdue < pending) {
            chips.unshift({ text: overdueChip, cls: "is-danger" });
        }
        if (nextWhen && total > 0 && pending > 0) {
            chips.push({
                text: pickRandom([
                    `下次提醒 ${nextWhen} 喵`,
                    `${nextWhen} 有提醒喵`,
                    `喵会在 ${nextWhen} 喊你喵`
                ]),
                cls: ""
            });
        }

        if (title) nodes.push(el("span", "pet-mini-title", title));
        // 副文案只在空待办 / 全部完成时显示，避免待办状态的椭圆被撑高
        if (sub && (total === 0 || pending === 0)) {
            nodes.push(el("span", "pet-mini-sub", sub));
        }

        if (chips.length > 0) {
            const chipRow = el("span", "pet-mini-chips");
            for (const chip of chips.slice(0, 2)) {
                chipRow.append(
                    el("span", "pet-mini-chip" + (chip.cls ? ` ${chip.cls}` : ""), chip.text)
                );
            }
            nodes.push(chipRow);
        }

        state.miniBody.replaceChildren(...nodes);
    }

    function positionMini() {
        if (!state.miniOpen || !state.mini) return;
        const mini = state.mini;
        const root = state.root;
        mini.style.transform = "";
        mini.classList.remove("is-below");

        // 先按当前朝向展开；这一侧放不下时换到另一侧，两侧都放不下再左右夹紧
        const overflows = (box) => box.left < 8 || box.right > global.innerWidth - 8;
        let rect = mini.getBoundingClientRect();
        if (overflows(rect)) {
            root.classList.toggle("is-right");
            if (overflows(mini.getBoundingClientRect())) {
                // 两侧都放不下（窄屏），退回镜像方向后交给位移夹紧
                root.classList.toggle("is-right");
            }
            rect = mini.getBoundingClientRect();
        }
        if (rect.top < 8) {
            mini.classList.add("is-below");
            rect = mini.getBoundingClientRect();
        }
        // 气泡较宽时，避免超出视口左右边缘
        let shift = 0;
        if (rect.left < 8) shift = 8 - rect.left;
        else if (rect.right > global.innerWidth - 8) {
            shift = global.innerWidth - 8 - rect.right;
        }
        if (shift) mini.style.transform = `translateX(${shift}px)`;
    }

    function showMini() {
        if (!state.mini) return;
        renderMini();
        state.miniOpen = true;
        state.mini.classList.add("is-open");
        clearTimer("miniTimer");
        state.miniTimer = window.setTimeout(hideMini, 7000);
        // 先同步摆一次，避免展开动画第一帧出现在错误方向
        positionMini();
        global.requestAnimationFrame(positionMini);
        wake();
        // 点击时顺手刷新一次，避免刚完成任务后还显示旧数量
        void refresh();
    }

    function hideMini() {
        state.miniNotice = null;
        if (!state.miniOpen) return;
        state.miniOpen = false;
        state.mini?.classList.remove("is-open", "is-below");
        if (state.mini) state.mini.style.transform = "";
        clearTimer("miniTimer");
    }

    function showMiniNotice(kind) {
        if (!state.mini) return;
        const goodbye = kind === "goodbye";
        const lines = goodbye ? MINI_GOODBYE_LINES : MINI_WELCOME_LINES;
        state.miniNotice = {
            kicker: goodbye ? "桌宠喵" : "桌宠回来啦",
            text: pickRandom(lines),
            sub: goodbye ? "点托盘图标可以叫我回来喵" : "今天也要顺顺利利喵"
        };
        hideBubble();
        showMini();
    }

    function toggleMini() {
        if (state.bubbleOpen) {
            hideBubble();
            return;
        }
        if (state.miniOpen) {
            hideMini();
            return;
        }
        showMini();
    }

    function togglePanel() {
        if (state.bubbleOpen) {
            hideBubble();
            return;
        }
        hideMini();
        renderSummary();
        void refresh();
    }

    function scheduleHide(type) {
        clearTimer("hideTimer");
        // 设置面板不自动关闭，避免填写到一半消失
        if (type === "settings") return;
        if (state.hoverBubble) return;
        const ms = type === "reminder"
            ? state.config.reminderAutoHideMs
            : state.config.summaryAutoHideMs;
        state.hideTimer = window.setTimeout(hideBubble, ms);
    }

    function clearTimer(key) {
        if (state[key]) {
            window.clearTimeout(state[key]);
            state[key] = 0;
        }
    }

    function buildHead(kicker, title, closable, closePet) {
        const head = el("div", "pet-bubble-head");
        const copy = el("div");
        copy.append(el("span", "pet-bubble-kicker", kicker));
        copy.append(el("div", "pet-bubble-title", title));
        head.append(copy);
        if (closable !== false) {
            const hideToTray = Boolean(
                closePet && state.config.desktop && global.desktopApi?.hidePet
            );
            const headActions = el("div", "pet-head-actions");
            const settingsBtn = el("button", "pet-link-btn", "设置");
            settingsBtn.type = "button";
            settingsBtn.title = "调整桌宠提醒设置";
            settingsBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                openSettings();
            });
            headActions.append(settingsBtn);
            const close = el("button", "pet-close", "\u00d7");
            close.type = "button";
            close.setAttribute("aria-label", hideToTray ? "关闭桌宠到托盘" : "关闭");
            if (hideToTray) close.title = "收进 Windows 托盘";
            close.addEventListener("click", (event) => {
                event.stopPropagation();
                // 完整面板里的关闭按钮 = 收进托盘；提醒气泡仍只关闭气泡
                if (hideToTray) global.desktopApi.hidePet();
                else hideBubble();
            });
            headActions.append(close);
            head.append(headActions);
        }
        return head;
    }

    function buildActions(primaryLabel, primaryHref, mutedLabel) {
        const actions = el("div", "pet-actions");
        if (mutedLabel) {
            const mute = el("button", "pet-btn pet-btn-muted", mutedLabel);
            mute.type = "button";
            mute.addEventListener("click", (event) => {
                event.stopPropagation();
                toggleMute();
                renderSummary();
            });
            actions.append(mute);
        }
        const link = el("a", "pet-btn pet-btn-primary", primaryLabel);
        link.href = primaryHref;
        actions.append(link);
        return actions;
    }

    // 完整面板里的“隐藏桌宠”：收进托盘，不是彻底退出
    function appendDesktopHideAction(actions) {
        if (!state.config.desktop || !global.desktopApi?.hidePet) return;
        const hideBtn = el("button", "pet-btn pet-btn-muted", "隐藏桌宠");
        hideBtn.type = "button";
        hideBtn.title = "收进 Windows 托盘，点托盘图标可以叫回来喵";
        hideBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            global.desktopApi.hidePet();
        });
        actions.append(hideBtn);
    }

    function formatTrigger(triggerAt, today) {
        const text = String(triggerAt || "");
        if (!text) return "";
        const dateKey = text.slice(0, 10);
        const time = text.slice(11, 16);
        if (today && dateKey === today) return `今天 ${time}`;
        return `${dateKey.slice(5)} ${time}`;
    }

    // ------------------------------------------------------------
    // 设置面板（直接嵌在气泡里）
    // ------------------------------------------------------------
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

    function normalizeClientSettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        return {
            intervalEnabled: source.intervalEnabled !== false,
            intervalMinutes: toBoundedInt(
                source.intervalMinutes,
                CLIENT_DEFAULTS.intervalMinutes,
                5,
                480
            ),
            intervalWithinWorkHours: source.intervalWithinWorkHours === true,
            workStart: normalizeTimeText(source.workStart, CLIENT_DEFAULTS.workStart),
            workEnd: normalizeTimeText(source.workEnd, CLIENT_DEFAULTS.workEnd),
            workStartEnabled: source.workStartEnabled !== false,
            workEndEnabled: source.workEndEnabled !== false,
            dueLeadMinutes: toBoundedInt(
                source.dueLeadMinutes,
                CLIENT_DEFAULTS.dueLeadMinutes,
                0,
                1440
            ),
            petImageUrl: typeof source.petImageUrl === "string" ? source.petImageUrl : ""
        };
    }

    function buildSettingsHead() {
        const head = el("div", "pet-bubble-head");
        const copy = el("div");
        copy.append(el("span", "pet-bubble-kicker", "桌宠设置"));
        copy.append(el("div", "pet-bubble-title", "提醒设置"));
        head.append(copy);

        const headActions = el("div", "pet-head-actions");
        const back = el("button", "pet-link-btn", "返回");
        back.type = "button";
        back.addEventListener("click", (event) => {
            event.stopPropagation();
            renderSummary();
            void refresh();
        });
        const close = el("button", "pet-close", "\u00d7");
        close.type = "button";
        close.setAttribute("aria-label", "关闭");
        close.addEventListener("click", (event) => {
            event.stopPropagation();
            hideBubble();
        });
        headActions.append(back, close);
        head.append(headActions);
        return head;
    }

    function settingsLabel(title, subtitle) {
        const node = el("div", "pet-set-label");
        node.append(el("strong", "", title), el("small", "", subtitle));
        return node;
    }

    function createSwitch(checked, onChange) {
        const label = el("label", "pet-switch");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(checked);
        input.addEventListener("change", () => onChange(input.checked));
        const track = el("span", "pet-switch-track");
        label.append(input, track);
        return label;
    }

    function createNumberInput(value, min, max, step) {
        const input = el("input", "pet-input");
        input.type = "number";
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.inputMode = "numeric";
        input.value = String(value);
        return input;
    }

    function createTimeInput(value) {
        const input = el("input", "pet-input");
        input.type = "time";
        input.step = "60";
        input.value = value;
        return input;
    }

    function showSettingsError(node, message) {
        node.textContent = message;
        node.classList.remove("hidden");
    }

    function validateSettingsDraft(draft) {
        const intervalMinutes = Number(draft.intervalMinutes);
        if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 480) {
            return { error: "提醒间隔需在 5 - 480 分钟之间喵" };
        }
        const dueLeadMinutes = Number(draft.dueLeadMinutes);
        if (!Number.isInteger(dueLeadMinutes) || dueLeadMinutes < 0 || dueLeadMinutes > 1440) {
            return { error: "提前提醒需在 0 - 1440 分钟之间喵" };
        }
        const workStart = normalizeTimeText(draft.workStart, "");
        const workEnd = normalizeTimeText(draft.workEnd, "");
        if (!workStart || !workEnd) return { error: "上下班时间格式不正确喵" };
        if (workEnd <= workStart) return { error: "下班时间要晚于上班时间喵" };
        return {
            settings: {
                intervalEnabled: Boolean(draft.intervalEnabled),
                intervalMinutes,
                intervalWithinWorkHours: Boolean(draft.intervalWithinWorkHours),
                workStart,
                workEnd,
                workStartEnabled: Boolean(draft.workStartEnabled),
                workEndEnabled: Boolean(draft.workEndEnabled),
                dueLeadMinutes
            }
        };
    }

    async function fetchSettings(renderWhenReady) {
        const token = currentToken();
        if (!token) return false;
        try {
            const res = await fetch(`${state.config.apiBase}/todo-widget/settings`, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store"
            });
            if (!res.ok) return false;
            const json = await res.json();
            if (!json || !json.res || !json.settings) return false;
            state.settings = normalizeClientSettings(json.settings);
            if (renderWhenReady && state.bubbleOpen && state.bubbleType === "settings") {
                renderSettings(state.settings);
            }
            void syncRemotePetImage(state.settings.petImageUrl);
            return true;
        } catch {
            return false;
        }
    }

    function openSettings() {
        if (!currentToken()) {
            renderLoggedOut();
            return;
        }
        if (state.settings) {
            renderSettings(state.settings);
            return;
        }
        const loading = el("div", "pet-settings");
        loading.append(buildSettingsHead());
        loading.append(el("p", "pet-set-hint", "正在读取提醒设置喵…"));
        showBubble(loading, "settings");
        void fetchSettings(true).then((ok) => {
            if (ok) return;
            if (!state.bubbleOpen || state.bubbleType !== "settings") return;
            state.settings = normalizeClientSettings(CLIENT_DEFAULTS);
            renderSettings(state.settings);
        });
    }

    function renderSettings(rawSettings) {
        if (!currentToken()) {
            renderLoggedOut();
            return;
        }
        const draft = normalizeClientSettings(rawSettings);
        const wrap = el("div", "pet-settings");
        wrap.append(buildSettingsHead());

        const error = el("p", "pet-set-error hidden");

        // 间隔提醒
        const intervalSection = el("div", "pet-set-section");
        const intervalHead = el("div", "pet-set-row");
        intervalHead.append(
            settingsLabel("间隔提醒", "还有没做完的待办时，定时冒个小泡泡喵"),
            createSwitch(draft.intervalEnabled, (value) => {
                draft.intervalEnabled = value;
                sync();
            })
        );
        const intervalRow = el("div", "pet-set-inline-row");
        intervalRow.append(el("span", "pet-set-text", "每"));
        const intervalInput = createNumberInput(draft.intervalMinutes, 5, 480, 5);
        intervalInput.setAttribute("aria-label", "提醒间隔分钟数");
        intervalInput.addEventListener("input", () => {
            draft.intervalMinutes = Number(intervalInput.value);
        });
        intervalRow.append(intervalInput, el("span", "pet-set-text", "分钟提醒一次"));
        const workHoursCheck = el("label", "pet-set-check");
        const workHoursInput = document.createElement("input");
        workHoursInput.type = "checkbox";
        workHoursInput.checked = draft.intervalWithinWorkHours;
        workHoursInput.addEventListener("change", () => {
            draft.intervalWithinWorkHours = workHoursInput.checked;
        });
        workHoursCheck.append(workHoursInput, el("span", "", "仅在工作时间内提醒"));
        intervalSection.append(intervalHead, intervalRow, workHoursCheck);
        intervalSection.append(el("p", "pet-set-hint", "示例：老大还有 3 件事未完成喵～"));

        // 上下班提醒
        const workSection = el("div", "pet-set-section");
        workSection.append(settingsLabel("上下班提醒", "到点提醒老大还有多少事没做完喵"));

        const startRow = el("div", "pet-set-inline-row");
        const startInput = createTimeInput(draft.workStart);
        startInput.setAttribute("aria-label", "上班时间");
        startInput.addEventListener("change", () => {
            draft.workStart = startInput.value || "";
        });
        startRow.append(
            el("span", "pet-set-text", "上班"),
            startInput,
            createSwitch(draft.workStartEnabled, (value) => {
                draft.workStartEnabled = value;
                sync();
            })
        );

        const endRow = el("div", "pet-set-inline-row");
        const endInput = createTimeInput(draft.workEnd);
        endInput.setAttribute("aria-label", "下班时间");
        endInput.addEventListener("change", () => {
            draft.workEnd = endInput.value || "";
        });
        endRow.append(
            el("span", "pet-set-text", "下班"),
            endInput,
            createSwitch(draft.workEndEnabled, (value) => {
                draft.workEndEnabled = value;
                sync();
            })
        );
        workSection.append(
            startRow,
            endRow,
            el("p", "pet-set-hint", "下班时间也作为“只有日期”任务的截止时刻喵。")
        );

        // 截止提醒
        const dueSection = el("div", "pet-set-section");
        dueSection.append(settingsLabel("截止提醒", "快到期时提前喊你一声喵"));
        const dueRow = el("div", "pet-set-inline-row");
        dueRow.append(el("span", "pet-set-text", "提前"));
        const dueInput = createNumberInput(draft.dueLeadMinutes, 0, 1440, 1);
        dueInput.setAttribute("aria-label", "截止提醒提前分钟数");
        dueInput.addEventListener("input", () => {
            draft.dueLeadMinutes = Number(dueInput.value);
        });
        dueRow.append(dueInput, el("span", "pet-set-text", "分钟"));

        const chips = el("div", "pet-set-chips");
        for (const minutes of [5, 15, 30, 60]) {
            const chip = el("button", "pet-chip", minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`);
            chip.type = "button";
            chip.addEventListener("click", () => {
                dueInput.value = String(minutes);
                draft.dueLeadMinutes = minutes;
            });
            chips.append(chip);
        }
        dueSection.append(
            dueRow,
            chips,
            el("p", "pet-set-hint", "设为 0 表示关闭喵；只有日期没有时间的任务按下班时间。")
        );

        // 素材设置：角色图片保存在服务器，大小与提醒音保存在本机
        const assetSection = el("div", "pet-set-section");
        assetSection.append(settingsLabel("素材设置", "角色图片保存在服务器，大小与提醒音保存在本机喵"));

        const assetRow = el("div", "pet-asset-row");
        const thumb = el("span", "pet-asset-thumb");
        thumb.append(createPetVisual());
        state.assetThumb = thumb;
        const importBtn = el("button", "pet-btn", "导入图片");
        importBtn.type = "button";
        const resetAssetBtn = el("button", "pet-btn", "恢复默认");
        resetAssetBtn.type = "button";
        const fileInput = el("input", "hidden");
        fileInput.type = "file";
        fileInput.accept = "image/png,image/jpeg,image/webp,image/gif";
        assetRow.append(thumb, importBtn, resetAssetBtn, fileInput);

        const assetStatus = el("p", "pet-set-status hidden");
        importBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = "";
            if (!file) return;
            assetStatus.classList.add("hidden");
            error.classList.add("hidden");
            importBtn.disabled = true;
            resetAssetBtn.disabled = true;
            const result = await uploadPetImage(file);
            importBtn.disabled = false;
            resetAssetBtn.disabled = false;
            if (result.error) {
                showSettingsError(error, result.error);
                return;
            }
            assetStatus.textContent = "角色图片已更新喵～";
            assetStatus.classList.remove("hidden");
        });
        resetAssetBtn.addEventListener("click", async () => {
            assetStatus.classList.add("hidden");
            error.classList.add("hidden");
            importBtn.disabled = true;
            resetAssetBtn.disabled = true;
            const result = await removePetImage();
            importBtn.disabled = false;
            resetAssetBtn.disabled = false;
            if (result.error) {
                showSettingsError(error, result.error);
                return;
            }
            assetStatus.textContent = "已恢复默认形象喵～";
            assetStatus.classList.remove("hidden");
        });

        const sizeRow = el("div", "pet-set-inline-row");
        sizeRow.append(el("span", "pet-set-text", "大小"));
        const sizeInput = document.createElement("input");
        sizeInput.type = "range";
        sizeInput.className = "pet-range";
        sizeInput.min = String(state.config.petSizeMin);
        sizeInput.max = String(state.config.petSizeMax);
        sizeInput.step = "4";
        sizeInput.value = String(state.petSize);
        sizeInput.setAttribute("aria-label", "桌宠大小");
        const sizeText = el("span", "pet-set-text", `${state.petSize}px`);
        sizeInput.addEventListener("input", () => {
            state.petSize = toBoundedInt(
                sizeInput.value,
                state.config.petSize,
                state.config.petSizeMin,
                state.config.petSizeMax
            );
            sizeText.textContent = `${state.petSize}px`;
            applyPetSize(true);
        });
        sizeRow.append(sizeInput, sizeText);

        const mirroredCheck = el("label", "pet-set-check");
        const mirroredInput = document.createElement("input");
        mirroredInput.type = "checkbox";
        mirroredInput.checked = state.petMirrored;
        mirroredInput.addEventListener("change", () => {
            state.petMirrored = mirroredInput.checked;
            writeStorage(state.config.petMirroredKey, state.petMirrored ? "1" : "0");
            const rect = state.root.getBoundingClientRect();
            applyPosition(rect.left, rect.top, false);
        });
        mirroredCheck.append(mirroredInput, el("span", "", "镜像角色（默认关闭）"));

        const mirrorCheck = el("label", "pet-set-check");
        const mirrorInput = document.createElement("input");
        mirrorInput.type = "checkbox";
        mirrorInput.checked = state.petMirror;
        mirrorInput.addEventListener("change", () => {
            state.petMirror = mirrorInput.checked;
            writeStorage(state.config.petMirrorKey, state.petMirror ? "1" : "0");
            const rect = state.root.getBoundingClientRect();
            applyPosition(rect.left, rect.top, false);
        });
        mirrorCheck.append(mirrorInput, el("span", "", "贴右侧时镜像转身（默认关闭）"));

        const soundCheck = el("label", "pet-set-check");
        const soundInput = document.createElement("input");
        soundInput.type = "checkbox";
        soundInput.checked = !state.muted;
        soundInput.addEventListener("change", () => {
            state.muted = !soundInput.checked;
            writeStorage(state.config.mutedKey, state.muted ? "1" : "0");
        });
        soundCheck.append(soundInput, el("span", "", "提醒音"));

        assetSection.append(assetRow, sizeRow, mirroredCheck, mirrorCheck, soundCheck, assetStatus);
        assetSection.append(
            el(
                "p",
                "pet-set-hint",
                "图片最大 2MB，支持 PNG / JPG / WebP / GIF；角色图片按账号同步，大小、镜像与提醒音只影响当前浏览器喵。"
            )
        );

        // 桌面版专属操作：切换显示器、隐藏到托盘、打开待办与退出桌宠
        let desktopSection = null;
        if (state.config.desktop && global.desktopApi) {
            desktopSection = el("div", "pet-set-section");
            desktopSection.append(settingsLabel("桌面桌宠", "透明覆盖当前显示器，可收进 Windows 托盘喵"));

            const displayRow = el("div", "pet-set-inline-row");
            displayRow.append(el("span", "pet-set-text", "显示器"));
            const displaySelect = document.createElement("select");
            displaySelect.className = "pet-input pet-select";
            displaySelect.setAttribute("aria-label", "桌宠所在显示器");
            displaySelect.disabled = true;
            displayRow.append(displaySelect);
            desktopSection.append(displayRow);

            void (async () => {
                try {
                    const info = await global.desktopApi.getDisplays?.();
                    if (!info || !Array.isArray(info.displays) || info.displays.length === 0) return;
                    displaySelect.replaceChildren();
                    for (const display of info.displays) {
                        const option = document.createElement("option");
                        option.value = String(display.id);
                        option.textContent = display.label || `显示器 ${display.id}`;
                        displaySelect.append(option);
                    }
                    displaySelect.value = String(info.currentId);
                    displaySelect.disabled = info.displays.length < 2;
                } catch {
                    /* 获取显示器失败时保持禁用 */
                }
            })();

            displaySelect.addEventListener("change", () => {
                const displayId = Number(displaySelect.value);
                if (Number.isFinite(displayId)) global.desktopApi.moveToDisplay?.(displayId);
            });

            // 调试模式：由页面（desktop-pet.html）绘制舞台边框与命中区域
            const debugCheck = el("label", "pet-set-check");
            const debugInput = document.createElement("input");
            debugInput.type = "checkbox";
            debugInput.checked = state.debugFrame;
            debugInput.addEventListener("change", () => {
                state.debugFrame = debugInput.checked;
                writeStorage(state.config.debugFrameKey, state.debugFrame ? "1" : "0");
                global.dispatchEvent(
                    new CustomEvent("gitstatus-pet-debug-frame", {
                        detail: { enabled: state.debugFrame }
                    })
                );
            });
            debugCheck.append(debugInput, el("span", "", "调试模式：显示舞台边框与命中区域"));
            desktopSection.append(debugCheck);

            const desktopRow = el("div", "pet-set-inline-row");
            const hideBtn = el("button", "pet-btn pet-btn-muted", "隐藏桌宠");
            hideBtn.type = "button";
            hideBtn.addEventListener("click", () => {
                global.desktopApi.hidePet?.();
            });
            const todoBtn = el("button", "pet-btn", "打开待办");
            todoBtn.type = "button";
            todoBtn.addEventListener("click", () => {
                global.desktopApi.openTodo?.();
            });
            const quitBtn = el("button", "pet-btn pet-btn-muted", "退出桌宠");
            quitBtn.type = "button";
            quitBtn.addEventListener("click", () => {
                global.desktopApi.quit?.();
            });
            desktopRow.append(hideBtn, todoBtn, quitBtn);
            desktopSection.append(desktopRow);
        }

        const footer = el("div", "pet-set-footer");
        const defaultsBtn = el("button", "pet-btn pet-btn-muted", "恢复默认");
        defaultsBtn.type = "button";
        defaultsBtn.addEventListener("click", () => {
            renderSettings(CLIENT_DEFAULTS);
        });
        const cancelBtn = el("button", "pet-btn", "返回");
        cancelBtn.type = "button";
        cancelBtn.addEventListener("click", () => {
            renderSummary();
            void refresh();
        });
        const saveBtn = el("button", "pet-btn pet-btn-primary", "保存");
        saveBtn.type = "button";
        saveBtn.addEventListener("click", async () => {
            const validation = validateSettingsDraft(draft);
            if (validation.error) {
                showSettingsError(error, validation.error);
                return;
            }
            const token = currentToken();
            if (!token) {
                showSettingsError(error, "登录已过期，请重新登录喵");
                return;
            }
            saveBtn.disabled = true;
            saveBtn.textContent = "保存中…";
            try {
                const res = await fetch(`${state.config.apiBase}/todo-widget/settings`, {
                    method: "PUT",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(validation.settings)
                });
                let json = {};
                try {
                    json = await res.json();
                } catch {
                    /* 响应不是 JSON 时按失败处理 */
                }
                if (!res.ok || !json.res) {
                    throw new Error(json.message || `保存失败（${res.status}）`);
                }
                state.settings = normalizeClientSettings(json.settings);
                // 重新开始间隔计时，避免刚改完设置就立刻弹一次
                writeStorage(state.config.intervalLastKey, String(Date.now()));
                // 上下班时间可能已变化，清空当天已提醒标记以便按新时间判断
                writeStorage(state.config.workStateKey, null);
                writeStorage(state.config.settingsStampKey, String(Date.now()));
                error.classList.add("hidden");
                saveBtn.textContent = "已保存喵";
                window.setTimeout(() => {
                    if (saveBtn.isConnected) saveBtn.textContent = "保存";
                }, 1600);
                void refresh();
            } catch (submitError) {
                showSettingsError(error, submitError.message || "保存失败喵");
                saveBtn.textContent = "保存";
            } finally {
                saveBtn.disabled = false;
            }
        });
        footer.append(defaultsBtn, cancelBtn, saveBtn);

        const sections = [intervalSection, workSection, dueSection, assetSection];
        if (desktopSection) sections.push(desktopSection);
        wrap.append(...sections, error, footer);

        function sync() {
            intervalInput.disabled = !draft.intervalEnabled;
            workHoursInput.disabled = !draft.intervalEnabled;
            startInput.disabled = !draft.workStartEnabled;
            endInput.disabled = !draft.workEndEnabled;
        }
        sync();
        showBubble(wrap, "settings");
    }

    function renderLoggedOut() {
        const wrap = el("div");
        wrap.append(buildHead("GITSTATUS 桌宠", "老大还没登录喵", undefined, true));
        wrap.append(el("p", "pet-hint", "登录后我才能帮你盯着当天的待办喵～"));

        const actions = el("div", "pet-actions");
        if (typeof state.config.onLogin === "function") {
            const loginBtn = el("button", "pet-btn pet-btn-primary", "去登录喵");
            loginBtn.type = "button";
            loginBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                state.config.onLogin();
            });
            actions.append(loginBtn);
        } else {
            const link = el("a", "pet-btn pet-btn-primary", "去登录喵");
            link.href = state.config.todoUrl;
            actions.append(link);
        }
        // 桌面版未登录时也留隐藏 / 退出入口
        if (state.config.desktop && global.desktopApi?.hidePet) {
            const hideBtn = el("button", "pet-btn pet-btn-muted", "隐藏桌宠");
            hideBtn.type = "button";
            hideBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                global.desktopApi.hidePet();
            });
            actions.append(hideBtn);
        }
        if (state.config.desktop && global.desktopApi?.quit) {
            const quitBtn = el("button", "pet-btn pet-btn-muted", "退出桌宠");
            quitBtn.type = "button";
            quitBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                global.desktopApi.quit();
            });
            actions.append(quitBtn);
        }
        wrap.append(actions);
        showBubble(wrap, "logout");
    }

    function renderSummary() {
        if (!currentToken()) {
            renderLoggedOut();
            return;
        }
        const data = state.summary;
        if (!data) {
            const wrap = el("div");
            wrap.append(buildHead("GITSTATUS 桌宠", "正在看看待办喵…", undefined, true));
            const actions = buildActions("去待办喵", state.config.todoUrl);
            appendDesktopHideAction(actions);
            wrap.append(actions);
            showBubble(wrap, "summary");
            return;
        }

        const stats = data.stats || {};
        const pending = Number(stats.pending) || 0;
        const overdue = Number(stats.overdue) || 0;
        const completed = Number(stats.completed) || 0;

        const wrap = el("div");
        wrap.append(
            buildHead(
                "今天 · " + String(data.today || "").slice(5),
                pending > 0
                    ? `老大还有 ${pending} 件事没做完喵～`
                    : "今天的待办都完成啦喵，老大真棒！",
                undefined,
                true
            )
        );

        if (pending > 0 || completed > 0) {
            const row = el("div", "pet-stat-row");
            const pendingStat = el("span", "pet-stat");
            pendingStat.append(el("strong", "", String(pending)), document.createTextNode("没做完"));
            row.append(pendingStat);
            if (overdue > 0) {
                const overdueStat = el("span", "pet-stat is-danger");
                overdueStat.append(el("strong", "", String(overdue)), document.createTextNode("逾期了喵"));
                row.append(overdueStat);
            }
            if (completed > 0) {
                const doneStat = el("span", "pet-stat");
                doneStat.append(el("strong", "", String(completed)), document.createTextNode("搞定啦"));
                row.append(doneStat);
            }
            wrap.append(row);
        }

        const preview = Array.isArray(data.preview) ? data.preview : [];
        if (preview.length > 0) {
            const list = el("ul", "pet-list");
            for (const item of preview) {
                const li = el("li", "pet-list-item" + (item.isOverdue ? " is-overdue" : ""));
                li.append(el("span", "pet-list-title", String(item.title || "未命名待办")));
                if (item.dueTime) li.append(el("span", "pet-list-time", String(item.dueTime)));
                list.append(li);
            }
            wrap.append(list);
        }

        if (data.nextReminder) {
            const next = el("div", "pet-next");
            next.append(
                document.createTextNode(
                    "下一条提醒喵 · " + formatTrigger(data.nextReminder.triggerAt, data.today) + " "
                ),
                el("strong", "", String(data.nextReminder.title || "还有待办在等你喵"))
            );
            wrap.append(next);
        }

        const actions = buildActions(
            "去待办喵",
            state.config.todoUrl,
            state.muted ? "提醒音：关喵" : "提醒音：开喵"
        );
        appendDesktopHideAction(actions);
        wrap.append(actions);
        showBubble(wrap, "summary");
    }

    // ------------------------------------------------------------
    // 提醒文案与气泡
    // ------------------------------------------------------------
    function makeServerNotice(event) {
        return {
            kicker: "待办提醒喵",
            title: String(event.title || "有一条待办在等你喵"),
            message: "说好的提醒时间到啦喵 · " + formatTrigger(event.triggerAt, state.summary?.today),
            snoozeMinutes: 10
        };
    }

    function makeDueNotice(item) {
        const minutes = Math.max(1, Number(item.minutesLeft) || 0);
        return {
            kicker: "快到期了喵",
            title: `「${item.title}」还有 ${minutes} 分钟就到截止时间喵！`,
            message: "老大记得抽空处理一下喵～",
            snoozeMinutes: 5
        };
    }

    function makeIntervalNotice(pending, overdue) {
        const lines = [
            `老大还有 ${pending} 件事未完成喵～`,
            `喵！还有 ${pending} 件事在等你，老大～`,
            `${pending} 件待办还没搞定喵，老大加油！`,
            `老大老大，还有 ${pending} 件事没做完喵！`,
            `喵来提醒啦：还有 ${pending} 件待办喵～`,
            `${pending} 件事在等老大翻牌喵～`
        ];
        return {
            kicker: "待办提醒",
            title: lines[Math.floor(Math.random() * lines.length)],
            message: overdue > 0
                ? `其中 ${overdue} 件已经逾期了喵…`
                : "记得一件一件来喵～"
        };
    }

    function makeWorkStartNotice(pending) {
        return {
            kicker: "早上好喵",
            title: `老大早～今天还有 ${pending} 件事要完成喵！`,
            message: "先从最重要的一件开始吧喵～"
        };
    }

    function makeWorkEndNotice(pending, overdue) {
        return {
            kicker: "下班时间到啦喵",
            title: `还有 ${pending} 件事没完成喵…`,
            message: overdue > 0
                ? `其中 ${overdue} 件已经逾期了，老大要不要先处理一下喵？`
                : "要不要先收个尾再走喵？"
        };
    }

    function renderNotice(notice) {
        const wrap = el("div");
        wrap.append(buildHead(notice.kicker || "待办提醒", notice.title || ""));
        if (notice.message) wrap.append(el("p", "pet-hint", notice.message));

        const actions = el("div", "pet-actions");
        if (notice.snoozeMinutes) {
            const later = el("button", "pet-btn", "稍后提醒");
            later.type = "button";
            later.addEventListener("click", (clickEvent) => {
                clickEvent.stopPropagation();
                // 只在页面内延后，不改变服务端提醒记录
                const snoozed = { ...notice, snoozeMinutes: 0, silent: false };
                window.setTimeout(() => {
                    state.queue.unshift(snoozed);
                    showNextReminder();
                }, notice.snoozeMinutes * 60 * 1000);
                hideBubble();
            });
            actions.append(later);
        }
        const link = el("a", "pet-btn pet-btn-primary", notice.actionLabel || "去待办喵");
        link.href = notice.href || state.config.todoUrl;
        actions.append(link);
        wrap.append(actions);

        showBubble(wrap, "reminder");
        if (notice.silent) return;
        state.root.classList.add("is-alert");
        clearTimer("alertTimer");
        state.alertTimer = window.setTimeout(() => {
            state.root.classList.remove("is-alert");
        }, 2600);
        playChime();
        notifySystem(notice.kicker || "待办提醒", notice.title || "");
    }

    function queueNotice(notice) {
        if (!notice) return;
        state.queue.push(notice);
        showNextReminder();
    }

    // ------------------------------------------------------------
    // 提醒事件
    // ------------------------------------------------------------
    function showNextReminder() {
        // 拖拽中不打断手势，松手后会再次尝试
        if (state.drag && state.drag.moved) return;
        // 提醒气泡或设置面板正在显示时不抢占，关闭后会继续排队
        if (state.bubbleOpen && (state.bubbleType === "reminder" || state.bubbleType === "settings")) {
            return;
        }
        if (state.queue.length === 0) return;
        const notice = state.queue.shift();
        renderNotice(notice);
    }

    function handleIncoming(events, dueSoon) {
        const fresh = [];
        const accept = (key, notice) => {
            if (!notice || typeof key !== "string" || !key) return;
            if (state.seen.has(key)) return;
            state.seen.add(key);
            fresh.push(notice);
        };
        if (Array.isArray(events)) {
            for (const event of events) {
                if (event) accept(event.key, makeServerNotice(event));
            }
        }
        if (Array.isArray(dueSoon)) {
            for (const item of dueSoon) {
                if (item) accept(item.key, makeDueNotice(item));
            }
        }
        if (fresh.length === 0) return;
        persistSeen();
        for (const notice of fresh) state.queue.push(notice);
        showNextReminder();
    }

    function persistSeen() {
        const keys = Array.from(state.seen).slice(-200);
        state.seen = new Set(keys);
        writeStorage(state.config.seenKey, JSON.stringify(keys));
    }

    function updateBadge(stats) {
        const pending = Number(stats?.pending) || 0;
        const overdue = Number(stats?.overdue) || 0;
        if (pending <= 0) {
            state.badge.textContent = "";
            state.badge.classList.remove("is-visible", "is-danger");
            state.avatar.setAttribute("aria-label", "桌宠喵：今天的待办都完成啦");
            return;
        }
        state.badge.textContent = pending > 99 ? "99+" : String(pending);
        state.badge.classList.add("is-visible");
        state.badge.classList.toggle("is-danger", overdue > 0);
        state.avatar.setAttribute(
            "aria-label",
            `桌宠喵：今天还有 ${pending} 件事没做完${overdue > 0 ? `，${overdue} 件逾期了` : ""}`
        );
    }

    function clearBadge() {
        state.badge.textContent = "";
        state.badge.classList.remove("is-visible", "is-danger");
    }

    // ------------------------------------------------------------
    // 提示音与系统通知
    // ------------------------------------------------------------
    function playChime() {
        if (state.muted) return;
        try {
            const Ctx = global.AudioContext || global.webkitAudioContext;
            if (!Ctx) return;
            if (!state.audioCtx) state.audioCtx = new Ctx();
            const ctx = state.audioCtx;
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

    function notifySystem(title, body) {
        try {
            if (!("Notification" in global)) return;
            // 只复用用户已授予的权限，不主动弹授权框
            if (global.Notification.permission !== "granted") return;
            new global.Notification(title, { body, tag: "gitstatus-todo" });
        } catch {
            /* 忽略系统通知失败 */
        }
    }

    function toggleMute() {
        state.muted = !state.muted;
        writeStorage(state.config.mutedKey, state.muted ? "1" : "0");
    }

    // ------------------------------------------------------------
    // 本地提醒：间隔提醒与上下班提醒
    // ------------------------------------------------------------
    const pad2 = (value) => String(value).padStart(2, "0");

    function localDayKey(date) {
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    function minutesOfDay(date) {
        return date.getHours() * 60 + date.getMinutes();
    }

    function timeToMinutes(text) {
        const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text || ""));
        return match ? Number(match[1]) * 60 + Number(match[2]) : null;
    }

    function withinWorkHours(settings, date) {
        const start = timeToMinutes(settings.workStart);
        const end = timeToMinutes(settings.workEnd);
        if (start === null || end === null || end <= start) return true;
        const current = minutesOfDay(date);
        return current >= start && current < end;
    }

    function currentStats() {
        const stats = state.summary?.stats || {};
        const pending = Math.max(0, Number(stats.pending) || 0);
        const overdue = Math.max(0, Number(stats.overdue) || 0);
        const completed = Math.max(0, Number(stats.completed) || 0);
        const total = Math.max(0, Number(stats.total) || pending + completed);
        return { pending, overdue, completed, total };
    }

    function runLocalReminderChecks() {
        if (document.hidden || !state.tokenPresent || !state.settings) return;
        const now = new Date();
        maybeIntervalReminder(now);
        maybeWorkMomentReminder(now);
    }

    function maybeIntervalReminder(now) {
        const settings = state.settings;
        if (!settings || !settings.intervalEnabled) return;
        const { pending, overdue } = currentStats();
        if (pending <= 0) return;
        if (settings.intervalWithinWorkHours && !withinWorkHours(settings, now)) return;

        const intervalMs = Math.max(1, Number(settings.intervalMinutes) || 60) * 60000;
        const last = Number(readStorage(state.config.intervalLastKey)) || 0;
        const nowMs = now.getTime();
        if (!last) {
            writeStorage(state.config.intervalLastKey, String(nowMs));
            return;
        }
        const elapsed = nowMs - last;
        if (elapsed < intervalMs) return;
        // 页面长时间未打开时不补发，重新开始计时，避免一打开就连弹
        if (elapsed > intervalMs * 2) {
            writeStorage(state.config.intervalLastKey, String(nowMs));
            return;
        }
        writeStorage(state.config.intervalLastKey, String(nowMs));
        queueNotice(makeIntervalNotice(pending, overdue));
    }

    function readWorkState(dayKey) {
        const saved = readJson(state.config.workStateKey, null);
        if (!saved || saved.date !== dayKey) {
            return { date: dayKey, start: false, end: false };
        }
        return { date: dayKey, start: Boolean(saved.start), end: Boolean(saved.end) };
    }

    function writeWorkState(work) {
        writeStorage(state.config.workStateKey, JSON.stringify(work));
    }

    function maybeWorkMomentReminder(now) {
        const settings = state.settings;
        if (!settings) return;
        const { pending, overdue } = currentStats();
        if (pending <= 0) return;

        const dayKey = localDayKey(now);
        const work = readWorkState(dayKey);
        const current = minutesOfDay(now);
        const grace = Math.max(1, Number(state.config.workGraceMinutes) || 10);
        let changed = false;

        if (settings.workStartEnabled && !work.start) {
            const start = timeToMinutes(settings.workStart);
            if (start !== null) {
                if (current >= start && current < start + grace) {
                    work.start = true;
                    writeWorkState(work);
                    queueNotice(makeWorkStartNotice(pending));
                    return;
                }
                if (current >= start + grace) {
                    // 已超过生效窗口，标记为已过，避免稍后突然补发
                    work.start = true;
                    changed = true;
                }
            }
        }

        if (settings.workEndEnabled && !work.end) {
            const end = timeToMinutes(settings.workEnd);
            if (end !== null) {
                if (current >= end && current < end + grace) {
                    work.end = true;
                    writeWorkState(work);
                    queueNotice(makeWorkEndNotice(pending, overdue));
                    return;
                }
                if (current >= end + grace) {
                    work.end = true;
                    changed = true;
                }
            }
        }

        if (changed) writeWorkState(work);
    }

    // ------------------------------------------------------------
    // 数据
    // ------------------------------------------------------------
    async function refresh() {
        if (document.hidden) return;
        const token = currentToken();
        if (!token) {
            state.tokenPresent = false;
            state.summary = null;
            clearBadge();
            if (state.remotePetImageUrl) void syncRemotePetImage("", true);
            if (state.miniOpen) renderMini();
            if (state.bubbleOpen && state.bubbleType === "summary") renderLoggedOut();
            return;
        }

        const seq = ++state.requestSeq;
        const url = new URL(state.config.apiBase + "/todo-widget/summary", global.location.origin);
        if (state.lastSync) url.searchParams.set("since", state.lastSync);

        try {
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store"
            });
            if (seq !== state.requestSeq) return;
            if (res.status === 401) {
                state.tokenPresent = false;
                state.summary = null;
                clearBadge();
                if (state.remotePetImageUrl) void syncRemotePetImage("", true);
                return;
            }
            const json = await res.json();
            if (!res.ok || !json.res) return;

            state.tokenPresent = true;
            state.summary = json;
            if (json.settings && typeof json.settings === "object") {
                state.settings = normalizeClientSettings(json.settings);
                void syncRemotePetImage(state.settings.petImageUrl);
            }
            if (typeof json.now === "string" && json.now) state.lastSync = json.now;
            updateBadge(json.stats);
            handleIncoming(json.events, json.dueSoon);
            // 刷新后立即检查本地到期的间隔 / 上下班提醒
            runLocalReminderChecks();
            if (state.miniOpen) renderMini();
            // 气泡正在被阅读时不刷新内容，避免打断悬停与重新计时
            if (state.bubbleOpen && state.bubbleType === "summary" && !state.hoverBubble) {
                renderSummary();
            }
        } catch {
            /* 网络抖动时保持上一次状态 */
        }
    }

    // ------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------
    function wake() {
        state.root?.classList.remove("is-idle");
        clearTimer("idleTimer");
        state.idleTimer = window.setTimeout(() => {
            state.root?.classList.add("is-idle");
        }, state.config.idleAfterMs);
    }

    function onResize() {
        console.debug("[pet] resize", global.innerWidth, global.innerHeight, state.awaitingStageLayout, Boolean(state.drag));
        // 松手后等主进程展开舞台并回传锚点，期间不要擅自重排
        if (state.awaitingStageLayout) return;
        if (state.config.desktopStage && state.stageAnchor) {
            // 拖动开始/结束都会改变舞台尺寸，必须按锚点重摆，
            // 否则桌宠会停在旧视口算出的位置，甚至跑到紧凑窗口外面。
            applyStageAnchor(state.stageAnchor);
        } else if (state.drag) {
            // 首次拖动还没有锚点，等主进程的 anchor 事件统一归位
            return;
        } else {
            const rect = state.root.getBoundingClientRect();
            applyPosition(rect.left, rect.top, false);
        }
        placeBubble();
        positionMini();
    }

    function onStorage(event) {
        if (event.key === state.config.tokenKey) {
            void refresh();
            return;
        }
        if (event.key === state.config.settingsStampKey) void refresh();
    }

    // 主进程隐藏后（若非销毁路径）用 hiddenByMain + visibilitychange 兜底恢复
    let hiddenByMain = false;

    function markHiddenByMain() {
        hiddenByMain = true;
        document.body.classList.add("pet-hidden");
    }

    function restoreFromMainHidden() {
        if (!hiddenByMain) return;
        hiddenByMain = false;
        document.body.classList.remove("pet-hidden");
        showMiniNotice("welcome");
    }

    function onVisibility() {
        if (document.hidden) return;
        restoreFromMainHidden();
        void refresh();
    }

    function init(options) {
        if (state.inited) return api;
        if (options && typeof options === "object") {
            state.config = { ...state.config, ...options };
        }
        readPetAssetSettings();
        createDom();

        state.muted = readStorage(state.config.mutedKey) === "1";
        state.debugFrame = readStorage(state.config.debugFrameKey) === "1";
        const seen = readJson(state.config.seenKey, []);
        state.seen = new Set(Array.isArray(seen) ? seen : []);

        applyPetSize(false);
        restorePosition();
        if (state.config.desktop) {
            global.desktopApi?.onPetEvent?.((type) => {
                if (type === "hidden") markHiddenByMain();
                else if (type === "after-show") restoreFromMainHidden();
            });
            const rect = state.root.getBoundingClientRect();
            reportDesktopPosition(rect.left, rect.top);
        }
        wake();

        state.avatar.addEventListener("pointerdown", onPointerDown);
        state.avatar.addEventListener("click", (event) => {
            // 键盘触发的 click（detail 为 0）没有 pointer 事件，这里补上
            if (event.detail === 0) toggleMini();
        });
        state.avatar.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                if (state.miniOpen) {
                    event.stopPropagation();
                    hideMini();
                    return;
                }
                if (state.bubbleOpen) {
                    event.stopPropagation();
                    hideBubble();
                }
            }
        });
        state.menuBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            togglePanel();
        });
        state.bubble.addEventListener("pointerenter", () => {
            state.hoverBubble = true;
            clearTimer("hideTimer");
        });
        state.bubble.addEventListener("pointerleave", () => {
            state.hoverBubble = false;
            if (state.bubbleOpen) scheduleHide(state.bubbleType);
        });
        state.bubble.addEventListener("pointerdown", (event) => event.stopPropagation());
        state.root.addEventListener("contextmenu", (event) => event.preventDefault());

        global.addEventListener("resize", onResize);
        global.addEventListener("orientationchange", onResize);
        global.addEventListener("storage", onStorage);
        document.addEventListener("visibilitychange", onVisibility);

        state.pollTimer = window.setInterval(() => void refresh(), state.config.pollMs);
        state.tickTimer = window.setInterval(runLocalReminderChecks, state.config.tickMs);
        state.inited = true;
        void refresh();
        return api;
    }

    function destroy() {
        clearTimer("pollTimer");
        clearTimer("hideTimer");
        clearTimer("idleTimer");
        clearTimer("alertTimer");
        clearTimer("miniTimer");
        window.clearInterval(state.pollTimer);
        window.clearInterval(state.tickTimer);
        global.removeEventListener("resize", onResize);
        global.removeEventListener("orientationchange", onResize);
        global.removeEventListener("storage", onStorage);
        document.removeEventListener("visibilitychange", onVisibility);
        revokeRemotePetImage();
        state.root?.remove();
        state.inited = false;
    }

    function applyStageAnchor(anchor) {
        if (!state.config.desktopStage || !state.root) return;
        const size = petSize();
        const margin = state.config.margin;
        const place = () => {
            if (!state.root) return;
            applyPosition(
                anchor?.right === false ? margin : global.innerWidth - size - margin,
                anchor?.bottom === false ? margin : global.innerHeight - size - margin,
                false
            );
        };
        place();
        // 舞台刚被主进程收缩/展开时 innerWidth 可能还差一帧才更新，
        // 下一帧按新尺寸再校正一次，避免桌宠先落在旧角落再跳回来。
        global.requestAnimationFrame(place);
    }

    function setStageAnchor(anchor) {
        if (!state.config.desktopStage || !state.root) return;
        console.debug("[pet] anchor", global.innerWidth, global.innerHeight, JSON.stringify(anchor));
        state.stageAnchor = {
            right: anchor?.right !== false,
            bottom: anchor?.bottom !== false
        };
        state.awaitingStageLayout = false;
        // 拖动刚开始时主进程刚把舞台收缩，先等一帧让窗口尺寸生效再定位
        if (state.drag?.windowStarted) {
            global.requestAnimationFrame(() => applyStageAnchor(state.stageAnchor));
            return;
        }
        applyStageAnchor(state.stageAnchor);
    }

    const api = {
        init,
        destroy,
        refresh: () => void refresh(),
        showSummary: () => renderSummary(),
        /** 桌面版隐藏 / 回来时的小气泡文案 */
        showMiniNotice: (kind) => showMiniNotice(kind),
        setStageAnchor,
        /** 切换显示器后回到目标区域右下角（桌面版传入虚拟桌面内的局部区域） */
        resetPosition: (bounds) => {
            if (!state.root) return;
            const size = petSize();
            const target =
                bounds &&
                Number.isFinite(Number(bounds.left)) &&
                Number.isFinite(Number(bounds.top)) &&
                Number.isFinite(Number(bounds.width)) &&
                Number.isFinite(Number(bounds.height))
                    ? bounds
                    : null;
            if (target) {
                applyPosition(
                    Number(target.left) + Number(target.width) - size - state.config.margin,
                    Number(target.top) + Number(target.height) - size - state.config.margin,
                    true
                );
                return;
            }
            applyPosition(
                global.innerWidth - size - state.config.margin,
                global.innerHeight - size - state.config.margin,
                true
            );
        },
        /** 外部预览气泡（设置页使用），默认不响铃不抖动弹通知 */
        showNotice: (notice) => {
            if (!notice) return;
            queueNotice({ silent: true, ...notice });
        },
        hideBubble,
        version: "1.4.0"
    };

    global.GitStatusPet = api;

    const autoInit = () => {
        if (global.GITSTATUS_PET_DISABLED) return;
        try {
            // 桌面版在应用内打开待办页时用 noPet=1 避免出现第二只桌宠
            if (new URLSearchParams(global.location.search).get("noPet") === "1") return;
        } catch {
            /* 地址解析失败时按正常显示 */
        }
        // 桌面桌宠窗口由桌面进程控制；所有网页页面统一受「页面桌宠」开关控制，默认隐藏
        if (!state.config.desktop && readStorage("gitstatus_pet_todo_visible_v1") !== "1") {
            return;
        }
        init();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", autoInit, { once: true });
    } else {
        autoInit();
    }
})(window);
