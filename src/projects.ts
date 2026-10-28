import { execFile, execFileSync, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import type Database from "better-sqlite3";

type ProjectType =
    | "node"
    | "python"
    | "java"
    | "go"
    | "rust"
    | "php"
    | "dotnet"
    | "custom";

type ProjectStatus = "stopped" | "starting" | "running" | "stopping" | "error";

type ProjectRow = {
    id: number;
    name: string;
    path: string;
    type: ProjectType;
    command: string;
    folder: string;
    intro: string;
    created_by: number | null;
    created_at: string;
    updated_at: string;
};

type ProjectCommandRow = {
    id: number;
    project_id: number;
    name: string;
    command: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
};

type ProjectLinkRow = {
    id: number;
    project_id: number;
    name: string;
    url: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
};

type ProjectFolderRow = {
    name: string;
    path: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
};

type ProjectFolderDto = {
    name: string;
    path: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
};

type ProjectCommandDto = {
    id: number;
    name: string;
    command: string;
};

type ProjectLinkDto = {
    id: number;
    name: string;
    url: string;
};

type ParsedProjectLink = {
    name: string;
    url: string;
};

type DetectedCommand = {
    name: string;
    command: string;
};

type ProjectLog = {
    seq: number;
    stream: "stdout" | "stderr" | "system";
    text: string;
    at: string;
};

type ProjectRuntime = {
    status: ProjectStatus;
    pid: number | null;
    child: ChildProcess | null;
    logs: ProjectLog[];
    seq: number;
    stopRequested: boolean;
    stopTimer: NodeJS.Timeout | null;
    startedAt: number | null;
};

type ProcessUsageRow = {
    pid: number;
    ppid: number;
    memoryBytes: number;
    cpuMs: number;
};

type ProcessTable = {
    at: number;
    rows: Map<number, ProcessUsageRow>;
    children: Map<number, number[]>;
};

type CommandRunStatus = "running" | "stopping" | "success" | "error" | "stopped";

type CommandRunRuntime = {
    id: number;
    projectId: number;
    commandId: number;
    name: string;
    command: string;
    status: CommandRunStatus;
    pid: number | null;
    child: ChildProcess | null;
    logs: ProjectLog[];
    seq: number;
    stopRequested: boolean;
    stopTimer: NodeJS.Timeout | null;
    startedAt: string;
    finishedAt: string | null;
    exitCode: number | null;
};

type CommandRunDto = {
    id: number;
    projectId: number;
    commandId: number;
    name: string;
    command: string;
    status: CommandRunStatus;
    pid: number | null;
    startedAt: string;
    finishedAt: string | null;
    exitCode: number | null;
};

type LogSink = {
    logs: ProjectLog[];
    seq: number;
};

type ProjectDto = {
    id: number;
    name: string;
    path: string;
    type: ProjectType;
    typeLabel: string;
    command: string;
    startCommand: string;
    folder: string;
    intro: string;
    runCommands: ProjectCommandDto[];
    links: ProjectLinkDto[];
    status: ProjectStatus;
    pid: number | null;
    createdAt: string;
    updatedAt: string;
};

type DetectionResult = {
    path: string;
    name: string;
    type: ProjectType;
    typeLabel: string;
    command: string;
    startCommand: string;
    commands: DetectedCommand[];
    detectedType: ProjectType;
    detectedTypeLabel: string;
};

type EditorId = "vscode" | "qoder" | "explorer";

const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = ["starting", "running", "stopping"];

type AuthedRequest = express.Request & {
    user?: {
        userId?: number;
        username?: string;
        role?: string;
    };
};

type RegisterProjectOptions = {
    db: Database.Database;
    apiPrefix: string;
    authMiddleware: express.RequestHandler;
    requireWrite: express.RequestHandler;
    logInfo: (message: string) => void;
    logWarn: (message: string) => void;
    logError: (message: string, error?: unknown) => void;
};

const PROJECT_TYPES: ProjectType[] = [
    "node",
    "python",
    "java",
    "go",
    "rust",
    "php",
    "dotnet",
    "custom",
];

const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
    node: "Node.js",
    python: "Python",
    java: "Java",
    go: "Go",
    rust: "Rust",
    php: "PHP",
    dotnet: ".NET",
    custom: "自定义",
};

const LOG_LIMIT = 600;
const LOG_TEXT_LIMIT = 16_000;

const isProjectType = (value: unknown): value is ProjectType =>
    typeof value === "string" && PROJECT_TYPES.includes(value as ProjectType);

class ProjectError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

const resolveProjectDirectory = (rawPath: unknown): string => {
    const text = String(rawPath ?? "").trim();
    if (!text) throw new ProjectError(400, "请输入项目地址");
    if (text.includes("\0")) throw new ProjectError(400, "项目地址不合法");

    const resolved = path.resolve(text);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolved);
    } catch {
        throw new ProjectError(400, "项目地址不存在");
    }
    if (!stat.isDirectory()) throw new ProjectError(400, "项目地址必须是文件夹");
    return resolved;
};

const resolveFolderPath = (rawPath: unknown): string => {
    const text = String(rawPath ?? "").trim();
    if (!text) return "";
    if (text.includes("\0")) throw new ProjectError(400, "文件夹路径不合法");

    const resolved = path.resolve(text);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolved);
    } catch {
        throw new ProjectError(400, "文件夹路径不存在");
    }
    if (!stat.isDirectory()) throw new ProjectError(400, "文件夹路径必须是文件夹");
    return resolved;
};

const pickNativeFolder = (initialPath = ""): Promise<string> => {
    if (process.platform === "win32") {
        const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择文件夹'
$dialog.ShowNewFolderButton = $true
if ($env:GITSTATUS_PICK_DIR -and (Test-Path -LiteralPath $env:GITSTATUS_PICK_DIR)) {
    $dialog.SelectedPath = $env:GITSTATUS_PICK_DIR
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
}
`;
        return new Promise((resolve, reject) => {
            execFile(
                "powershell.exe",
                ["-NoProfile", "-STA", "-Command", script],
                {
                    env: { ...process.env, GITSTATUS_PICK_DIR: initialPath },
                    windowsHide: true,
                    timeout: 300_000,
                    maxBuffer: 1024 * 1024,
                },
                (error, stdout) => {
                    if (error) {
                        if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
                            reject(new ProjectError(408, "文件夹选择超时"));
                            return;
                        }
                        reject(new ProjectError(500, "无法打开文件夹选择器"));
                        return;
                    }
                    const encoded = String(stdout || "").trim();
                    if (!encoded) {
                        resolve("");
                        return;
                    }
                    try {
                        resolve(Buffer.from(encoded, "base64").toString("utf8"));
                    } catch {
                        reject(new ProjectError(500, "无法读取文件夹选择结果"));
                    }
                }
            );
        });
    }

    if (process.platform === "darwin") {
        return new Promise((resolve, reject) => {
            execFile(
                "osascript",
                ["-e", 'POSIX path of (choose folder with prompt "选择文件夹")'],
                { timeout: 300_000 },
                (error, stdout) => {
                    if (error) {
                        if (Number((error as NodeJS.ErrnoException).code) === 1) resolve("");
                        else reject(new ProjectError(500, "无法打开文件夹选择器"));
                        return;
                    }
                    resolve(String(stdout || "").trim());
                }
            );
        });
    }

    return new Promise((resolve, reject) => {
        execFile(
            "zenity",
            ["--file-selection", "--directory", "--title=选择文件夹"],
            { timeout: 300_000 },
            (error, stdout) => {
                if (error) {
                    if (Number((error as NodeJS.ErrnoException).code) === 1) resolve("");
                    else reject(new ProjectError(500, "当前系统无法打开文件夹选择器"));
                    return;
                }
                resolve(String(stdout || "").trim());
            }
        );
    });
};

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

const hasFile = (dir: string, name: string): boolean => {
    try {
        return fs.existsSync(path.join(dir, name));
    } catch {
        return false;
    }
};

const listDir = (dir: string): string[] => {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
};

type NodePackageInfo = {
    manager: "npm" | "yarn" | "pnpm" | "bun";
    scripts: Record<string, unknown>;
    runScript: (script: string) => string;
};

const getNodePackageInfo = (dir: string): NodePackageInfo => {
    const pkg = readJsonFile(path.join(dir, "package.json"));
    const scripts =
        pkg && pkg.scripts && typeof pkg.scripts === "object"
            ? (pkg.scripts as Record<string, unknown>)
            : {};
    const manager = hasFile(dir, "pnpm-lock.yaml")
        ? "pnpm"
        : hasFile(dir, "yarn.lock")
          ? "yarn"
          : hasFile(dir, "bun.lockb") || hasFile(dir, "bun.lock")
            ? "bun"
            : "npm";
    const runScript = (script: string): string => {
        if (manager === "yarn") return script === "start" ? "yarn start" : `yarn ${script}`;
        if (manager === "pnpm") return script === "start" ? "pnpm start" : `pnpm run ${script}`;
        if (manager === "bun") return `bun run ${script}`;
        return script === "start" ? "npm start" : `npm run ${script}`;
    };
    return { manager, scripts, runScript };
};

const detectNodeCommand = (dir: string): string => {
    const { scripts, runScript } = getNodePackageInfo(dir);
    const hasScript = (name: string) => typeof scripts[name] === "string" && String(scripts[name]).trim();

    for (const script of ["dev", "start", "serve", "preview"]) {
        if (hasScript(script)) return runScript(script);
    }

    for (const entry of ["index.js", "index.mjs", "index.cjs", "server.js", "app.js", "src/index.js"]) {
        if (hasFile(dir, entry)) return `node ${entry}`;
    }
    return "npm start";
};

const detectPythonCommand = (dir: string): string => {
    if (hasFile(dir, "manage.py")) return "python manage.py runserver";
    if (hasFile(dir, "main.py")) return "python main.py";
    if (hasFile(dir, "app.py")) return "python app.py";
    return "python main.py";
};

const detectJavaCommand = (dir: string): string => {
    const files = listDir(dir);
    if (files.includes("pom.xml")) return "mvn spring-boot:run";

    const gradle = files.find((name) => name === "gradlew.bat" || name === "gradlew");
    if (gradle) {
        const runner = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
        return `${runner} bootRun`;
    }

    const jar = files.find(
        (name) => name.toLowerCase().endsWith(".jar") && !name.toLowerCase().includes("sources")
    );
    return jar ? `java -jar "${jar.replace(/"/g, '\\"')}"` : "mvn spring-boot:run";
};

