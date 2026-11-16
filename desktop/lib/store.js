/* ============================================================
   桌面版本地状态读写
   - 窗口位置、桌宠偏好、登录 token、提醒进度都落在 userData
   - 写入失败只影响持久化，不让主流程抛错
   ============================================================ */
const fs = require("fs");
const path = require("path");

function readJson(file, fallback) {
    try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        return value === null || value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
        return true;
    } catch {
        return false;
    }
}

function removeFile(file) {
    try {
        fs.unlinkSync(file);
    } catch {
        /* 文件不存在时忽略 */
    }
}

module.exports = { readJson, writeJson, removeFile };
