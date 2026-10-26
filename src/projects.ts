import { execFileSync, spawn, type ChildProcess } from "child_process";
import fs from "fs";
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

type ProjectCommandDto = {
    id: number;
    name: string;
    command: string;
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
    runCommands: ProjectCommandDto[];
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
    `);

    const runtimes = new Map<number, ProjectRuntime>();
    const commandRuns = new Map<number, CommandRunRuntime>();
    let nextRunId = 1;

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
    const insertProjectStmt = db.prepare(
        `INSERT INTO projects (name, path, type, command, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const updateProjectStmt = db.prepare(
        `UPDATE projects SET name = ?, path = ?, type = ?, command = ?, updated_at = ? WHERE id = ?`
    );
    const deleteProjectStmt = db.prepare("DELETE FROM projects WHERE id = ?");
    const deleteProjectCommandsStmt = db.prepare("DELETE FROM project_commands WHERE project_id = ?");
    const insertProjectCommandStmt = db.prepare(
        `INSERT INTO project_commands (project_id, name, command, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    );

    const getRuntime = (id: number): ProjectRuntime => {
        let runtime = runtimes.get(id);
        if (!runtime) {
            runtime = {
                status: "stopped",
                pid: null,
                child: null,
                logs: [],
                seq: 0,
                stopRequested: false,
                stopTimer: null,
            };
            runtimes.set(id, runtime);
        }
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

    const getProjectCommands = (projectId: number): ProjectCommandDto[] =>
        (listProjectCommandsStmt.all(projectId) as ProjectCommandRow[]).map((row) => ({
            id: row.id,
            name: row.name,
            command: row.command,
        }));

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

    const createProjectWithCommands = db.transaction(
        (
            name: string,
            projectPath: string,
            type: ProjectType,
            startCommand: string,
            createdBy: number | null,
            commands: DetectedCommand[]
        ): number => {
            const now = formatDateTime();
            const info = insertProjectStmt.run(
                name,
                projectPath,
                type,
                startCommand,
                createdBy,
                now,
                now
            );
            const projectId = Number(info.lastInsertRowid);
            saveProjectCommands(projectId, commands);
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
            commands: DetectedCommand[] | null
        ): void => {
            updateProjectStmt.run(name, projectPath, type, startCommand, formatDateTime(), id);
            if (commands !== null) saveProjectCommands(id, commands);
        }
    );

    const toDto = (row: ProjectRow, commands?: ProjectCommandDto[]): ProjectDto => {
        const runtime = runtimes.get(row.id);
        return {
            id: row.id,
            name: row.name,
            path: row.path,
            type: row.type,
            typeLabel: PROJECT_TYPE_LABELS[row.type] || row.type,
            command: row.command,
            startCommand: row.command,
            runCommands: commands ?? getProjectCommands(row.id),
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
        runtime.stopRequested = false;
        clearStopTimer(runtime);

        let child: ChildProcess;
        try {
            child = spawn(command, {
                cwd: projectPath,
                shell: true,
                windowsHide: true,
                detached: process.platform !== "win32",
                env: {
                    ...process.env,
                    FORCE_COLOR: "0",
                    NO_COLOR: "1",
                },
            });
        } catch (error) {
            runtime.status = "error";
            pushLog(runtime, "system", `启动失败：${error instanceof Error ? error.message : String(error)}\n`);
            throw new ProjectError(500, "启动项目失败");
        }

        runtime.child = child;
        runtime.pid = child.pid ?? null;

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => pushLog(runtime, "stdout", String(chunk)));
        child.stderr?.on("data", (chunk) => pushLog(runtime, "stderr", String(chunk)));

        child.on("spawn", () => {
            if (runtime.child !== child) return;
            runtime.status = "running";
            runtime.pid = child.pid ?? runtime.pid;
            pushLog(runtime, "system", `进程已启动${runtime.pid ? ` (PID ${runtime.pid})` : ""}\n`);
        });

        child.on("error", (error) => {
            if (runtime.child !== child) return;
            runtime.status = "error";
            runtime.pid = null;
            runtime.child = null;
            clearStopTimer(runtime);
            pushLog(runtime, "system", `启动失败：${error.message}\n`);
        });

        child.on("exit", (code, signal) => {
            if (runtime.child !== child) return;
            const stoppedByUser = runtime.stopRequested;
            runtime.child = null;
            runtime.pid = null;
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
            child = spawn(command, {
                cwd: projectPath,
                shell: true,
                windowsHide: true,
                detached: process.platform !== "win32",
                env: {
                    ...process.env,
                    FORCE_COLOR: "0",
                    NO_COLOR: "1",
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
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => pushLog(run, "stdout", String(chunk)));
        child.stderr?.on("data", (chunk) => pushLog(run, "stderr", String(chunk)));

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
        res.json({
            res: true,
            projects: rows.map((row) => toDto(row, commandMap.get(row.id) || [])),
        });
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
            if (!name) throw new ProjectError(400, "请输入项目名称");
            if (name.length > 120) throw new ProjectError(400, "项目名称不能超过 120 个字符");
            if (!startCommand) throw new ProjectError(400, "请填写启动命令");
            if (startCommand.length > 2000) throw new ProjectError(400, "启动命令过长");

            const projectId = createProjectWithCommands(
                name,
                detection.path,
                detection.type,
                startCommand,
                request.user?.userId ?? null,
                commands
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
            if (runtime && ["starting", "running", "stopping"].includes(runtime.status)) {
                throw new ProjectError(409, "请先停止项目再修改");
            }
            if (hasActiveCommandRuns(id)) {
                throw new ProjectError(409, "请先停止正在运行的命令再修改");
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
                commands
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