const detectCommandForType = (type: ProjectType, dir: string): string => {
    switch (type) {
        case "node":
            return detectNodeCommand(dir);
        case "python":
            return detectPythonCommand(dir);
        case "java":
            return detectJavaCommand(dir);
        case "go":
            return "go run .";
        case "rust":
            return "cargo run";
        case "php":
            return "php -S localhost:8000";
        case "dotnet":
            return "dotnet run";
        case "custom":
        default:
            return "";
    }
};

const detectSuggestedCommands = (
    type: ProjectType,
    dir: string,
    startCommand: string
): DetectedCommand[] => {
    const suggestions: DetectedCommand[] = [];
    const add = (name: string, command: string) => {
        const text = String(command || "").trim();
        if (!text || text === startCommand) return;
        if (suggestions.some((item) => item.command === text)) return;
        suggestions.push({ name, command: text });
    };

    if (type === "node") {
        const { manager, scripts, runScript } = getNodePackageInfo(dir);
        for (const name of Object.keys(scripts)) {
            if (typeof scripts[name] !== "string") continue;
            add(name, runScript(name));
            if (suggestions.length >= 12) break;
        }
        if (suggestions.length === 0) add("安装依赖", `${manager} install`);
    } else if (type === "python") {
        if (hasFile(dir, "requirements.txt")) add("安装依赖", "pip install -r requirements.txt");
        if (hasFile(dir, "manage.py")) add("数据库迁移", "python manage.py migrate");
        if (
            hasFile(dir, "pytest.ini") ||
            hasFile(dir, "pyproject.toml") ||
            listDir(dir).includes("tests")
        ) {
            add("测试", "python -m pytest");
        }
    } else if (type === "java") {
        const files = listDir(dir);
        if (files.includes("pom.xml")) {
            add("构建", "mvn clean package");
            add("测试", "mvn test");
        } else if (files.includes("gradlew.bat") || files.includes("gradlew")) {
            const runner = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
            add("构建", `${runner} build`);
            add("测试", `${runner} test`);
        }
    } else if (type === "go") {
        add("构建", "go build ./...");
        add("测试", "go test ./...");
    } else if (type === "rust") {
        add("构建", "cargo build");
        add("测试", "cargo test");
    } else if (type === "php") {
        if (hasFile(dir, "composer.json")) add("安装依赖", "composer install");
    } else if (type === "dotnet") {
        add("构建", "dotnet build");
        add("测试", "dotnet test");
    }

    return suggestions.slice(0, 12);
};

const detectTypeForDirectory = (dir: string): ProjectType => {
    const files = listDir(dir);
    const lowerFiles = files.map((name) => name.toLowerCase());

    if (files.includes("package.json")) return "node";
    if (
        files.some((name) =>
            ["pyproject.toml", "requirements.txt", "manage.py", "main.py", "app.py"].includes(name)
        )
    ) {
        return "python";
    }
    if (
        files.some((name) => ["pom.xml", "build.gradle", "build.gradle.kts"].includes(name)) ||
        lowerFiles.some((name) => name.endsWith(".jar"))
    ) {
        return "java";
    }
    if (files.includes("go.mod")) return "go";
    if (files.includes("Cargo.toml")) return "rust";
    if (files.includes("composer.json")) return "php";
    if (lowerFiles.some((name) => name.endsWith(".csproj") || name.endsWith(".sln"))) return "dotnet";
    return "custom";
};

const detectProject = (rawPath: unknown, requestedType?: unknown): DetectionResult => {
    const projectPath = resolveProjectDirectory(rawPath);
    const detectedType = detectTypeForDirectory(projectPath);
    const type = isProjectType(requestedType) ? requestedType : detectedType;
    const name = path.basename(projectPath) || projectPath;
    const startCommand = detectCommandForType(type, projectPath);
    return {
        path: projectPath,
        name,
        type,
        typeLabel: PROJECT_TYPE_LABELS[type],
        command: startCommand,
        startCommand,
        commands: detectSuggestedCommands(type, projectPath, startCommand),
        detectedType,
        detectedTypeLabel: PROJECT_TYPE_LABELS[detectedType],
    };
};

const formatDateTime = (date = new Date()): string => {
    const pad = (value: number) => String(value).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
};

const formatLogTime = (): string => {
    const date = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const stripAnsi = (text: string): string =>
    text
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

// Windows 中文系统的 cmd 默认是 GBK(936)，启动前先切到 UTF-8。
// Java/Python 等未必跟随代码页，因此还要配合下面的逐块编码探测。
const toShellCommand = (command: string): string =>
    process.platform === "win32" ? `chcp 65001>nul && ${command}` : command;

// 多字节字符可能被切在两个数据块之间，先剥离尾部不完整序列，留给下一块拼接。
const splitIncompleteUtf8Tail = (buffer: Buffer): { head: Buffer; tail: Buffer } => {
    const size = buffer.length;
    if (size === 0) return { head: buffer, tail: Buffer.alloc(0) };
    let index = size - 1;
    while (index >= 0 && ((buffer[index] ?? 0) & 0xc0) === 0x80) index -= 1;
    if (index < 0) return { head: buffer, tail: Buffer.alloc(0) };
    const lead = buffer[index] ?? 0;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > 1 && size - index < need) {
        return { head: buffer.subarray(0, index), tail: buffer.subarray(index) };
    }
    return { head: buffer, tail: Buffer.alloc(0) };
};

// GBK 是 1/2 字节混合编码：顺序扫描，返回末尾被截断的半个字符长度。
const gbkTruncatedTail = (buffer: Buffer): number => {
    let index = 0;
    while (index < buffer.length) {
        if ((buffer[index] ?? 0) < 0x80) {
            index += 1;
            continue;
        }
        if (index + 1 >= buffer.length) return 1;
        index += 2;
    }
    return 0;
};

// 子进程输出编码不统一：Node/npm 多为 UTF-8，Java、部分工具按系统代码页(GBK)输出。
// 先整块试严格 UTF-8，失败且不是跨块截断时回退 GBK，避免控制台中文乱码。
const createOutputDecoder = (): ((chunk: Buffer) => string) => {
    let pending: Buffer = Buffer.alloc(0);
    let gbkMode = false;
    const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
    const gbk = new TextDecoder("gbk");
    const decodeGbk = (buffer: Buffer): string => {
        const tail = gbkTruncatedTail(buffer);
        if (tail > 0) {
            pending = buffer.subarray(buffer.length - tail);
            return gbk.decode(buffer.subarray(0, buffer.length - tail));
        }
        return gbk.decode(buffer);
    };
    return (chunk: Buffer): string => {
        const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
        pending = Buffer.alloc(0);
        if (buffer.length === 0) return "";
        if (gbkMode) return decodeGbk(buffer);
        try {
            return strictUtf8.decode(buffer);
        } catch {
            /* 可能是跨块截断，也可能不是 UTF-8 */
        }
        const { head, tail } = splitIncompleteUtf8Tail(buffer);
        if (tail.length > 0) {
            try {
                const text = strictUtf8.decode(head);
                pending = tail;
                return text;
            } catch {
                /* 不是 UTF-8 截断，继续走 GBK */
            }
        }
        gbkMode = true;
        return decodeGbk(buffer);
    };
};

const isLoopbackRequest = (req: express.Request): boolean => {
    const address = String(req.socket.remoteAddress || "");
    return (
        address === "::1" ||
        address === "127.0.0.1" ||
        address.startsWith("::ffff:127.")
    );
};

const findCommandPath = (names: string[], preferred?: RegExp): string | null => {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    for (const name of names) {
        try {
            const output = execFileSync(finder, [name], { encoding: "utf8" });
            const candidates = output
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
            const matched = preferred
                ? candidates.find((candidate) => preferred.test(candidate))
                : undefined;
            if (matched) return matched;
            if (candidates[0]) return candidates[0];
        } catch {
            /* try next command */
        }
    }
    return null;
};

const hasCommand = (names: string[]): boolean => Boolean(findCommandPath(names));

const findExistingFile = (candidates: Array<string | null | undefined>): string | null => {
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
};

/**
 * Qoder 有两套命令行：`qoder` 是 Qoder CLI（终端 AI），
 * Qoder IDE 自带的 VS Code 风格 CLI 是安装目录下的 bin/code.cmd。
 * 这里优先找 IDE 的 code.cmd，避免误开 Qoder CLI。
 */
const findQoderIdeCli = (): string | null => {
    if (process.platform !== "win32") return null;
    const localPrograms = process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Programs")
        : null;
    const roots = [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        localPrograms,
    ].filter((root): root is string => Boolean(root));
    return findExistingFile(
        roots.map((root) => path.join(root, "Qoder IDE", "bin", "code.cmd"))
    );
};

