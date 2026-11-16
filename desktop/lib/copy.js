/* ============================================================
   桌宠文案
   - 与网页版保持一致：小气泡随机文案、提醒文案、隐藏/回来文案
   - 只做纯函数，不依赖窗口，方便主进程统一调度
   ============================================================ */

function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)] || "";
}

function formatTrigger(triggerAt, today) {
    const text = String(triggerAt || "");
    if (!text) return "";
    const dateKey = text.slice(0, 10);
    const time = text.slice(11, 16);
    if (today && dateKey === today) return `今天 ${time}`;
    return `${dateKey.slice(5)} ${time}`;
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

function buildNotice(kind) {
    const goodbye = kind === "goodbye";
    const lines = goodbye ? MINI_GOODBYE_LINES : MINI_WELCOME_LINES;
    return {
        kicker: goodbye ? "桌宠喵" : "桌宠回来啦",
        text: pickRandom(lines),
        sub: goodbye ? "点托盘图标可以叫我回来喵" : "今天也要顺顺利利喵"
    };
}

function currentStats(summary) {
    const stats = (summary && summary.stats) || {};
    const pending = Math.max(0, Number(stats.pending) || 0);
    const overdue = Math.max(0, Number(stats.overdue) || 0);
    const completed = Math.max(0, Number(stats.completed) || 0);
    const total = Math.max(0, Number(stats.total) || pending + completed);
    return { pending, overdue, completed, total };
}

/**
 * 左键小气泡内容。返回结构化数据，由气泡窗口负责排版：
 * { kicker, text } 为未登录/加载态；正常态返回 main/title/sub/chips。
 */
function buildMini({ loggedIn, summary }) {
    if (!loggedIn) {
        return { kicker: "桌宠喵", text: "老大还没登录喵" };
    }
    if (!summary) {
        return { kicker: "桌宠喵", text: "让喵看看待办喵…" };
    }

    const { pending, overdue, completed, total } = currentStats(summary);
    const kicker = pickRandom(["待办喵", "喵喵日报", "今日待办喵"]);
    const bigValue = pending > 0 ? pending : total;
    const bigUnit = pending > 0 ? "条没做完" : total > 0 ? "条全清喵" : "条待办喵";
    const main = { value: bigValue, unit: bigUnit };

    let title = "";
    let sub = "";
    const chips = [];
    const nextWhen = summary.nextReminder
        ? formatTrigger(summary.nextReminder.triggerAt, summary.today)
        : "";
    const completedChip = pickRandom([`完成 ${completed}/${total} 喵`, `已完成 ${completed}/${total} 喵`]);
    const overdueChip = pickRandom([`逾期 ${overdue} 条喵`, `${overdue} 条逾期了喵`]);

    if (total === 0) {
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
        title = pickRandom([
            `今天还有 ${pending} 条没做完喵，全都逾期了喵…`,
            `完了完了喵，${overdue} 条全逾期了喵…`,
            `今天 ${pending} 条待办全超时了喵，老大快看喵！`
        ]);
        sub = pickRandom(["老大快救火喵！", "先挑一条最急的搞定喵！", "喵陪你一起救火喵～"]);
        chips.push({ text: overdueChip, cls: "is-danger" });
    } else if (pending === 1) {
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
        chips.push({ text: pickRandom([`共 ${total} 条喵`, `今天共 ${total} 条喵`]), cls: "" });
    } else if (completed >= pending) {
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

    return {
        kicker,
        main,
        title,
        // 副文案只在空待办 / 全部完成时显示，避免待办状态的椭圆被撑高
        sub: sub && (total === 0 || pending === 0) ? sub : "",
        chips: chips.slice(0, 2)
    };
}

function makeServerNotice(event, today) {
    return {
        kicker: "待办提醒喵",
        title: String((event && event.title) || "有一条待办在等你喵"),
        message: "说好的提醒时间到啦喵 · " + formatTrigger(event && event.triggerAt, today),
        snoozeMinutes: 10
    };
}

function makeDueNotice(item) {
    const minutes = Math.max(1, Number(item && item.minutesLeft) || 0);
    return {
        kicker: "快到期了喵",
        title: `「${(item && item.title) || "待办"}」还有 ${minutes} 分钟就到截止时间喵！`,
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
        title: pickRandom(lines),
        message: overdue > 0 ? `其中 ${overdue} 件已经逾期了喵…` : "记得一件一件来喵～"
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
        message:
            overdue > 0
                ? `其中 ${overdue} 件已经逾期了，老大要不要先处理一下喵？`
                : "要不要先收个尾再走喵？"
    };
}

module.exports = {
    pickRandom,
    formatTrigger,
    currentStats,
    buildNotice,
    buildMini,
    makeServerNotice,
    makeDueNotice,
    makeIntervalNotice,
    makeWorkStartNotice,
    makeWorkEndNotice
};
