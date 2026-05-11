# pet-cursor

> AI 在网页世界里的身体。不是 browser automation tool，是给 AI 用的游戏引擎。

```bash
npm i -g pet-cursor
```

**Zero runtime dependencies.** Node 22+. `dependencies: {}` — literally empty. Native `WebSocket`, no `ws`, no Playwright, no Puppeteer, no MCP, no browser download.

## Why

CDP 是基建——谁都能做。pet-cursor 的三个差异化是：

1. **可见光标 / 角色** — trust through visibility. 人类肉眼能看见 AI 在干什么。
2. **审计日志** — 每个动作 PUT 到 elastik + 本地 `.pet-cursor.log`. Tee 给 reviewer agent 实时审查。
3. **游戏化** — 物理引擎 + 局部感知 + WASD 操控（roadmap v0.5-v0.6）。

ghost-cursor 优化"骗网站像人"；pet-cursor 优化"让人看清 AI 干了啥"。目标不同，节奏不同。

## 快速上手

```bash
# 1. 起浏览器 + 连接（自动检测 Brave / Chrome / Edge）
pet start brave --url https://example.com

# 2. 看页面有啥
pet snapshot
#   [1] link  More information...
#   [2] link  https://www.iana.org/domains/example

# 3. 玩
pet click 1                 # 光标 bezier 滑过去 → 元素绿框 → 缩 0.85x → 真 click → 弹回 → 等页面
pet hover 2
pet eval "document.title"
pet screenshot

# 4. 断
pet close
```

## CLI（24 个 verb）

### 会话

| verb | 用途 |
|---|---|
| `pet start [brave\|chrome\|edge] [--url U] [--port P]` | 启动浏览器 + 连接 |
| `pet connect <port> [url-substring]` | 连现有 9222 + 写 `~/.pet-cursor` |
| `pet close` | 清会话文件 |

### 感知

| verb | 用途 |
|---|---|
| `pet snapshot` | 全页可交互元素编号清单 |
| `pet nearby [--radius N] [--limit N]` | 光标附近的元素（省 token） |
| `pet text <n\|sel>` | textContent |
| `pet html [sel]` | outerHTML |
| `pet screenshot [path]` | PNG 截图 |
| `pet position` / `pet box <sel>` | 坐标 |

### 动作（默认有可见动画）

| verb | 节奏（normal） |
|---|---|
| `pet click <n\|sel> [--right\|--middle]` | bezier → 高亮 → 缩 → 砸 → 弹 |
| `pet dblclick / rightclick / hover` | 同上 |
| `pet type <n\|sel> <text\|@file\|->` | click + Input.insertText |
| `pet keypress <key>` | Enter / Tab / ArrowDown |
| `pet drag <from> <to>` | press → 沿 bezier 走 → release |
| `pet scroll <up\|down\|left\|right> [px]` | wheel events |

### 直通（无动画）

| verb | 用途 |
|---|---|
| `pet goto <url>` | Page.navigate（等 load） |
| `pet eval <expr\|@file.js\|->` | sudo 逃生舱 |
| `pet wait <n\|sel>` | poll until present |
| `pet wait-idle [stableMs]` | 等网络静默 |
| `pet log [--since 5s] [--type T] [--status '>=N']` | console + fetch + XHR + error 日志 |
| `pet dismiss-cookies [--reject\|--list]` | 11 CMP + 文本兜底 |

### 批量与模式

| verb | 用途 |
|---|---|
| `pet batch [@file\|-]` | 多 verb 一条 WS 连发 |
| `pet auto` | 信息：auto 就是默认 |
| `pet play` | v0.6 WASD 模式（roadmap） |

### 规则

- 数字开头 → snapshot/nearby 编号；其它 → CSS selector
- `@file` → 从文件读 JS/文本；`-` → stdin
- `--speed fast | normal | slow` 或 `PET_SPEED=` → 全局节奏
- `--renderer cursor | none` → 切换；v0.1 只支持这俩
- `--silent` = `--renderer none`

