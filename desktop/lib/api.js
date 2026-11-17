/* ============================================================
   桌面版 HTTP 访问层
   - 渲染进程是本地 file:// 页面，跨域受限，所有请求统一由主进程发出
   - token 由登录窗口回传后保存在主进程，请求时带 Bearer
   - 角色素材在主进程解码：纯色背景图按边缘连通区域抠成透明底
   ============================================================ */
const { nativeImage } = require("electron");

const API_PREFIX = "/gitstatus/api";
const PET_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

function createApi({ serverUrl, getToken }) {
    const base = String(serverUrl || "").replace(/\/+$/, "");

    function absolute(target) {
        const text = String(target || "");
        if (/^https?:\/\//i.test(text)) return text;
        return `${base}${text.startsWith("/") ? "" : "/"}${text}`;
    }

    function authHeaders(extra) {
        const headers = { ...(extra || {}) };
        const token = String(getToken() || "").trim();
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 12000));
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    /** 统一请求：网络异常以 networkError 标记，交给调用方判断离线 */
    async function request(pathname, options) {
        try {
            const res = await fetchWithTimeout(absolute(pathname), {
                ...(options || {}),
                headers: authHeaders(options && options.headers)
            });
            let json = null;
            try {
                json = await res.json();
            } catch {
                /* 非 JSON 响应按空对象处理 */
            }
            return { ok: res.ok, status: res.status, json, networkError: false };
        } catch (error) {
            return { ok: false, status: 0, json: null, networkError: true, error };
        }
    }

    async function summary(since) {
        const query = since ? `?since=${encodeURIComponent(since)}` : "";
        return request(`${API_PREFIX}/todo-widget/summary${query}`, { cache: "no-store" });
    }

    async function settings() {
        return request(`${API_PREFIX}/todo-widget/settings`, { cache: "no-store" });
    }

    async function saveSettings(payload) {
        return request(`${API_PREFIX}/todo-widget/settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload || {})
        });
    }

    async function uploadPetImage(buffer, mime, filename) {
        const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
        if (!bytes.length) return { ok: false, status: 400, json: { res: false, message: "没有选择图片喵" } };
        if (bytes.length > PET_IMAGE_MAX_BYTES) {
            return { ok: false, status: 400, json: { res: false, message: "图片别超过 2MB 喵" } };
        }
        const type = String(mime || "image/png").toLowerCase();
        const form = new FormData();
        form.append("file", new Blob([bytes], { type }), String(filename || "pet.png"));
        return request(`${API_PREFIX}/todo-widget/assets/pet`, { method: "POST", body: form });
    }

    async function deletePetImage() {
        return request(`${API_PREFIX}/todo-widget/assets/pet`, { method: "DELETE" });
    }

    function dataUrlFor(buffer, mime) {
        const cleanMime = String(mime || "image/png").split(";")[0].trim().toLowerCase() || "image/png";
        if (!/^image\//.test(cleanMime)) return "";
        // GIF 可能是动图，不能走 nativeImage（只会保留第一帧）
        if (!/gif/.test(cleanMime)) {
            const processed = stripSolidBackground(buffer);
            if (processed && processed.length) {
                return `data:image/png;base64,${processed.toString("base64")}`;
            }
        }
        return `data:${cleanMime};base64,${buffer.toString("base64")}`;
    }

    /**
     * 纯色背景 PNG/JPG/WebP 抠透明底：
     * 取四角颜色作为背景色，从边缘做连通区域泛洪，命中区域 alpha 置 0。
     * 四角本来就透明、或背景占比过小时原样返回。
     */
    function stripSolidBackground(buffer) {
        try {
            const image = nativeImage.createFromBuffer(buffer);
            if (!image || image.isEmpty()) return null;
            const { width, height } = image.getSize();
            if (!width || !height || width * height > 16_000_000) return null;
            const bitmap = image.getBitmap();
            if (!bitmap || bitmap.length < width * height * 4) return null;

            const total = width * height;
            const cornerIndexes = [0, width - 1, (height - 1) * width, total - 1];
            const corners = cornerIndexes.map((index) => ({
                b: bitmap[index * 4],
                g: bitmap[index * 4 + 1],
                r: bitmap[index * 4 + 2],
                a: bitmap[index * 4 + 3]
            }));
            if (corners.filter((corner) => corner.a < 16).length >= 3) return null;

            const opaque = corners.filter((corner) => corner.a >= 16);
            const background = opaque.reduce(
                (acc, corner) => ({
                    b: acc.b + corner.b / opaque.length,
                    g: acc.g + corner.g / opaque.length,
                    r: acc.r + corner.r / opaque.length
                }),
                { b: 0, g: 0, r: 0 }
            );
            const tolerance = 28;
            const cornerMatches = corners.filter((corner) => {
                if (corner.a < 16) return true;
                const db = corner.b - background.b;
                const dg = corner.g - background.g;
                const dr = corner.r - background.r;
                return Math.sqrt(db * db + dg * dg + dr * dr) <= tolerance;
            }).length;
            if (cornerMatches < 3) return null;

            const matchesBackground = (index) => {
                const offset = index * 4;
                if (bitmap[offset + 3] < 16) return true;
                const db = bitmap[offset] - background.b;
                const dg = bitmap[offset + 1] - background.g;
                const dr = bitmap[offset + 2] - background.r;
                return Math.sqrt(db * db + dg * dg + dr * dr) <= tolerance;
            };
            const visited = new Uint8Array(total);
            const queue = new Uint32Array(total);
            let head = 0;
            let tail = 0;
            const enqueue = (index) => {
                if (visited[index] || !matchesBackground(index)) return;
                visited[index] = 1;
                bitmap[index * 4] = 0;
                bitmap[index * 4 + 1] = 0;
                bitmap[index * 4 + 2] = 0;
                bitmap[index * 4 + 3] = 0;
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
            if (tail / total < 0.02) return null;
            const out = nativeImage.createFromBitmap(bitmap, { width, height });
            if (!out || out.isEmpty()) return null;
            return out.toPNG();
        } catch {
            return null;
        }
    }

    /** 取角色素材并转成可直接给 <img src> 的 data URL */
    async function fetchPetImageDataUrl(petImageUrl) {
        const target = String(petImageUrl || "").trim();
        if (!target) return "";
        const res = await fetchWithTimeout(absolute(target), {
            headers: authHeaders(),
            cache: "no-store"
        }, 15000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const mime = res.headers.get("content-type") || "image/png";
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > PET_IMAGE_MAX_BYTES * 2) throw new Error("pet image too large");
        return dataUrlFor(buffer, mime);
    }

    return {
        absolute,
        summary,
        settings,
        saveSettings,
        uploadPetImage,
        deletePetImage,
        fetchPetImageDataUrl
    };
}

module.exports = { createApi, API_PREFIX };
