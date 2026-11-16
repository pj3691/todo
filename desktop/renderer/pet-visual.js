/* ============================================================
   桌宠造型（桌宠窗、设置窗预览共用）
   默认使用内联 SVG，账号上传素材后切换为图片；图片加载失败回退 SVG
   ============================================================ */
(function (global) {
    "use strict";

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

    function createSvg() {
        const doc = new DOMParser().parseFromString(PET_SVG.trim(), "text/html");
        return doc.body.firstElementChild || document.createElement("span");
    }

    function createVisual(imageUrl, alt) {
        const url = String(imageUrl || "").trim();
        if (url) {
            const img = document.createElement("img");
            img.className = "pet-image";
            img.src = url;
            img.alt = alt || "桌宠";
            img.decoding = "async";
            img.draggable = false;
            img.addEventListener("error", () => img.replaceWith(createSvg()), { once: true });
            return img;
        }
        return createSvg();
    }

    global.PetVisual = { createSvg, createVisual };
})(window);