## 节奏（pet-cursor 的灵魂）

故意慢。每个 click 默认 7 阶段、~1.4s：

```
move (400ms) → highlight (400ms) → press-shrink (80ms)
            ↓
     dispatch + press pause (150ms)
            ↓
release → press-restore (80ms+100ms) → unhighlight → observe (300ms)
```

| preset | total | who |
|---|---|---|
| `fast` | ~280ms | AI 批量 |
| `normal` | ~1.4s | 给人看（**默认**） |
| `slow` | ~3.5s | 演示/录屏 |

## 审计（pet-cursor 的另一个灵魂）

每个 state-changing verb 自动双写：

**本地** `~/.pet-cursor.log`（mode 0600，always on）：
```
2026-05-11T09:15:32.198Z click [1] button "Click me" at (89,125)
2026-05-11T09:15:33.206Z hover [4] clickable "Hover target A" at (114,239)
```

**远端 elastik**（`PET_ELASTIK=http://host:port` 时）：
```bash
PUT /home/log/pet/2026-05-11T09:15:32.198Z
Body: click [1] button "Click me" at (89,125)
```

reviewer agent SSE 流：
```bash
curl http://localhost:3105/listen/home/log/pet/*
```

| env | 用途 |
|---|---|
| `PET_ELASTIK` | elastik base URL |
| `PET_ELASTIK_TOKEN` / `ELASTIK_WRITE_TOKEN` | write 权限 |
| `PET_NO_AUDIT=1` | 完全关闭审计 |

## 状态文件

`~/.pet-cursor`（KEY=VALUE，shell-sourceable，no JSON envelope）：

```
HOST=127.0.0.1
PORT=9222
WS_URL=ws://127.0.0.1:9222/devtools/page/4E3E8BBD04CC94B74E7CB327212DC10E
PAGE_URL=https://example.com
TITLE=Example Domain
```

## 渲染器接口（v0.1 一个 impl，v0.3+ 扩展）

```ts
interface Renderer {
  install(): Promise<void>;
  position(): Pt;
  moveTo(target: Pt, opts?: ...): Promise<void>;
  highlight(target: string | number, color?: string): Promise<void>;
  unhighlight(): Promise<void>;
  pressScale(scale: number, durMs: number): Promise<void>;
  flash(): Promise<void>;
}
```

v0.1 提供 `CursorRenderer`（黑底白边 SVG 箭头 + bezier + outline 高亮 + 按下缩放）。`--renderer pet/highlight/...` 当前会报"v0.3+ 未实现"。

## 偷的清单

| 来源 | 偷什么 | 阶段 |
|---|---|---|
| [sids/cdp-browser](https://github.com/sids/cdp-browser) | native WebSocket CDP + dismiss-cookies 思路 | v0.2 |
| ghost-cursor | bezier 路径 | v0.1 |
| Shimeji | 物理引擎 + DOM 平台碰撞 + 走路 sprite | v0.5 |
| elastik V6 | 6 verb HTTP 字节引擎，做审计后端 | v0.1 |

## Roadmap

```
v0.1  ✓ CursorRenderer + 22 verbs + audit + snapshot
v0.2  ✓ dismiss-cookies + log + wait-idle + start
v0.3    PetRenderer (sprite sheet: 走路/砸/写/被砸)
v0.4    nearby 已落; 多 Renderer 真正切换 (cursor|pet|highlight|none)
v0.5    PlatformRenderer (Shimeji 物理: 重力 + DOM 平台碰撞)
v0.6    pet play WASD 游戏模式
v0.7    speculative prefetch (idle 巡逻)
v1.0    Ranger OC sprite + 自定义工具动画
```

## 哲学

```
curl 是 HTTP 的遥控器 (1996)
pet  是浏览器的身体 (2026)

关卡是网页
NPC 是 DOM 元素
AI 是灵魂
角色是身体
CDP 是神经系统
物理引擎是世界规则
人类是偶尔接管的上帝之手
```

## License

MIT
