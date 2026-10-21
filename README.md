# GeoLink S2 Agent

面向中文地理文本的单用户空间推理平台。输入任意中文描述，系统将给出三态结论：

- `RESOLVED`：存在可核验的高置信候选，输出 WGS84 坐标、地图位置与 S2 单元。
- `COARSE`：实体或空间关系仍有不确定性，输出候选支持的 S2 空间范围。
- `ABSTAIN`：证据不足，明确拒答并提示应补充的线索。

本项目是从论文研究目标延展出的可演示 MVP：重点展示**受约束的 Agent 工作流**、工具编排、可审计证据链与空间化输出，而非让大模型直接“猜坐标”。

## 已实现

- LangGraph 状态图：结构化解析 → 受约束 LLM 语义补充 → 高德/演示候选召回 → 证据排序 → 三态决策 → 自适应 S2 表达。
- 高德 POI 2.0 服务端适配器；高德 GCJ-02 坐标会转换为 WGS84，地图与 S2 统一使用 WGS84。
- 支持“参照地标附近的目标 POI”两阶段检索：先定位锚点，再通过高德周边搜索召回目标，避免同名校园/地标跨城市误匹配。
- 本地演示索引：未配置高德、服务不可用或无候选时安全回退，界面会明确标示“演示索引”。
- 可选 OpenAI-compatible LLM：仅补充地点线索、区域和关系三元组；坐标、候选与最终决策仍由确定性节点控制。
- MapLibre 地图、可选天地图底图、真实 S2 单元多边形、候选证据和 Agent 轨迹。
- 供外部 Agent 调用的只读 MCP JSON-RPC 入口：完整编排工具 `geo.resolve_text`，以及可组合的实体链接、锚点解析、文本/周边检索和 WGS84 距离工具。

## 技术栈

`TypeScript` · `Vinext/React` · `LangGraph JS` · `MapLibre GL` · `nodes2ts/S2` · 高德 Web 服务 API · OpenAI-compatible LLM

## 快速开始（Windows PowerShell）

先安装 Node.js 22.13 或更新版本。项目依赖已经锁定在 `package-lock.json` 中。

```powershell
Set-Location 'D:\交互地图\geo-agent-platform'
Copy-Item .env.example .env.local
npm run dev
```

然后访问 `http://localhost:5173`。修改 `.env.local` 后请重启开发服务。

`npm run dev` 会在启动前自动将 `drizzle/` 中尚未应用的案例库迁移同步到项目本地 D1；因此评测仪表盘的运行记录和反馈会保留在 `.wrangler/state` 中，关闭或重启开发服务后仍可读取。

可用的输入示例：

```text
北京市海淀区北京大学东门
望京SOHO东侧约300米
火星基地附近
```

## 配置外部服务

所有密钥仅放在 `.env.local`，不要提交到 Git，也不要粘贴到聊天记录。

### 高德 POI（推荐）

在高德开放平台创建**Web 服务**类型 Key，并配置：

```ini
AMAP_WEB_SERVICE_KEY=你的高德Web服务Key
```

这是服务端环境变量，浏览器不会收到它。平台请求高德 POI 2.0 文本搜索接口；当有城市线索时会使用城市范围限制，避免将召回结果误认为全国范围的确定答案。

### 天地图底图

在天地图控制台创建浏览器端 Key，并配置：

```ini
NEXT_PUBLIC_TIANDITU_KEY=你的天地图浏览器端Key
```

`NEXT_PUBLIC_` 前缀表示该 Key 会出现在浏览器中；请在天地图控制台设置域名/来源白名单。未配置时，应用仍能显示 MapLibre 本地上下文和 S2 网格，只是不加载天地图瓦片。

### 可选 LLM

默认是纯规则模式：

```ini
AGENT_LLM_PROVIDER=rule
```

若有本地或云端的 OpenAI-compatible `/v1/chat/completions` 服务，可启用结构化语义补充。低配置电脑可先尝试较小的本地模型；模型无法调用时，Agent 会记录 `fallback` 并继续使用规则，而不是中断或编造结果。

