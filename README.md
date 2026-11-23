<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/apexcluster-logo-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/apexcluster-logo.svg" />
  <img src="docs/images/apexcluster-logo.svg" alt="ApexCluster Logo" width="96" />
</picture>

# ApexCluster

### 面向复杂软件工程与产品设计的旗舰级跨厂商多 Agent 集群
**The Apex Multi-Vendor Product & Engineering Cluster — PRD-Ready Architecture Layer, Cross-Reviewed Implementation, Sandbox-Verified Delivery.**

<p>
  <a href="https://johnson-durui.github.io/ApexCluster/"><strong>▶ 在线演示</strong></a> ·
  <a href="README.md"><strong>中文</strong></a> ·
  <a href="README.en.md">English</a> ·
  <a href="ARCHITECTURE.md">架构设计</a> ·
  <a href="docs/CONFIGURATION.md">配置指南</a> ·
  <a href="docs/EXTENDING.md">扩展开发</a> ·
  <a href="SECURITY.md">安全模型</a>
</p>

<p>
  <a href="https://johnson-durui.github.io/ApexCluster/"><img src="https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-4F46E5?logo=githubpages&logoColor=white" alt="Live Online Demo" /></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933?logo=node.js&logoColor=white" alt="Node.js >= 22.12" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Providers-5%20Frontier%20Labs-8A2BE2" alt="5 Frontier Providers" />
  <img src="https://img.shields.io/badge/Sandbox-Immutable%20Docker-2496ED?logo=docker&logoColor=white" alt="Immutable Docker Sandbox" />
  <img src="https://img.shields.io/badge/Downgrade-Zero%20Silent%20Fallback-D93F0B" alt="Zero Silent Fallback" />
  <img src="https://img.shields.io/badge/License-MIT-0E8A16" alt="MIT License" />
</p>

</div>

---

**ApexCluster**（Multi-Agent Workbench）不是又一个让单个大模型自言自语、靠口头输出 `"LGTM / All tests passed"` 糊弄过关的玩具脚本，而是一套**本机运行、程序掌权、跨厂商三权分立的重型多 Agent 产品与软件工程集群**。

它原生编排 **Anthropic · OpenAI · Google · xAI · DeepSeek** 五大前沿厂商模型，内置 **5 个加权旗舰席位（权重 `4 → 3 → 2`）** 与 **4 个高并发 Worker 算力池（每池最高 `64` 并发）**，配合全新 **指挥台（Command Deck）实时观测前端**，将流水线清晰解耦为**架构层**与**实现层**：

- **架构层直出 PRD 与原型（完美适配产品经理任务）**：输入一段原始想法，多厂商席位并行完成需求澄清、方案发散、跨厂可行性互审与交互式 Demo 原型搭建，在 **关卡 A** 输出完整的 **`PRD.md`、技术架构文档、开发指南与可量化验收契约 `CONTRACT.json`**——产品经理既可直接签收 PRD 与原型交付研发，也可一键继续进入实现层。
- **实现层跨厂制衡与沙箱实证交付**：确认关卡 A 后，异厂席位互签计划、隔离并行编码、跨模型家族复跑冻结检查、独立验收，最终生成可追溯的加密 `TRACE` 与可交付软件产物。

> **核心铁律**：**模型文本无权推进流水线。** 只有程序状态机、`CONTRACT.json` 结构化契约、SHA-256 产物哈希、隔离容器命令回执、跨窗口已读确认与最终 `TRACE`，才能决定交付。

### ⭐ Star 涨势

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/star-surge-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/images/star-surge.svg" />
    <img src="docs/images/star-surge.svg" alt="ApexCluster Star 涨势：首颗 star 之后不到 4 天从 0 涨到 149" width="800" />
  </picture>
</p>

<p align="center"><sub>首颗 star 之后不到 4 天 0 → 149，单小时峰值 +28 · <a href="https://star-history.com/#Johnson-Durui/ApexCluster&Date">查看实时曲线 →</a></sub></p>

---

## 在线演示