/**
 * 必须拿到 `code.cmd` 的绝对路径。Windows 下把相对命令交给 shell 时，
 * code.cmd 内部的 %~dp0 可能按当前工作目录解析，最终找不到 Code.exe。
 */
const findVscodeCli = (): string | null => {
    if (process.platform !== "win32") {
        return findCommandPath(["code"]);
    }
    const localPrograms = process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Programs")
        : null;
    const roots = [
        localPrograms,
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
    ].filter((root): root is string => Boolean(root));
    return (
        findExistingFile(
            roots.map((root) => path.join(root, "Microsoft VS Code", "bin", "code.cmd"))
        ) ||
        findCommandPath(["code.cmd", "code"], /microsoft[\\/ ]vs[\\/ ]code/i)
    );
};

const editorAvailability = (): Record<EditorId, boolean> => ({
    vscode: Boolean(findVscodeCli()),
    qoder: Boolean(findQoderIdeCli()),
    explorer: process.platform !== "win32" || fs.existsSync(
        path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "explorer.exe")
    ),
});

const launchEditorCli = (command: string, args: string[], cwd: string): void => {
    if (process.platform === "win32") {
        // Windows 下 code/qoder 都是 .cmd，必须把整条命令交给 shell；
        // 不能把带空格的完整路径和参数分开放进 args 数组，cmd 会拆坏路径。
        const quote = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
        const commandLine = [quote(command), ...args.map(quote)].join(" ");
        const child = spawn(commandLine, {
            cwd,
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            shell: true,
        });
        child.on("error", () => {
            /* 编辑器启动失败由前端提示，不拖垮服务进程 */
        });
        child.unref();
        return;
    }

    const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
    });
    child.on("error", () => {
        /* 编辑器启动失败由前端提示，不拖垮服务进程 */
    });
    child.unref();
};

const PROCESS_TABLE_TTL_MS = 1000;

let processTableCache: ProcessTable | null = null;
let processTableInflight: Promise<ProcessTable | null> | null = null;

const buildProcessTable = (
    at: number,
    rows: Array<{ pid?: unknown; ppid?: unknown; memoryBytes?: unknown; cpuMs?: unknown }>
): ProcessTable => {
    const byPid = new Map<number, ProcessUsageRow>();
    for (const row of rows) {
        const pid = Number(row.pid);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        byPid.set(pid, {
            pid,
            ppid: Number(row.ppid) || 0,
            memoryBytes: Math.max(0, Number(row.memoryBytes) || 0),
            cpuMs: Math.max(0, Number(row.cpuMs) || 0),
        });
    }
    const children = new Map<number, number[]>();
    for (const row of byPid.values()) {
        if (!row.ppid) continue;
        const list = children.get(row.ppid) || [];
        list.push(row.pid);
        children.set(row.ppid, list);
    }
    return { at, rows: byPid, children };
};

const parseUnixCpuTime = (value: string): number => {
    const text = String(value || "").trim();
    if (!text) return 0;
    const split = text.includes("-") ? text.split("-", 2) : ["0", text];
    const dayPart = split[0] || "0";
    const timePart = split[1] || "0";
    const parts = timePart.split(":").map((part) => Number(part) || 0);
    let seconds = 0;
    if (parts.length >= 3) {
        seconds = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
    } else if (parts.length === 2) {
        seconds = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    } else {
        seconds = parts[0] ?? 0;
    }
    return (Number(dayPart) * 86400 + seconds) * 1000;
};

const readWindowsProcessTable = (): Promise<ProcessTable | null> => {
    const powershell = path.join(
        process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
    );
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue';",
        "$items = @(Get-CimInstance Win32_Process | ForEach-Object {",
        "[pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; ws = [long]$_.WorkingSetSize; cpu = [double]$_.UserModeTime + [double]$_.KernelModeTime }",
        "});",
        "if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress }",
    ].join(" ");

    return new Promise((resolve) => {
        execFile(
            powershell,
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout) => {
                if (error || !stdout.trim()) {
                    resolve(null);
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout);
                    const list = Array.isArray(parsed) ? parsed : [parsed];
                    resolve(
                        buildProcessTable(
                            Date.now(),
                            list.map((item: Record<string, unknown>) => ({
                                pid: item.pid,
                                ppid: item.ppid,
                                memoryBytes: item.ws,
                                cpuMs: (Number(item.cpu) || 0) / 10000,
                            }))
                        )
                    );
                } catch {
                    resolve(null);
                }
            }
        );
    });
};

const readUnixProcessTable = (): Promise<ProcessTable | null> => {
    return new Promise((resolve) => {
        execFile(
            "ps",
            ["-axo", "pid=,ppid=,rss=,time="],
            { encoding: "utf8", timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => {
                if (error || !stdout.trim()) {
                    resolve(null);
                    return;
                }
                const rows: Array<{ pid: number; ppid: number; memoryBytes: number; cpuMs: number }> = [];
                for (const line of stdout.split(/\r?\n/)) {
                    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
                    if (!match) continue;
                    rows.push({
                        pid: Number(match[1]),
                        ppid: Number(match[2]),
                        memoryBytes: Number(match[3]) * 1024,
                        cpuMs: parseUnixCpuTime(match[4] || ""),
                    });
                }
                resolve(buildProcessTable(Date.now(), rows));
            }
        );
    });
};

const readProcessTable = (): Promise<ProcessTable | null> => {
    const now = Date.now();
    if (processTableCache && now - processTableCache.at < PROCESS_TABLE_TTL_MS) {
        return Promise.resolve(processTableCache);
    }
    if (processTableInflight) return processTableInflight;
    const task = (process.platform === "win32"
        ? readWindowsProcessTable()
        : readUnixProcessTable())
        .then((table) => {
            if (table) processTableCache = table;
            return table;
        })
        .finally(() => {
            processTableInflight = null;
        });
    processTableInflight = task;
    return task;
};

const collectProcessUsage = (
    table: ProcessTable,
    rootPid: number
): { cpuMs: number; memoryBytes: number; processCount: number } | null => {
    if (!table.rows.has(rootPid)) return null;
    const stack = [rootPid];
    const visited = new Set<number>();
    let cpuMs = 0;
    let memoryBytes = 0;
    let processCount = 0;
    while (stack.length > 0) {
        const pid = stack.pop()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        const row = table.rows.get(pid);
        if (!row) continue;
        processCount += 1;
        cpuMs += row.cpuMs;
        memoryBytes += row.memoryBytes;
        const children = table.children.get(pid);
        if (children) stack.push(...children);
    }
    return { cpuMs, memoryBytes, processCount };
};

// Windows 进程 CPU 计时粒度约 15.6ms，2 秒窗口通常只累计到 0~1 个 tick，
// 再除以逻辑核数会被舍入成 0，因此按滑动窗口取平均来拉长统计窗口。
const CPU_SAMPLE_WINDOW_MS = 10_000;

type CpuSample = { at: number; cpuMs: number; percent: number | null };

type PortUsageEntry = {
    pid: number;
    processName: string;
    protocol: string;
    localAddress: string;
    state: string;
};

// 这些进程一旦结束会拖垮系统或桌面，统一拦截
const PROTECTED_PROCESS_NAMES = new Set([
    "system",
    "system idle process",
    "idle",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
    "explorer.exe",
    "dwm.exe",
    "fontdrvhost.exe",
]);

const parsePortNumber = (value: unknown): number => {
    const port = Number(value);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new ProjectError(400, "端口号必须是 1-65535 之间的整数");
    }
    return port;
};

// 子进程输出可能是 UTF-8 也可能是系统代码页，统一走自适应解码
const runCommandCapture = (command: string, args: string[], timeoutMs = 8000): Promise<string> =>
    new Promise((resolve, reject) => {
        execFile(
            command,
            args,
            { encoding: "buffer", windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""), "utf8");
                resolve(createOutputDecoder()(buffer));
            }
        );
    });

const parseNetstatRows = (output: string, port: number): PortUsageEntry[] => {
    const byPid = new Map<number, PortUsageEntry>();
    for (const line of output.split(/\r?\n/)) {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length < 4) continue;
        const protocol = tokens[0] ?? "";
        if (protocol !== "TCP" && protocol !== "UDP") continue;
        const localAddress = tokens[1] ?? "";
        const localPort = Number(localAddress.split(":").pop());
        if (localPort !== port) continue;
        const pid = Number(tokens[tokens.length - 1]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const state = protocol === "TCP" ? (tokens[3] ?? "") : "";
        const existing = byPid.get(pid);
        if (existing) {
            // 同一进程可能同时监听 IPv4/IPv6，优先保留 LISTENING 记录
            if (existing.state !== "LISTENING" && state === "LISTENING") {
                existing.state = state;
                existing.localAddress = localAddress;
                existing.protocol = protocol;
            }
            continue;
        }
        byPid.set(pid, { pid, processName: "", protocol, localAddress, state });
    }
    return [...byPid.values()];
};

const readWindowsProcessNames = async (): Promise<Map<number, string>> => {
    const map = new Map<number, string>();
    try {
        const output = await runCommandCapture("tasklist", ["/FO", "CSV", "/NH"]);
        for (const line of output.split(/\r?\n/)) {
            const match = line.trim().match(/^"([^"]*)","(\d+)"/);
            if (!match) continue;
            map.set(Number(match[2]), match[1] ?? "");
        }
    } catch {
        /* tasklist 不可用时只显示 PID */
    }
    return map;
};