```ini
# 本地 OpenAI-compatible 服务示例
AGENT_LLM_PROVIDER=local
AGENT_LLM_BASE_URL=http://127.0.0.1:11434/v1
AGENT_LLM_MODEL=你的模型名
AGENT_LLM_TIMEOUT_MS=25000

# 云端 OpenAI-compatible 服务示例
# AGENT_LLM_PROVIDER=cloud
# AGENT_LLM_BASE_URL=https://你的服务地址/v1
# AGENT_LLM_API_KEY=你的服务端密钥
# AGENT_LLM_MODEL=你的模型名
# AGENT_LLM_TIMEOUT_MS=25000
```

DeepSeek 可使用 OpenAI 兼容接口，空间语义规划建议使用非思考模型：

```ini
AGENT_LLM_PROVIDER=cloud
AGENT_LLM_BASE_URL=https://api.deepseek.com
AGENT_LLM_MODEL=deepseek-chat
AGENT_LLM_TIMEOUT_MS=25000
```

代码会对 DeepSeek 自动关闭思考模式，避免 JSON 规划结果被推理输出耗尽；若服务偶发返回空内容，会进行一次有界格式重试，失败后安全回退到规则规划。不要把 `AGENT_LLM_API_KEY` 提交到代码仓库或发送到聊天中。

LLM 的输出受到 JSON 格式和字段白名单约束，且仅能影响线索抽取；它不能写入坐标、跳过候选检索，或单独决定 `RESOLVED`。

### 地理知识图谱 + RAG

平台内置一个可审计的本地图谱 RAG 层，位于语义规划之后、实体链接之前：

```text
原始文本 → 图谱检索（实体 / 别名 / 行政区 / 关系）
        → 查询扩展与实体消歧
        → 高德 POI 验证 → 证据排序与空间决策
```

图谱可以把“安理”扩展为“安徽理工大学”、把“西安交大”扩展为“西安交通大学”，并提供城市、区县和门店限定词线索。图谱命中不包含坐标，也不直接产生最终结果；每条线索仍须由 POI 名称、类别、地址和空间关系证据验证。运行后可在 **Agent 轨迹** 的“地理知识图谱 RAG”节点和结果面板中查看命中项。

种子图谱位于 `lib/agent/knowledge-graph.ts`，可按同一数据结构添加经过核验的实体、别名与关系；新增数据后运行 `npm run test` 即可回归验证。MCP 客户端也可单独调用只读工具 `geo.retrieve_knowledge` 获取无坐标的图谱检索结果。

## 验证与构建

```powershell
npm run build
```

接口可用 `POST /api/resolve` 调用：

```json
{ "text": "北京市海淀区北京大学东门" }
```

返回值包含 `decision`、`confidence`、`selectedCandidate`、`spatial.geojson`、`steps` 和 `provenance`。`spatial.geojson` 可以直接对接后续的前端、GIS 服务或评测流水线。

### MCP 调用

MCP 客户端将服务地址设置为 `http://localhost:5173/api/mcp`，先调用 `initialize`，再调用 `tools/list` 查看工具。完整空间 Agent 示例：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "geo.resolve_text", "arguments": { "text": "中国地质大学（北京）附近的麦当劳" } }
}
```

需要把 Agent 拆成多个可观测工具时，可调用 `geo.resolve_anchor`、`geo.search_text`、`geo.search_around` 和 `geo.distance`。工具参数使用 Zod 校验，MCP 描述不包含任何密钥；高德密钥只在服务端运行时读取。

## 当前边界

- `confidence` 是 MVP 的可解释启发式分数，不是已完成 F8 校准后的统计概率。
- `confidence-geometry-heuristic-v0.2` 是候选中心与邻居单元的覆盖策略；`COARSE` 场景的方向扇区、概率面覆盖和最优 CellUnion 仍是下一阶段工作。
- 当前单用户；案例反馈写入 D1 `agent_cases`，没有 D1 绑定时降级到服务端内存。论文数据仅作为只读参考，平台不会修改 `D:\论文3`。
- 高德 POI 的使用范围、配额和数据展示要求以高德平台规则为准。

详细设计见 [架构与路线图](docs/ARCHITECTURE.md) 与 [简历表述建议](docs/RESUME.md)。