[![在线演示：一个需求从架构到交付的完整流水线](docs/images/walkthrough.gif)](https://johnson-durui.github.io/ApexCluster/)

**[▶ 立即打开在线演示 →](https://johnson-durui.github.io/ApexCluster/)** &nbsp;|&nbsp; **[打开演示交付的 RoomDesk 应用 →](https://johnson-durui.github.io/ApexCluster/demo-project/)**

在线演示运行的是本仓库真实的 **Command Deck 指挥台前端**，所有数据来自预设脚本：**无需后端、不需要 API Key、不调用任何模型**。点击底部状态栏里的 **「▶ 播放完整演示」**，即可观看一个团队会议室预约工具（**RoomDesk**）从需求到交付的完整流程：

1. **架构集群产出 PRD 与原型**：多个席位并行完成需求澄清、方案发散与跨厂互评，产出 PRD、架构文档与可运行 Demo，右侧实时任务地图以光纤动画实时呈现每次分派与回传；
2. **关卡 A 人工决策**：系统自动停下并列出本关交付物与契约，等你确认（20 秒无操作自动继续）；
3. **跨厂商实现与独立验收**：异厂席位互签计划、并行实现、交叉评审并由独立席位验收；
4. **关卡 B 交付签收**：PRD、架构文档、源码、测试报告与完整项目包均可安全预览或下载。

演示交付的 [RoomDesk 示例应用](https://johnson-durui.github.io/ApexCluster/demo-project/) 可直接在线试用（支持楼层筛选、冲突检测与 iCal 导出，附 30 个自动化测试）。任务历史、新建评审、环境与连接等页面也全部开放浏览。

在本机启动同一份在线演示：

```sh
npm ci --prefix web
npm --prefix web run dev:demo
```

然后打开 <http://localhost:5180>。演示源码位于 [`web/demo/`](web/demo/)，静态构建命令为 `npm --prefix web run build:demo`（输出至 `web/dist-demo/`）。

---

## 界面实景截图

以下截图均取自本仓库真实前端界面（在线演示预设数据）：

| | |
|---|---|
| ![实时任务地图](docs/images/live-implementation.png)<br>**实时任务地图**：主控拆解任务，席位之间的分派与回传以光纤动画实时呈现 | ![关卡 A](docs/images/gate-a.png)<br>**人工关卡**：需要你决定的地方自动停下，列出本关交付物与契约 |
| ![交付物](docs/images/delivered.png)<br>**交付物面板**：每份产物标明产出席位，支持安全预览或下载 | ![架构视图](docs/images/architecture-view.png)<br>**全屏架构视图**：查看协作拓扑、推理强度与上下文用量 |
| ![决策管道](docs/images/decision-pipeline.png)<br>**决策管道**：架构 → 关卡 A → 实现 → 独立验收 → 关卡 B → 完成 | ![任务历史](docs/images/history.png)<br>**任务历史**：评审运行状态、等待人工项与运行度量 |
| ![评审决策](docs/images/run-decision.png)<br>**评审运行**：多候选方案对比与结构化决策 | ![环境与连接](docs/images/environment.png)<br>**环境与连接**：席位型号、密钥状态、执行沙箱与扩展服务 |

![演示交付的 RoomDesk 应用](docs/images/roomdesk-app.png)

<sub>演示流水线最终交付的 RoomDesk 会议室预约应用：按楼层筛选、实时冲突检测与 iCal 日历导出，附带 30 个自动化测试。</sub>

---

## 为什么做 ApexCluster？

大多数多 Agent 框架在面对真实复杂工程时都会迅速失控：上下文一长就遗忘原始需求、同家族模型互相吹捧放水、模型静默降级却不告知、宿主机直接跑命令泄露密钥。ApexCluster 针对每一个工程死穴建立了**代码级硬约束**：

| 维度 | 常见玩具多 Agent 框架 | ApexCluster |
| :--- | :--- | :--- |
| **评审独立性** | 同一个模型 / 同厂商自写自审，互相打高分 | **强制跨厂商制衡**：实现作者与评审者必须来自不同厂商家族（如 `Sol` [OpenAI] ⇄ `Opus` [Anthropic]），并由 `Astra` 在冻结副本上独立验收 |
| **完成判定** | 靠 LLM 在对话里声称“已完成 / 测试通过” | **实证驱动状态机**：所有阶段流转绑定 `CONTRACT.json`、源码/产物 SHA-256 哈希、结构化 `argv` 命令回执与最终 `TRACE` |
| **模型与镜像诚信** | 静默替换廉价模型、偷降推理强度、拉取 `:latest` | **零静默降级**：精确模型 ID + 零推理开销的账户列表证明（`models:verify`）+ 不可变 `sha256:` Docker 镜像摘要 |
| **超长上下文治理** | 塞满后用 LLM 摘要覆盖上下文，丢失需求与报错 | **无损窗口轮换**：基于真实物理上限与实际用量提前切窗，由程序机械组装保留原始引用的交接包，绝不覆盖用户原文与未送达回执 |
| **并发与权限控制** | 扁平循环、角色越权、任意 agent 改主目录 | **加权委派层级 (`4 → 3 → 2 → 1`)**：只能向严格更低权重派单；仅 `Sol` 拥有主工作区写权与集成权；4 大 Worker 池每池最高 64 并发 |
| **执行与密钥安全** | 宿主机直接拼 shell 字符串执行，环境变量裸奔 | **强边界沙箱**：默认无网络非 root Docker 容器（支持 WSL `bwrap` / Windows MXC）；API Key 仅驻留宿主机环境变量，零透传至前端/日志/容器 |

---

## 双层架构与全链路流水线

> **完美适配产品经理任务（架构层独立可用）**：架构层本身就是一个高规格的**多模型协同 PRD 与原型工作台**。你只需提供原始业务想法或零散需求，集群会自动完成需求澄清、多方向方案对比、跨厂商盲区挑战与交互式 `demo/` 原型验证，在 **关卡 A** 输出结构化的 **`PRD.md` + `ARCHITECTURE.md` + `DEV_GUIDE.md` + `CONTRACT.json`**。对于纯产品规划、需求评审、竞品/方案比选和原型演示等产品经理核心任务，停在关卡 A 即可直接带走全套高质量交付物；需要落地研发时，确认关卡 A 即可无缝进入实现层。

```mermaid
flowchart TD
    subgraph Arch["架构层 · 产品与技术蓝图（直出 PRD 与交互原型，产品经理独立可用）"]
        direction LR
        A1("1. 需求输入与澄清<br/>Fable (W4)"):::archNode
        A2("2. 多维方案发散<br/>Carbon (W2)"):::archNode
        A3("3. 跨厂架构互审<br/>Astra ⇄ Opus (W3)"):::archNode
        A4("4. 原型与 PRD 契约<br/>Sol demo/ · CONTRACT"):::archNode
        GA{{"◆ 关卡 A 冻结<br/>PM 可直接签收"}}:::gateA
        A1 --> A2 & A3 --> A4 --> GA
    end

    subgraph Impl["实现层 · 跨厂商三权分立工程交付（隔离沙箱实证与独立验收）"]
        direction LR
        I1("5. 里程碑互签<br/>Sol ⇄ Opus DAG"):::implNode
        I2("6. 隔离并行实现<br/>Sol 主区 + Opus 候选"):::implNode
        I3("4×64 并发算力池<br/>xAI · Google · DeepSeek"):::implNode
        I4("7-9. 互审 · 集成 · 验收<br/>Docker · Sol · Astra"):::implNode
        GB{{"◆ 关卡 B 交付<br/>TRACE 溯源签收"}}:::gateB
        I1 --> I2 & I3 --> I4 --> GB
    end

    Arch ==>|"confirm 确认进入实现层"| Impl

    classDef archNode fill:#ffffff,stroke:#6366f1,stroke-width:1.4px,color:#1e293b
    classDef implNode fill:#ffffff,stroke:#10b981,stroke-width:1.4px,color:#1e293b
    classDef gateA fill:#eef2ff,stroke:#4f46e5,stroke-width:2px,color:#1e1b4b
    classDef gateB fill:#ecfdf5,stroke:#059669,stroke-width:2px,color:#064e3b
    style Arch fill:#f5f7ff,stroke:#818cf8,stroke-width:1.5px,color:#1e293b
    style Impl fill:#f2fbf7,stroke:#34d399,stroke-width:1.5px,color:#1e293b
```

---

## 默认旗舰集群编组（Flagship Roster）

所有席位权限绑定在**席位与阶段**，而非模型名称；开启 `delegationWeight` 后，任何 Agent 只能向**权重严格更低**的目标派单，彻底杜绝权限倒挂。

### 5 大旗舰决策与工程席位

| 席位 | 权重 | 默认旗舰模型 | 厂商家族 | 推理强度 | 核心职责与硬权限边界 |
| :--- | :---: | :--- | :--- | :---: | :--- |
| **`claude` (Lead)** | `4` | `claude-fable-5-2` | Anthropic | `max` | 唯一用户入口、需求澄清、维护唯一共同方案与最终交付；可向全体席位委派，无主区直写权 |
| **`astra` (Secondary)** | `3` | `gpt-6.2-astra` | OpenAI | `max` | 架构可行性审查、风险修正、**跨家族独立验收**（拥有独立验收与沙箱执行权） |
| **`opus` (CrossRef)** | `3` | `claude-opus-5-5` | Anthropic | `max` / `xhigh` | 架构并行互参、实现计划互签、**隔离候选副本实现**与跨厂商代码评审 |
| **`carbon` (Ideator)** | `2` | `gemini-4-carbon` | Google | `high` | 提供多样化架构方案、适用条件与潜在盲区，专注发散、不作裁决 |
| **`sol` (Builder)** | `2` | `gpt-6.2-sol` | OpenAI | `max` | **主工作区唯一写者与集成者**、构建可运行 Demo、真实命令执行与过审候选集成 |

### 4 大高并发 Worker 算力池（Weight `1`）

| 算力池 | 默认模型 | 厂商家族 | 并发上限 | 适用阶段 | 专长任务 |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **`grok`** | `grok-4.7` | xAI | `64` | 架构层 + 实现层 | 高速、工程化的有界子任务与隔离副本编辑 |
| **`hydrogen`** | `gemini-4-hydrogen` | Google | `64` | 架构层 + 实现层 | 大规模并行 worker、超长上下文分析与校验型子任务 |
| **`deepseek`** | `deepseek-v4-pro` | DeepSeek | `64` | 实现层 | 实现层深度代码分析与高性价比有界工程子任务 |
| **`mini`** | 随父席位自适应 (`claude-haiku-5-5` / `gpt-6-luna` / `gemini-4-hydrogen`) | 自适应 | `64` | 架构层 | 随父席位厂商自动匹配的低成本快速子任务 |

> **灵活预设**：如果你暂时只有 OpenAI 密钥，可直接选用内置的 `single-provider` 预设跑通完整架构层至关卡 A；进行完整实现与独立验收时切换至 `flagship` 或自定义跨厂商名册即可。详见 [配置指南](docs/CONFIGURATION.md#rosters-and-presets)。

---

## 六大核心工程保障

- **零静默降级与可证明模型注册表**：`config/models.registry.json` 严格声明每个模型的精确 ID、协议、物理上下文窗口、支持的推理强度与计费单价。运行 `npm run models:verify` 通过各厂商 listing 接口生成本地证明（**零推理调用、零费用**）；缺失密钥、SDK 版本漂移或推理强度不匹配会直接拦截，绝不偷偷换模型或降级。
- **跨厂商独立性与防“自审”契约**：实现阶段强制要求主实现席与评审席属于不同模型家族；`Astra` 与 `Opus` 在架构集群阶段必须实际读取对方分页意见并回执确认；最终 `TRACE` 在源码采纳后生成，防止文档写入污染已评审源码哈希。
- **无损上下文窗口轮换与事件溯源恢复**：每次调用均为干净模型窗口，运行时追踪真实 Token 消耗并在逼近硬阈值（`softTokens` / `hardTokens` / `hardRatio`）时自动开窗，基于持久化事件流机械组装交接包，完整保留原始需求、契约引用与未送达回执；异常中断仅恢复安全窗口，不盲目重放失败任务。
- **强隔离沙箱与不可变镜像钉死**：所有模型生成的命令均为结构化参数数组（杜绝宿主机 Shell 注入），默认运行在绑定 `sha256:` 本地不可变摘要的非 root Docker 容器中；普通命令彻底断网，依赖安装走独立受控 `installNetwork` 通道与命名缓存卷；同时支持经能力证明的 WSL `bwrap` 与 Windows MXC 执行后端。
- **先预留、后核算的预算硬护栏**：每次发起模型请求前按最保守价格档位预留额度，响应返回后以实际标准化用量结算，配合 `budget.maxUsd` 与 `budget.maxTokens` 防止复杂集群失控烧费。
- **双模交付（API 自动化流水线 + 本机指挥台 Web UI & CLI 评审）**：既支持无头 JSONL CLI 流水线集成，也提供仅监听 `127.0.0.1` 的 React 19 本机指挥台工作台，并原生兼容本机已登录的 **Claude Code** 与 **Codex CLI** 账户额度运行代码/方案评审。

---

## 快速开始

### 1. 零成本体验完整离线 Docker 流水线（推荐第一步）

环境要求：**Node.js >= 22.12**、**Git** 与运行中的 **Docker**。以下命令使用脚本化 Provider（**真实模型调用数为 0，零 API 费用**），但会**真实构建并启动隔离 Docker 容器**、执行实现与验收命令并在结束后自动清理独占资源：

```sh
git clone https://github.com/Johnson-Durui/ApexCluster.git
cd ApexCluster
npm ci
docker build -t dmw-sandbox:local docker/sandbox
npm run demo:offline
```

运行成功时，终端最后一行输出 `PASS`。

---

### 2. 运行真实 API 工程流水线

#### 第一步：配置密钥与隔离镜像

1. 复制环境变量模板：将 `.env.example` 复制为 `.env`，填入所需厂商密钥（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`XAI_API_KEY`、`DEEPSEEK_API_KEY`）。
2. 复制运行时配置：将 `config/chat.config.example.json` 复制为 `config/chat.config.json`，按 [Docker 配置指南](docs/CONFIGURATION.md#docker-execution) 填入本地镜像不可变 `sha256:` ID，并在 `budget.maxUsd` 中设置本次预算上限。

#### 第二步：核对可用模型并启动流水线

**方式 A：单厂商快速体验架构阶段（仅需 OpenAI Key）**

```sh
npm run models:verify -- --provider openai
mkdir product
npm run pipeline -- --preset single-provider --requirement tests/fixtures/pipeline/todo-cli/requirement.md --workspace ./product
```

> `single-provider` 预设支持跑完架构集群并停在**关卡 A** 审阅产物（PRD、架构、开发指南、Demo 与契约）。

**方式 B：全旗舰跨厂商端到端交付（架构 + 隔离实现 + 交叉评审 + 独立验收 + TRACE）**

在 `.env` 中配齐旗舰名册所需的五个厂商密钥，完成零费用型号核对后切换至 `--preset flagship`：

```sh
npm run models:verify
npm run pipeline -- --preset flagship --requirement tests/fixtures/pipeline/todo-cli/requirement.md --workspace ./product
```

<details>
<summary><strong>查看 CLI 参数与退出码说明</strong></summary>

**常用参数**

| 参数 | 说明 |
| :--- | :--- |
| `--requirement <file>` | UTF-8 需求文件路径（必填） |
| `--workspace <directory>` | 已存在的目标产品目录（必填；程序经本地目录选择授权后才可读写） |
| `--preset <name>` | 名册预设，默认为 `flagship`（可选 `single-provider` 或自定义名册） |
| `--auto` | 自动通过澄清与关卡 A/B；不传时在交互终端接受 `confirm`、`revise` 或 `cancel` |

**输出与退出码**

命令输出逐行 JSON（NDJSON），适合脚本与 CI 集成：
- `0`：流水线顺利完成
- `2`：参数或路径无效
- `3`：用户取消，或非交互终端遇到需要人工决策的关卡
- `4`：运行失败或检测到停滞
- `5`：启动配置、模型证明或执行后端不可用

</details>

---

### 3. 启动本机指挥台 Web 工作台

```sh
npm ci --prefix web
npm run build:web
npm start
```

服务仅绑定回环地址 `127.0.0.1`（默认端口 `5170`，可在 `config/workbench.config.json` 中通过 `port` 修改）。工作台实时展示各席位绑定模型、环境变量与证明状态、真实上下文窗口占用、窗口轮换记录、扇出并发进度与实证状态，且后端绝不向前端暴露任何真实密钥值。

> **注意**：通过 `npm start` 启动时，浏览器端无法直接授权新的产品目录；要针对本地目录执行完整工程流水线，请使用上方 `npm run pipeline` 命令。

### 4. 使用本机已登录的 CLI 账户运行评审（Claude Code / Codex CLI）

如果你已在本机安装并登录了 **Claude Code** 与 **Codex CLI**，可直接复用本地 CLI 额度发起跨模型评审：

```sh
npm run probe
```

1. 确认命令发现与登录状态正常（如需指定二进制路径或精确型号，可复制 `config/workbench.config.example.json` 为 `config/workbench.config.json` 后编辑）。
2. 启动 Web 服务后访问 [新建评审](http://127.0.0.1:5170/#/new) 即可发起评审。

> `npm run pipeline` 始终使用 API 模式；若希望「新聊天」也启用本机 CLI 驱动，需按 [本地 CLI 模式文档](docs/CONFIGURATION.md#local-cli-mode) 准备隔离与协议能力证明。

---

## 仓库结构与质量验证

```text
├── src/
│   ├── providers/   # Anthropic Messages / OpenAI Responses / Google GenAI 统一适配与 ScriptedProvider
│   ├── chat/        # 持久化对话运行时、加权调度器、窗口轮换、权限与工作区授权、工具边界
│   ├── pipeline/    # 架构集群、关卡 A/B、契约校验、里程碑 DAG、跨厂商互审、集成、独立验收与 TRACE
│   ├── exec/        # Docker 不可变沙箱、WSL bwrap、Windows MXC 与命令回执封装
│   └── server/      # 仅监听 127.0.0.1 的本地 API 与实时事件流
├── web/
│   ├── src/         # React 19 + TypeScript + Vite 指挥台（Command Deck）工作台前端
│   └── demo/        # 零后端静态在线演示与自动化浏览器验收脚本
├── config/          # 精确模型注册表、旗舰/单厂商名册预设与运行时配置模板
├── docker/sandbox/  # 离线隔离执行容器构建定义
├── tests/           # 200+ 自动化测试套件（后端 + 前端，零真实 API 调用的确定性协议夹具）
└── docs/            # 配置、扩展、安全文档与界面演示素材
```

运行全量本地质量与发布前安全扫描：

```sh
npm run check            # TypeScript 类型检查 + 完整后端测试套件
npm ci --prefix web
npm --prefix web test    # 前端测试
npm run build:web        # 前端生产构建
npm run prepublish:scan  # 敏感信息 / 个人路径 / 密钥泄露扫描
```

---

## 深入文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 双层流水线机制、上下文轮换与信任边界详解
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — 模型注册表、加权名册、预算护栏、Docker 镜像钉死与本地 CLI 模式
- [docs/EXTENDING.md](docs/EXTENDING.md) — 接入新模型、新 Provider、新席位、自定义工具与执行后端
- [SECURITY.md](SECURITY.md) — 安全模型、操作者职责、Live Smoke 防护与依赖审计说明
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录
- [README.en.md](README.en.md) — English Documentation

## 许可证

基于 [MIT](LICENSE) 协议开源。