const listPortUsage = async (port: number): Promise<PortUsageEntry[]> => {
    if (process.platform === "win32") {
        const output = await runCommandCapture("netstat", ["-ano"]);
        const entries = parseNetstatRows(output, port);
        if (entries.length === 0) return [];
        const names = await readWindowsProcessNames();
        return entries.map((entry) => ({ ...entry, processName: names.get(entry.pid) ?? "" }));
    }
    // macOS / Linux：lsof 直接按端口列出监听进程
    try {
        const output = await runCommandCapture("lsof", ["-nP", `-i:${port}`, "-sTCP:LISTEN"]);
        const entries: PortUsageEntry[] = [];
        for (const line of output.split(/\r?\n/).slice(1)) {
            const tokens = line.trim().split(/\s+/);
            if (tokens.length < 9) continue;
            const pid = Number(tokens[1]);
            if (!Number.isInteger(pid) || pid <= 0) continue;
            entries.push({
                pid,
                processName: tokens[0] ?? "",
                protocol: "TCP",
                localAddress: tokens.slice(8).join(" "),
                state: "LISTENING",
            });
        }
        return entries;
    } catch {
        return [];
    }
};

const openProjectInEditor = (projectPath: string, editor: EditorId): string => {
    if (editor === "explorer") {
        if (process.platform === "win32") {
            const explorer = path.join(
                process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
                "explorer.exe"
            );
            if (!fs.existsSync(explorer)) {
                throw new ProjectError(500, "找不到 Windows 文件管理器 explorer.exe");
            }
            const child = spawn(explorer, [projectPath], {
                detached: true,
                stdio: "ignore",
                windowsHide: false,
            });
            child.on("error", () => {
                /* 打不开文件夹时由前端提示，避免进程异常退出 */
            });
            child.unref();
            return "已在文件管理器中打开项目文件夹";
        }

        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        if (!hasCommand([opener])) {
            throw new ProjectError(400, `未找到 ${opener}，无法打开文件夹`);
        }
        launchEditorCli(opener, [projectPath], projectPath);
        return "已在文件管理器中打开项目文件夹";
    }

    let command: string | null = null;
    let args: string[] = [];
    let label = "VS Code";

    if (editor === "vscode") {
        command = findVscodeCli();
        args = ["-n", projectPath];
    } else {
        label = "Qoder IDE";
        command = findQoderIdeCli();
        args = [projectPath];
    }

    if (!command) {
        const tip = editor === "qoder"
            ? "未找到 Qoder IDE 的 CLI，请安装 Qoder IDE（安装目录下应有 bin\\code.cmd）"
            : "未找到 VS Code 命令行工具，请把 code 加入系统 PATH";
        throw new ProjectError(400, tip);
    }

    launchEditorCli(command, args, projectPath);
    return `已用 ${label} 打开项目`;
};

export const registerProjectFeature = (
    app: express.Express,
    options: RegisterProjectOptions
): void => {
    const { db, apiPrefix, authMiddleware, requireWrite, logInfo, logWarn, logError } = options;

    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            command TEXT NOT NULL,
            folder TEXT NOT NULL DEFAULT '',
            created_by INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);

        CREATE TABLE IF NOT EXISTS project_commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_commands_project
            ON project_commands(project_id, sort_order, id);

        CREATE TABLE IF NOT EXISTS project_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_links_project
            ON project_links(project_id, sort_order, id);

        CREATE TABLE IF NOT EXISTS project_folders (
            name TEXT PRIMARY KEY,
            path TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);

    // 兼容旧数据库：项目文件夹是后加字段。
    const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "folder")) {
        db.exec("ALTER TABLE projects ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
    }
    // 项目介绍同样是后加字段。
    if (!projectColumns.some((column) => column.name === "intro")) {
        db.exec("ALTER TABLE projects ADD COLUMN intro TEXT NOT NULL DEFAULT ''");
    }

    // 文件夹排序是后加字段；旧数据按首字母初始化一次。
    const folderColumns = db.prepare("PRAGMA table_info(project_folders)").all() as Array<{ name: string }>;
    if (!folderColumns.some((column) => column.name === "sort_order")) {
        db.exec("ALTER TABLE project_folders ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    }
    const unorderedFolders = db.prepare(
        "SELECT name FROM project_folders WHERE sort_order = 0 ORDER BY name COLLATE NOCASE, name"
    ).all() as Array<{ name: string }>;
    if (unorderedFolders.length > 0) {
        const maxOrderRow = db.prepare(
            "SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM project_folders"
        ).get() as { max_order?: number } | undefined;
        const initOrderStmt = db.prepare(
            "UPDATE project_folders SET sort_order = ?, updated_at = ? WHERE name = ?"
        );
        const now = formatDateTime();
        let nextOrder = (Number(maxOrderRow?.max_order) || 0) + 10;
        unorderedFolders.forEach((row) => {
            initOrderStmt.run(nextOrder, now, row.name);
            nextOrder += 10;
        });
    }

    const runtimes = new Map<number, ProjectRuntime>();
    const commandRuns = new Map<number, CommandRunRuntime>();
    const processCpuSamples = new Map<string, CpuSample[]>();

    const sampleCpuPercent = (
        key: string,
        at: number,
        cpuMs: number,
        cpuCount: number
    ): number | null => {
        const history = processCpuSamples.get(key) ?? [];
        const last = history[history.length - 1];
        if (last && at <= last.at) {
            // 进程表有 1 秒缓存，同一份快照被复用时不再重复计入样本
            return last.percent;
        }
        if (last && cpuMs < last.cpuMs) {
            // 树内进程退出或重启会让累计 CPU 时间回落，旧窗口作废
            history.length = 0;
        }
        const cutoff = at - CPU_SAMPLE_WINDOW_MS;
        const base = history.find((sample) => sample.at >= cutoff) ?? history[history.length - 1];
        let percent: number | null = null;
        if (base && at > base.at && cpuMs >= base.cpuMs) {
            percent = ((cpuMs - base.cpuMs) / (at - base.at) / cpuCount) * 100;
        }
        history.push({ at, cpuMs, percent });
        while (history.length > 2 && (history[0]?.at ?? at) < cutoff) history.shift();
        processCpuSamples.set(key, history);
        return percent;
    };
    let nextRunId = 1;
    let folderPickerBusy = false;

    const listProjectsStmt = db.prepare("SELECT * FROM projects ORDER BY id DESC");
    const getProjectStmt = db.prepare("SELECT * FROM projects WHERE id = ?");
    const listAllProjectCommandsStmt = db.prepare(
        "SELECT * FROM project_commands ORDER BY project_id, sort_order, id"
    );
    const listProjectCommandsStmt = db.prepare(
        "SELECT * FROM project_commands WHERE project_id = ? ORDER BY sort_order, id"
    );
    const getProjectCommandStmt = db.prepare(
        "SELECT * FROM project_commands WHERE id = ? AND project_id = ?"
    );
    const listAllProjectLinksStmt = db.prepare(
        "SELECT * FROM project_links ORDER BY project_id, sort_order, id"
    );
    const listProjectLinksStmt = db.prepare(
        "SELECT * FROM project_links WHERE project_id = ? ORDER BY sort_order, id"
    );
    const listProjectFoldersStmt = db.prepare(
        "SELECT * FROM project_folders ORDER BY sort_order, name COLLATE NOCASE, name"
    );
    const getProjectFolderStmt = db.prepare("SELECT * FROM project_folders WHERE name = ?");
    const insertProjectFolderStmt = db.prepare(
        `INSERT OR IGNORE INTO project_folders (name, path, sort_order, created_at, updated_at)
         VALUES (?, '', ?, ?, ?)`
    );
    const insertNewProjectFolderStmt = db.prepare(
        `INSERT INTO project_folders (name, path, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
    );
    const nextFolderSortOrderStmt = db.prepare(
        "SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM project_folders"
    );
    const updateFolderSortOrderStmt = db.prepare(
        "UPDATE project_folders SET sort_order = ?, updated_at = ? WHERE name = ?"
    );
    const updateProjectFolderStmt = db.prepare(
        "UPDATE project_folders SET name = ?, path = ?, updated_at = ? WHERE name = ?"
    );
    const updateProjectsFolderNameStmt = db.prepare(
        "UPDATE projects SET folder = ?, updated_at = ? WHERE folder = ?"
    );
    const moveProjectFolderStmt = db.prepare(
        "UPDATE projects SET folder = ?, updated_at = ? WHERE id = ?"
    );
    const insertProjectStmt = db.prepare(
        `INSERT INTO projects (name, path, type, command, folder, intro, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateProjectStmt = db.prepare(
        `UPDATE projects SET name = ?, path = ?, type = ?, command = ?, folder = ?, intro = ?, updated_at = ? WHERE id = ?`
    );
    const deleteProjectStmt = db.prepare("DELETE FROM projects WHERE id = ?");
    const deleteProjectCommandsStmt = db.prepare("DELETE FROM project_commands WHERE project_id = ?");
    const insertProjectCommandStmt = db.prepare(
        `INSERT INTO project_commands (project_id, name, command, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    );
    const deleteProjectLinksStmt = db.prepare("DELETE FROM project_links WHERE project_id = ?");
    const insertProjectLinkStmt = db.prepare(
        `INSERT INTO project_links (project_id, name, url, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    );

    const toFolderDto = (row: ProjectFolderRow): ProjectFolderDto => ({
        name: row.name,
        path: row.path || "",
        sortOrder: Number(row.sort_order) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });

    const nextFolderSortOrder = (): number => {
        const row = nextFolderSortOrderStmt.get() as { next_order?: number } | undefined;
        return Number(row?.next_order) || 10;
    };

    const ensureProjectFolder = (name: string): void => {
        if (!name) return;
        const now = formatDateTime();
        insertProjectFolderStmt.run(name, nextFolderSortOrder(), now, now);
    };

    // 旧数据只有 projects.folder 字符串，补一份文件夹元数据（路径为空）。
    const existingFolderRows = db.prepare(
        "SELECT DISTINCT folder FROM projects WHERE TRIM(folder) <> ''"
    ).all() as Array<{ folder: string }>;
    for (const row of existingFolderRows) ensureProjectFolder(row.folder);

    const getRuntime = (id: number): ProjectRuntime => {
        const runtime: ProjectRuntime = runtimes.get(id) ?? {
            status: "stopped",
            pid: null,
            child: null,
            logs: [],
            seq: 0,
            stopRequested: false,
            stopTimer: null,
            startedAt: null,
        };
        if (!runtimes.has(id)) runtimes.set(id, runtime);
        return runtime;
    };

    const clearStopTimer = (runtime: { stopTimer: NodeJS.Timeout | null }): void => {
        if (runtime.stopTimer) {
            clearTimeout(runtime.stopTimer);
            runtime.stopTimer = null;
        }
    };

    const pushLog = (
        runtime: LogSink,
        stream: ProjectLog["stream"],
        text: string
    ): void => {
        const cleaned = stripAnsi(String(text))
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
        if (!cleaned) return;
        const value = cleaned.length > LOG_TEXT_LIMIT
            ? `${cleaned.slice(0, LOG_TEXT_LIMIT)}\n…[输出过长，已截断]`
            : cleaned;
        runtime.seq += 1;
        runtime.logs.push({
            seq: runtime.seq,
            stream,
            text: value,
            at: formatLogTime(),
        });
        if (runtime.logs.length > LOG_LIMIT) {
            runtime.logs.splice(0, runtime.logs.length - LOG_LIMIT);
        }
    };

    const parseRunCommands = (input: unknown): DetectedCommand[] => {
        if (!Array.isArray(input)) return [];
        const result: DetectedCommand[] = [];
        for (const item of input.slice(0, 50)) {
            const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            const command = String(record.command ?? "").trim();
            if (!command) continue;
            if (command.length > 2000) throw new ProjectError(400, "运行命令过长");
            const fallbackName = command.split(/\s+/).slice(0, 2).join(" ");
            const name = (String(record.name ?? "").trim() || fallbackName || "命令").slice(0, 120);
            if (result.some((entry) => entry.command === command)) continue;
            result.push({ name, command });
        }
        return result;
    };

    const parseProjectIntro = (input: unknown): string => {
        const intro = String(input ?? "").replace(/\r\n/g, "\n").trim();
        if (intro.length > 2000) throw new ProjectError(400, "项目介绍不能超过 2000 个字符");
        return intro;
    };

    const parseProjectLinks = (input: unknown): ParsedProjectLink[] => {
        if (!Array.isArray(input)) return [];
        const result: ParsedProjectLink[] = [];
        for (const item of input.slice(0, 50)) {
            const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            const url = String(record.url ?? "").trim();
            if (!url) continue;
            if (url.length > 2000) throw new ProjectError(400, "项目地址过长");
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                throw new ProjectError(400, `项目地址格式不正确：${url}`);
            }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new ProjectError(400, "项目地址需以 http:// 或 https:// 开头");
            }
            const fallbackName = parsed.host || url;
            const name = (String(record.name ?? "").trim() || fallbackName).slice(0, 120);
            if (result.some((entry) => entry.url === url)) continue;
            result.push({ name, url });
        }
        return result;
    };

    const parseProjectFolder = (input: unknown): string => {
        const folder = String(input ?? "").trim().replace(/\s+/g, " ");
        if (folder.length > 80) throw new ProjectError(400, "文件夹名称不能超过 80 个字符");
        return folder;
    };

    const parseFolderName = (input: unknown): string => {
        const folder = parseProjectFolder(input);
        if (!folder) throw new ProjectError(400, "请输入文件夹名称");
        return folder;
    };

    const getProjectCommands = (projectId: number): ProjectCommandDto[] =>
        (listProjectCommandsStmt.all(projectId) as ProjectCommandRow[]).map((row) => ({
            id: row.id,
            name: row.name,
            command: row.command,
        }));

    const getProjectLinks = (projectId: number): ProjectLinkDto[] =>
        (listProjectLinksStmt.all(projectId) as ProjectLinkRow[]).map((row) => ({
            id: row.id,
            name: row.name,
            url: row.url,
        }));

    const getLinksMap = (): Map<number, ProjectLinkDto[]> => {
        const map = new Map<number, ProjectLinkDto[]>();
        for (const row of listAllProjectLinksStmt.all() as ProjectLinkRow[]) {
            const list = map.get(row.project_id) || [];
            list.push({ id: row.id, name: row.name, url: row.url });
            map.set(row.project_id, list);
        }
        return map;
    };

    const getCommandsMap = (): Map<number, ProjectCommandDto[]> => {
        const map = new Map<number, ProjectCommandDto[]>();
        for (const row of listAllProjectCommandsStmt.all() as ProjectCommandRow[]) {
            const list = map.get(row.project_id) || [];
            list.push({ id: row.id, name: row.name, command: row.command });
            map.set(row.project_id, list);
        }
        return map;
    };

    const saveProjectCommands = (projectId: number, commands: DetectedCommand[]): void => {
        deleteProjectCommandsStmt.run(projectId);
        const now = formatDateTime();
        commands.forEach((item, index) => {
            insertProjectCommandStmt.run(projectId, item.name, item.command, index, now, now);
        });
    };

    const saveProjectLinks = (projectId: number, links: ParsedProjectLink[]): void => {
        deleteProjectLinksStmt.run(projectId);
        const now = formatDateTime();
        links.forEach((item, index) => {
            insertProjectLinkStmt.run(projectId, item.name, item.url, index, now, now);
        });
    };

    const createProjectWithCommands = db.transaction(
        (
            name: string,
            projectPath: string,
            type: ProjectType,
            startCommand: string,
            folder: string,
            intro: string,
            createdBy: number | null,
            commands: DetectedCommand[],
            links: ParsedProjectLink[]
        ): number => {
            const now = formatDateTime();
            const info = insertProjectStmt.run(
                name,
                projectPath,
                type,
                startCommand,
                folder,
                intro,
                createdBy,
                now,
                now
            );
            const projectId = Number(info.lastInsertRowid);
            ensureProjectFolder(folder);
            saveProjectCommands(projectId, commands);
            saveProjectLinks(projectId, links);
            return projectId;
        }
    );

    const updateProjectWithCommands = db.transaction(
        (
            id: number,
            name: string,
            projectPath: string,
            type: ProjectType,
            startCommand: string,
            folder: string,
            intro: string | null,
            commands: DetectedCommand[] | null,
            links: ParsedProjectLink[] | null
        ): void => {
            const current = findProject(id);
            updateProjectStmt.run(
                name,
                projectPath,
                type,
                startCommand,
                folder,
                intro ?? current?.intro ?? "",
                formatDateTime(),
                id
            );
            ensureProjectFolder(folder);
            if (commands !== null) saveProjectCommands(id, commands);
            if (links !== null) saveProjectLinks(id, links);
        }
    );

    const renameProjectFolder = db.transaction(
        (oldName: string, name: string, folderPath: string): void => {
            if (oldName !== name && getProjectFolderStmt.get(name)) {
                throw new ProjectError(409, "已存在同名文件夹");
            }
            const now = formatDateTime();
            updateProjectFolderStmt.run(name, folderPath, now, oldName);
            if (oldName !== name) updateProjectsFolderNameStmt.run(name, now, oldName);
        }
    );

    const moveProjectToFolder = db.transaction((projectId: number, folder: string): void => {
        ensureProjectFolder(folder);
        moveProjectFolderStmt.run(folder, formatDateTime(), projectId);
    });

    const reorderProjectFolders = db.transaction((names: string[]): void => {
        const now = formatDateTime();
        names.forEach((name, index) => {
            if (!getProjectFolderStmt.get(name)) throw new ProjectError(404, `文件夹不存在：${name}`);
            updateFolderSortOrderStmt.run((index + 1) * 10, now, name);
        });
    });

    const toDto = (row: ProjectRow, commands?: ProjectCommandDto[], links?: ProjectLinkDto[]): ProjectDto => {
        const runtime = runtimes.get(row.id);
        return {
            id: row.id,
            name: row.name,
            path: row.path,
            type: row.type,
            typeLabel: PROJECT_TYPE_LABELS[row.type] || row.type,
            command: row.command,
            startCommand: row.command,
            folder: row.folder || "",
            intro: row.intro || "",
            runCommands: commands ?? getProjectCommands(row.id),
            links: links ?? getProjectLinks(row.id),
            status: runtime?.status || "stopped",
            pid: runtime?.pid ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    };

    const toRunDto = (run: CommandRunRuntime): CommandRunDto => ({
        id: run.id,
        projectId: run.projectId,
        commandId: run.commandId,
        name: run.name,
        command: run.command,
        status: run.status,
        pid: run.pid,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        exitCode: run.exitCode,
    });

    const findProject = (id: number): ProjectRow | undefined =>
        getProjectStmt.get(id) as ProjectRow | undefined;

    const findProjectCommand = (projectId: number, commandId: number): ProjectCommandRow | undefined =>
        getProjectCommandStmt.get(commandId, projectId) as ProjectCommandRow | undefined;

    const fail = (res: express.Response, error: unknown): void => {
        if (error instanceof ProjectError) {
            res.status(error.status).json({ res: false, message: error.message });
            return;
        }
        logError("[projects] request failed", error);
        res.status(500).json({ res: false, message: "项目操作失败，请查看服务端日志" });
    };

    const startProject = (row: ProjectRow): ProjectRuntime => {
        const runtime = getRuntime(row.id);
        if (runtime.status === "starting" || runtime.status === "running" || runtime.status === "stopping") {
            throw new ProjectError(409, "项目正在运行或正在切换状态");
        }
        const command = String(row.command || "").trim();
        if (!command) throw new ProjectError(400, "请先填写启动命令");
        const projectPath = resolveProjectDirectory(row.path);

        pushLog(runtime, "system", `$ ${command}\n`);
        runtime.status = "starting";
        runtime.pid = null;
        runtime.startedAt = null;
        runtime.stopRequested = false;
        clearStopTimer(runtime);

        let child: ChildProcess;
        try {
            child = spawn(toShellCommand(command), {
                cwd: projectPath,
                shell: true,
                windowsHide: true,
                detached: process.platform !== "win32",
                env: {
                    ...process.env,
                    FORCE_COLOR: "0",
                    NO_COLOR: "1",
                    // 让 Python 子进程也按 UTF-8 输出，避免中文按 GBK 写入管道
                    PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
                    PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
                },
            });
        } catch (error) {
            runtime.status = "error";
            pushLog(runtime, "system", `启动失败：${error instanceof Error ? error.message : String(error)}\n`);
            throw new ProjectError(500, "启动项目失败");
        }

        runtime.child = child;
        runtime.pid = child.pid ?? null;

        const decodeStdout = createOutputDecoder();
        const decodeStderr = createOutputDecoder();
        child.stdout?.on("data", (chunk: Buffer | string) => {
            pushLog(runtime, "stdout", decodeStdout(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
            pushLog(runtime, "stderr", decodeStderr(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
        });

        child.on("spawn", () => {
            if (runtime.child !== child) return;
            runtime.status = "running";
            runtime.pid = child.pid ?? runtime.pid;
            runtime.startedAt = Date.now();
            pushLog(runtime, "system", `进程已启动${runtime.pid ? ` (PID ${runtime.pid})` : ""}\n`);
        });

        child.on("error", (error) => {
            if (runtime.child !== child) return;
            runtime.status = "error";
            runtime.pid = null;
            runtime.startedAt = null;
            runtime.child = null;
            clearStopTimer(runtime);
            pushLog(runtime, "system", `启动失败：${error.message}\n`);
        });

        child.on("exit", (code, signal) => {
            if (runtime.child !== child) return;
            const stoppedByUser = runtime.stopRequested;
            runtime.child = null;
            runtime.pid = null;
            runtime.startedAt = null;
            runtime.stopRequested = false;
            clearStopTimer(runtime);
            runtime.status = stoppedByUser || code === 0 ? "stopped" : "error";
            const exitText = signal ? `信号 ${signal}` : `退出码 ${code ?? "unknown"}`;
            pushLog(runtime, "system", `进程已退出（${exitText}）\n`);
        });

        logInfo(`[projects] start ${row.id} (${row.name}): ${command}`);
        return runtime;
    };

    const forceKill = (child: ChildProcess, pid: number | null): void => {
        if (!pid) {
            try {
                child.kill("SIGKILL");
            } catch {
                /* ignore */
            }
            return;
        }
        try {
            if (process.platform === "win32") {
                execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
            } else {
                process.kill(-pid, "SIGKILL");
            }
        } catch {
            try {
                child.kill("SIGKILL");
            } catch {
                /* ignore */
            }
        }
    };

    const stopProject = (runtime: ProjectRuntime): void => {
        if (!runtime.child) {
            runtime.status = "stopped";
            runtime.pid = null;
            runtime.startedAt = null;
            return;
        }
        if (runtime.status === "stopping") return;

        const child = runtime.child;
        const pid = runtime.pid;
        runtime.status = "stopping";
        runtime.stopRequested = true;
        clearStopTimer(runtime);
        pushLog(runtime, "system", "正在停止项目…\n");

        try {
            if (process.platform === "win32" && pid) {
                const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                });
                killer.on("error", (error) => {
                    pushLog(runtime, "system", `停止进程失败：${error.message}\n`);
                });
            } else if (pid) {
                try {
                    process.kill(-pid, "SIGTERM");
                } catch {
                    child.kill("SIGTERM");
                }
            } else {
                child.kill("SIGTERM");
            }
        } catch (error) {
            pushLog(
                runtime,
                "system",
                `停止进程失败：${error instanceof Error ? error.message : String(error)}\n`
            );
        }

        runtime.stopTimer = setTimeout(() => {
            runtime.stopTimer = null;
            if (runtime.child === child && runtime.status === "stopping") {
                pushLog(runtime, "system", "进程未及时退出，执行强制结束…\n");
                forceKill(child, pid);
            }
        }, 5000);
        runtime.stopTimer.unref?.();
    };

    const waitForProjectStop = (runtime: ProjectRuntime, timeoutMs = 8000): Promise<void> =>
        new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const check = () => {
                if (!runtime.child && runtime.status !== "stopping") {
                    resolve();
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    reject(new ProjectError(500, "项目停止超时，无法重启"));
                    return;
                }
                setTimeout(check, 100);
            };
            check();
        });

    const restartProject = async (row: ProjectRow): Promise<ProjectRuntime> => {
        const runtime = getRuntime(row.id);
        if (!runtime.child || !runtime.pid) {
            return startProject(row);
        }
        if (runtime.status !== "running") {
            throw new ProjectError(409, "项目正在启动或停止，请稍后再试");
        }
        stopProject(runtime);
        await waitForProjectStop(runtime);
        return startProject(row);
    };

    const hasActiveCommandRuns = (projectId: number): boolean =>
        [...commandRuns.values()].some(
            (run) =>
                run.projectId === projectId &&
                (run.status === "running" || run.status === "stopping")
        );

    const pruneCommandRuns = (): void => {
        if (commandRuns.size <= 100) return;
        const completed = [...commandRuns.values()]
            .filter((run) => run.status !== "running" && run.status !== "stopping")
            .sort((a, b) => a.id - b.id);
        for (const run of completed) {
            if (commandRuns.size <= 80) break;
            commandRuns.delete(run.id);
        }
    };

    const startCommandRun = (
        project: ProjectRow,
        commandRow: ProjectCommandRow
    ): CommandRunRuntime => {
        if (hasActiveCommandRuns(project.id)) {
            throw new ProjectError(409, "已有运行命令正在执行，请先停止当前命令");
        }
        const command = String(commandRow.command || "").trim();
        if (!command) throw new ProjectError(400, "运行命令内容为空");
        const projectPath = resolveProjectDirectory(project.path);
        const run: CommandRunRuntime = {
            id: nextRunId++,
            projectId: project.id,
            commandId: commandRow.id,
            name: commandRow.name || command,
            command,
            status: "running",
            pid: null,
            child: null,
            logs: [],
            seq: 0,
            stopRequested: false,
            stopTimer: null,
            startedAt: formatDateTime(),
            finishedAt: null,
            exitCode: null,
        };
        commandRuns.set(run.id, run);
        pruneCommandRuns();
        pushLog(run, "system", `$ ${command}\n`);

        let child: ChildProcess;
        try {
            child = spawn(toShellCommand(command), {
                cwd: projectPath,
                shell: true,
                windowsHide: true,
                detached: process.platform !== "win32",
                env: {
                    ...process.env,
                    FORCE_COLOR: "0",
                    NO_COLOR: "1",
                    // 让 Python 子进程也按 UTF-8 输出，避免中文按 GBK 写入管道
                    PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
                    PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
                },
            });
        } catch (error) {
            run.status = "error";
            run.finishedAt = formatDateTime();
            pushLog(
                run,
                "system",
                `运行命令失败：${error instanceof Error ? error.message : String(error)}\n`
            );
            throw new ProjectError(500, "运行命令失败");
        }

        run.child = child;
        run.pid = child.pid ?? null;
        const decodeStdout = createOutputDecoder();
        const decodeStderr = createOutputDecoder();
        child.stdout?.on("data", (chunk: Buffer | string) => {
            pushLog(run, "stdout", decodeStdout(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
            pushLog(run, "stderr", decodeStderr(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
        });

        child.on("spawn", () => {
            if (run.child !== child) return;
            run.pid = child.pid ?? run.pid;
            pushLog(
                run,
                "system",
                `命令进程已启动${run.pid ? ` (PID ${run.pid})` : ""}\n`
            );
        });

        child.on("error", (error) => {
            if (run.child !== child) return;
            run.status = "error";
            run.pid = null;
            run.child = null;
            run.finishedAt = formatDateTime();
            clearStopTimer(run);
            pushLog(run, "system", `运行命令失败：${error.message}\n`);
        });

        child.on("exit", (code, signal) => {
            if (run.child !== child) return;
            const stoppedByUser = run.stopRequested;
            run.child = null;
            run.pid = null;
            run.stopRequested = false;
            run.exitCode = code;
            run.finishedAt = formatDateTime();
            clearStopTimer(run);
            run.status = stoppedByUser ? "stopped" : code === 0 ? "success" : "error";
            const exitText = signal ? `信号 ${signal}` : `退出码 ${code ?? "unknown"}`;
            pushLog(run, "system", `命令进程已退出（${exitText}）\n`);
        });

        logInfo(`[projects] run ${project.id} command ${commandRow.id}: ${command}`);
        return run;
    };

    const stopCommandRun = (run: CommandRunRuntime): void => {
        if (!run.child || run.status === "success" || run.status === "error" || run.status === "stopped") {
            return;
        }
        if (run.status === "stopping") return;

        const child = run.child;
        const pid = run.pid;
        run.status = "stopping";
        run.stopRequested = true;
        clearStopTimer(run);
        pushLog(run, "system", "正在停止运行命令…\n");

        try {
            if (process.platform === "win32" && pid) {
                const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                });
                killer.on("error", (error) => {
                    pushLog(run, "system", `停止命令失败：${error.message}\n`);
                });
            } else if (pid) {
                try {
                    process.kill(-pid, "SIGTERM");
                } catch {
                    child.kill("SIGTERM");
                }
            } else {
                child.kill("SIGTERM");
            }
        } catch (error) {
            pushLog(
                run,
                "system",
                `停止命令失败：${error instanceof Error ? error.message : String(error)}\n`
            );
        }

        run.stopTimer = setTimeout(() => {
            run.stopTimer = null;
            if (run.child === child && run.status === "stopping") {
                pushLog(run, "system", "命令未及时退出，执行强制结束…\n");
                forceKill(child, pid);
            }
        }, 5000);
        run.stopTimer.unref?.();
    };

    const cleanupRuntime = (): void => {
        for (const runtime of runtimes.values()) {
            if (!runtime.pid) continue;
            try {
                if (process.platform === "win32") {
                    execFileSync("taskkill", ["/pid", String(runtime.pid), "/T", "/F"], {
                        stdio: "ignore",
                    });
                } else {
                    process.kill(-runtime.pid, "SIGKILL");
                }
            } catch {
                /* best effort */
            }
        }
        for (const run of commandRuns.values()) {
            if (!run.pid) continue;
            try {
                if (process.platform === "win32") {
                    execFileSync("taskkill", ["/pid", String(run.pid), "/T", "/F"], {
                        stdio: "ignore",
                    });
                } else {
                    process.kill(-run.pid, "SIGKILL");
                }
            } catch {
                /* best effort */
            }
        }
    };
    process.once("exit", cleanupRuntime);

    const projectRouter = express.Router();
    projectRouter.use(authMiddleware);
    projectRouter.use(requireWrite);

    projectRouter.get("/editors", (_req, res) => {
        res.json({ res: true, editors: editorAvailability() });
    });

    projectRouter.get("/usage", async (_req, res) => {
        try {
            const active = [...runtimes.entries()]
                .filter(([, runtime]) => ACTIVE_PROJECT_STATUSES.includes(runtime.status) && runtime.pid)
                .sort((a, b) => a[0] - b[0]);
            const rows = listProjectsStmt.all() as ProjectRow[];
            const rowMap = new Map(rows.map((row) => [row.id, row]));
            const table = active.length > 0 ? await readProcessTable() : null;
            const now = Date.now();
            const cpuCount = Math.max(1, os.cpus().length);

            const usage = active.map(([projectId, runtime]) => {
                const row = rowMap.get(projectId);
                const pid = runtime.pid;
                const uptimeSeconds = runtime.startedAt
                    ? Math.max(0, Math.round((now - runtime.startedAt) / 1000))
                    : null;
                const base = {
                    projectId,
                    name: row?.name || "未命名项目",
                    status: runtime.status,
                    pid,
                    uptimeSeconds,
                };

                if (!table || !pid) {
                    return {
                        ...base,
                        cpuPercent: null,
                        memoryBytes: null,
                        memoryMb: null,
                        processCount: 0,
                    };
                }

                const tree = collectProcessUsage(table, pid);
                if (!tree) {
                    return {
                        ...base,
                        cpuPercent: null,
                        memoryBytes: null,
                        memoryMb: null,
                        processCount: 0,
                    };
                }

                const sampleKey = `${projectId}:${pid}`;
                const cpuPercent = sampleCpuPercent(sampleKey, table.at, tree.cpuMs, cpuCount);

                return {
                    ...base,
                    cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 100) / 100,
                    memoryBytes: tree.memoryBytes,
                    memoryMb: Math.round((tree.memoryBytes / (1024 * 1024)) * 10) / 10,
                    processCount: tree.processCount,
                };
            });

            // 进程停止/重启后旧样本不再有意义，及时释放
            const activeSampleKeys = new Set(
                active.map(([projectId, runtime]) => `${projectId}:${runtime.pid}`)
            );
            for (const key of processCpuSamples.keys()) {
                if (!activeSampleKeys.has(key)) processCpuSamples.delete(key);
            }

            res.json({
                res: true,
                available: active.length === 0 || Boolean(table),
                sampledAt: new Date(table?.at ?? now).toISOString(),
                cpuCount,
                usage,
            });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.get("/ports/:port", async (req, res) => {
        try {
            if (!isLoopbackRequest(req)) {
                throw new ProjectError(403, "只能在运行后端的本机查询端口占用");
            }
            const port = parsePortNumber(req.params.port);
            const connections = await listPortUsage(port);
            res.json({ res: true, port, connections });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/ports/:port/kill", async (req, res) => {
        try {
            if (!isLoopbackRequest(req)) {
                throw new ProjectError(403, "只能在运行后端的本机结束进程");
            }
            const port = parsePortNumber(req.params.port);
            const pid = Number(req.body?.pid);
            if (!Number.isInteger(pid) || pid <= 0) throw new ProjectError(400, "无效的进程 ID");
            if (pid <= 4 || pid === process.pid || pid === process.ppid) {
                throw new ProjectError(400, "该进程受保护，不能结束");
            }
            // 只允许结束确实占用该端口的进程，避免误杀
            const connections = await listPortUsage(port);
            const target = connections.find((entry) => entry.pid === pid);
            if (!target) throw new ProjectError(404, "该进程已不在占用此端口");
            if (PROTECTED_PROCESS_NAMES.has((target.processName || "").toLowerCase())) {
                throw new ProjectError(400, `「${target.processName}」是系统进程，已阻止结束`);
            }
            try {
                if (process.platform === "win32") {
                    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
                } else {
                    process.kill(pid, "SIGTERM");
                }
            } catch (error) {
                logError("[projects] kill port process failed", error);
                throw new ProjectError(500, "结束进程失败，可能需要管理员权限");
            }
            logInfo(`[projects] killed pid ${pid} (${target.processName || "unknown"}) on port ${port}`);
            res.json({
                res: true,
                message: `已结束 ${target.processName || "进程"} (PID ${pid})`,
            });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/detect", (req, res) => {
        try {
            const detection = detectProject(req.body?.path, req.body?.type);
            res.json({ res: true, detection });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.get("/", (_req, res) => {
        const rows = listProjectsStmt.all() as ProjectRow[];
        const commandMap = getCommandsMap();
        const linkMap = getLinksMap();
        res.json({
            res: true,
            projects: rows.map((row) => toDto(row, commandMap.get(row.id) || [], linkMap.get(row.id) || [])),
            folders: (listProjectFoldersStmt.all() as ProjectFolderRow[]).map(toFolderDto),
        });
    });

    projectRouter.post("/pick-folder", async (req, res) => {
        if (!isLoopbackRequest(req)) {
            res.status(403).json({ res: false, message: "只能在运行后端的本机选择文件夹" });
            return;
        }
        if (folderPickerBusy) {
            res.status(409).json({ res: false, message: "文件夹选择窗口已经打开" });
            return;
        }
        folderPickerBusy = true;
        try {
            const initialPath = String(req.body?.initialPath ?? "").trim();
            const selected = await pickNativeFolder(initialPath);
            res.json({
                res: true,
                path: selected ? resolveFolderPath(selected) : "",
            });
        } catch (error) {
            fail(res, error);
        } finally {
            folderPickerBusy = false;
        }
    });

    projectRouter.get("/folders", (_req, res) => {
        res.json({
            res: true,
            folders: (listProjectFoldersStmt.all() as ProjectFolderRow[]).map(toFolderDto),
        });
    });

    projectRouter.post("/folders", (req, res) => {
        try {
            const name = parseFolderName(req.body?.name);
            if (getProjectFolderStmt.get(name)) {
                throw new ProjectError(409, "已存在同名文件夹");
            }
            const folderPath = resolveFolderPath(req.body?.path);
            const now = formatDateTime();
            insertNewProjectFolderStmt.run(name, folderPath, nextFolderSortOrder(), now, now);
            const folder = getProjectFolderStmt.get(name) as ProjectFolderRow;
            logInfo(`[projects] created folder ${name}`);
            res.status(201).json({ res: true, folder: toFolderDto(folder) });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.patch("/folders", (req, res) => {
        try {
            const oldName = parseFolderName(req.body?.name);
            const folder = getProjectFolderStmt.get(oldName) as ProjectFolderRow | undefined;
            if (!folder) throw new ProjectError(404, "文件夹不存在");
            const name = req.body?.newName !== undefined
                ? parseFolderName(req.body.newName)
                : oldName;
            const folderPath = req.body?.path !== undefined
                ? resolveFolderPath(req.body.path)
                : folder.path;
            renameProjectFolder(oldName, name, folderPath);
            const updated = getProjectFolderStmt.get(name) as ProjectFolderRow;
            logInfo(`[projects] updated folder ${oldName} -> ${name}`);
            res.json({ res: true, folder: toFolderDto(updated) });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/folders/reorder", (req, res) => {
        try {
            if (!Array.isArray(req.body?.names)) {
                throw new ProjectError(400, "文件夹顺序格式不正确");
            }
            const names = req.body.names.map((name: unknown) => parseFolderName(name));
            if (new Set(names).size !== names.length) {
                throw new ProjectError(400, "文件夹顺序中存在重复项");
            }
            reorderProjectFolders(names);
            res.json({
                res: true,
                folders: (listProjectFoldersStmt.all() as ProjectFolderRow[]).map(toFolderDto),
            });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/folders/open-editor", (req, res) => {
        try {
            if (!isLoopbackRequest(req)) {
                throw new ProjectError(403, "只能在运行后端的本机打开文件夹");
            }
            const name = parseFolderName(req.body?.name);
            const folder = getProjectFolderStmt.get(name) as ProjectFolderRow | undefined;
            if (!folder) throw new ProjectError(404, "文件夹不存在");
            if (!folder.path) throw new ProjectError(400, "请先设置文件夹路径");
            const editor = String(req.body?.editor || "") as EditorId;
            if (!["vscode", "qoder", "explorer"].includes(editor)) {
                throw new ProjectError(400, "不支持的编辑器");
            }
            const message = openProjectInEditor(folder.path, editor);
            logInfo(`[projects] open folder ${name} with ${editor}`);
            res.json({ res: true, message });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.patch("/:id/folder", (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const folder = parseProjectFolder(req.body?.folder);
            moveProjectToFolder(id, folder);
            const updated = findProject(id);
            if (!updated) throw new ProjectError(500, "项目更新失败");
            logInfo(`[projects] move ${id} to folder ${folder || "ungrouped"}`);
            res.json({ res: true, project: toDto(updated) });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/", (req, res) => {
        try {
            const request = req as AuthedRequest;
            const detection = detectProject(req.body?.path, req.body?.type);
            const name = String(req.body?.name ?? "").trim() || detection.name;
            const startCommand =
                String(req.body?.startCommand ?? req.body?.command ?? "").trim() ||
                detection.startCommand ||
                detection.command;
            const commands =
                req.body?.commands === undefined
                    ? detection.commands
                    : parseRunCommands(req.body.commands);
            const intro = parseProjectIntro(req.body?.intro);
            const links = parseProjectLinks(req.body?.links);
            const folder = parseProjectFolder(req.body?.folder);
            if (!name) throw new ProjectError(400, "请输入项目名称");
            if (name.length > 120) throw new ProjectError(400, "项目名称不能超过 120 个字符");
            if (!startCommand) throw new ProjectError(400, "请填写启动命令");
            if (startCommand.length > 2000) throw new ProjectError(400, "启动命令过长");

            const projectId = createProjectWithCommands(
                name,
                detection.path,
                detection.type,
                startCommand,
                folder,
                intro,
                request.user?.userId ?? null,
                commands,
                links
            );
            const row = findProject(projectId);
            if (!row) throw new ProjectError(500, "项目保存失败");
            logInfo(`[projects] created ${row.id} (${row.name}) by ${request.user?.username || "unknown"}`);
            res.status(201).json({ res: true, project: toDto(row) });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.patch("/:id", (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const runtime = runtimes.get(id);
            const running = Boolean(
                runtime && ACTIVE_PROJECT_STATUSES.includes(runtime.status)
            );
            // 只有启动配置受运行状态限制；名称、分组、介绍、地址等可以随时改
            const touchesLaunchConfig =
                req.body?.path !== undefined ||
                req.body?.type !== undefined ||
                req.body?.startCommand !== undefined ||
                req.body?.command !== undefined ||
                req.body?.commands !== undefined;
            if (running && touchesLaunchConfig) {
                throw new ProjectError(409, "项目运行中，请先停止再修改启动配置");
            }
            if (touchesLaunchConfig && hasActiveCommandRuns(id)) {
                throw new ProjectError(409, "请先停止正在运行的命令再修改启动配置");
            }

            const rawPath = req.body?.path !== undefined ? req.body.path : row.path;
            const requestedType = req.body?.type !== undefined ? req.body.type : row.type;
            const detection = detectProject(rawPath, requestedType);
            const name = req.body?.name !== undefined
                ? String(req.body.name).trim()
                : row.name;
            const startCommandProvided =
                req.body?.startCommand !== undefined || req.body?.command !== undefined;
            const providedStartCommand = String(
                req.body?.startCommand ?? req.body?.command ?? ""
            ).trim();
            const startCommand = startCommandProvided
                ? (providedStartCommand || detection.startCommand || row.command)
                : (detection.path !== row.path || detection.type !== row.type
                    ? detection.startCommand
                    : row.command);
            const commands = req.body?.commands === undefined
                ? null
                : parseRunCommands(req.body.commands);
            const intro = req.body?.intro === undefined
                ? null
                : parseProjectIntro(req.body.intro);
            const links = req.body?.links === undefined
                ? null
                : parseProjectLinks(req.body.links);
            const folder = req.body?.folder === undefined
                ? (row.folder || "")
                : parseProjectFolder(req.body.folder);
            if (!name) throw new ProjectError(400, "请输入项目名称");
            if (name.length > 120) throw new ProjectError(400, "项目名称不能超过 120 个字符");
            if (!startCommand) throw new ProjectError(400, "请填写启动命令");
            if (startCommand.length > 2000) throw new ProjectError(400, "启动命令过长");

            updateProjectWithCommands(
                id,
                name,
                detection.path,
                detection.type,
                startCommand,
                folder,
                intro,
                commands,
                links
            );
            const updated = findProject(id);
            if (!updated) throw new ProjectError(500, "项目更新失败");
            logInfo(`[projects] updated ${id} (${updated.name})`);
            res.json({ res: true, project: toDto(updated) });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.delete("/:id", (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const runtime = runtimes.get(id);
            if (runtime && ["starting", "running", "stopping"].includes(runtime.status)) {
                throw new ProjectError(409, "请先停止项目再删除");
            }
            if (hasActiveCommandRuns(id)) {
                throw new ProjectError(409, "请先停止正在运行的命令再删除");
            }
            deleteProjectStmt.run(id);
            runtimes.delete(id);
            for (const [runId, run] of commandRuns.entries()) {
                if (run.projectId === id) commandRuns.delete(runId);
            }
            logInfo(`[projects] deleted ${id} (${row.name})`);
            res.json({ res: true, message: "项目已删除" });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/:id/start", (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const runtime = startProject(row);
            res.json({ res: true, project: toDto(row), status: runtime.status, pid: runtime.pid });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/:id/stop", (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const runtime = getRuntime(id);
            stopProject(runtime);
            logInfo(`[projects] stop ${id} (${row.name})`);
            res.json({ res: true, status: runtime.status, pid: runtime.pid });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/:id/restart", async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const runtime = await restartProject(row);
            logInfo(`[projects] restart ${id} (${row.name})`);
            res.json({ res: true, project: toDto(row), status: runtime.status, pid: runtime.pid });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.get("/:id/logs", (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const runtime = runtimes.get(id);
            const afterRaw = Number(req.query.after);
            const after = Number.isFinite(afterRaw) && afterRaw > 0 ? Math.floor(afterRaw) : 0;
            const logs = runtime
                ? runtime.logs.filter((entry) => entry.seq > after)
                : [];
            res.json({
                res: true,
                logs,
                nextSeq: runtime?.seq ?? 0,
                status: runtime?.status ?? "stopped",
                pid: runtime?.pid ?? null,
            });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/:id/commands/:commandId/run", (req, res) => {
        try {
            const id = Number(req.params.id);
            const commandId = Number(req.params.commandId);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            if (!Number.isInteger(commandId) || commandId <= 0) {
                throw new ProjectError(400, "无效的运行命令 ID");
            }
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const commandRow = findProjectCommand(id, commandId);
            if (!commandRow) throw new ProjectError(404, "运行命令不存在");
            const run = startCommandRun(row, commandRow);
            res.status(201).json({ res: true, run: toRunDto(run) });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.get("/:id/runs/:runId/logs", (req, res) => {
        try {
            const id = Number(req.params.id);
            const runId = Number(req.params.runId);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            if (!Number.isInteger(runId) || runId <= 0) throw new ProjectError(400, "无效的运行 ID");
            if (!findProject(id)) throw new ProjectError(404, "项目不存在");
            const run = commandRuns.get(runId);
            if (!run || run.projectId !== id) throw new ProjectError(404, "运行记录不存在");
            const afterRaw = Number(req.query.after);
            const after = Number.isFinite(afterRaw) && afterRaw > 0 ? Math.floor(afterRaw) : 0;
            res.json({
                res: true,
                logs: run.logs.filter((entry) => entry.seq > after),
                nextSeq: run.seq,
                status: run.status,
                pid: run.pid,
                run: toRunDto(run),
            });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/:id/runs/:runId/stop", (req, res) => {
        try {
            const id = Number(req.params.id);
            const runId = Number(req.params.runId);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            if (!Number.isInteger(runId) || runId <= 0) throw new ProjectError(400, "无效的运行 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const run = commandRuns.get(runId);
            if (!run || run.projectId !== id) throw new ProjectError(404, "运行记录不存在");
            stopCommandRun(run);
            logInfo(`[projects] stop command run ${runId} for ${id}`);
            res.json({ res: true, run: toRunDto(run) });
        } catch (error) {
            fail(res, error);
        }
    });

    projectRouter.post("/:id/open-editor", (req, res) => {
        try {
            if (!isLoopbackRequest(req)) {
                throw new ProjectError(403, "只能在运行后端的本机打开编辑器");
            }
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) throw new ProjectError(400, "无效的项目 ID");
            const row = findProject(id);
            if (!row) throw new ProjectError(404, "项目不存在");
            const editor = String(req.body?.editor || "") as EditorId;
            if (!["vscode", "qoder", "explorer"].includes(editor)) {
                throw new ProjectError(400, "不支持的编辑器");
            }
            const message = openProjectInEditor(row.path, editor);
            logInfo(`[projects] open ${row.id} with ${editor}`);
            res.json({ res: true, message });
        } catch (error) {
            fail(res, error);
        }
    });

    app.use(`${apiPrefix}/projects`, projectRouter);
    logInfo(`[projects] routes registered at ${apiPrefix}/projects`);
};
