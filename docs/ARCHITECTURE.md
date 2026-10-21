# 架构与开发路线图

## 设计目标

将非结构化中文地理描述转为可审计的空间决策。系统不把“调用大模型”当作 Agent 的全部：每个节点有明确输入/输出、工具边界、失败回退和可追溯记录。

```text
输入文本
  → 规则结构化（提及、区域、关系）
  → 受约束 LLM 语义工具（可选）
  → 地理知识图谱 RAG（别名、实体类型、行政区、关系线索）
  → 高德 POI / 演示索引
  → 名称、地址、来源、关系证据排序
  → RESOLVED / COARSE / ABSTAIN 决策策略
  → WGS84 坐标与自适应 S2 网格
  → MapLibre 可视化、JSON 结果与 Agent 轨迹
```

## 关键实现约束

1. **坐标不可由 LLM 生成。** LLM 只提供经白名单校验的提及、区域和空间关系；候选坐标来自检索工具。
2. **CRS 一致。** 高德返回的 GCJ-02 在服务端近似转换为 WGS84；地图和 S2 以 WGS84 输出。
3. **三态优先于强行命中。** `RESOLVED` 需要直接名称证据、足够分数和候选间隔；否则降为 `COARSE` 或 `ABSTAIN`。
4. **降级可见。** 未配置高德、无高德候选或 LLM 故障都会出现在运行轨迹和 provenance 中。
5. **研究数据只读。** 平台只把 `D:\论文3` 作为设计与评测参考，生产数据通过独立目录/数据库管理。
6. **参照关系优先。** “A 附近的 B”先用 A 的名称与城市/括号限定定位锚点，再以锚点为圆心调用周边 POI 搜索 B；锚点无法确认时拒绝把全国同名结果当作答案。
7. **图谱只做先验，不做裁判。** 本地图谱 RAG 只返回无坐标的实体、别名、行政区与关系线索，不能绕过 POI 检索、硬约束与最终决策节点。

## 模块映射

| 模块 | 当前实现 | 后续演进 |
| --- | --- | --- |
| 编排 | LangGraph 条件状态图 | 持久化、人工复核中断、重试策略 |
| 工具路由 | `lib/agent/tool-registry.ts` 统一注册只读工具 | MCP 客户端、更多 POI/地理数据提供方 |
| 检索 | 高德 POI + 演示索引 + 本地图谱 RAG | 多源 POI、版本化地名词典、向量/全文混合检索 |
| 知识图谱 | `lib/agent/knowledge-graph.ts` 的可审计实体/别名/关系种子，`geo.retrieve_knowledge` 只读召回 | D1/PostGIS 图谱版本、人工审核、关系置信度与增量索引 |
| 语义 | 规则 + 可选结构化 LLM | 关系抽取模型、提示词评测、模型路由 |
| 决策 | 可解释启发式三态策略 | F8 置信度校准、conformal prediction、阈值评测 |
| 空间化 | 自适应 S2 v0.2 | F9 方向扇区、概率面、CellUnion 优化 |
| 数据 | D1 `agent_cases` 案例库 + 无绑定时的服务端内存降级 | PostGIS、对象存储、任务与标注数据版本 |
| 可观测性 | UI trace + provenance + `/evaluation` 仪表盘 | OpenTelemetry、LangSmith/自建 trace、离线评测 |

## 分期规划

### Phase 1：可靠 MVP（当前）

完成直接文本输入、候选检索、三态结果、S2 网格、地图和配置化 LLM。验收重点是：输入无关文本时必须拒答；外部服务失败时能降级且明确说明。

### Phase 2：评测与不确定性

- 建立只读标注集适配器、案例集和回归测试。
- 把启发式分数替换为经验证集校准的置信度；记录 coverage、选择性风险和拒答质量。
- 以目标点/范围、方向关系和误差半径构建概率覆盖，优化 S2 CellUnion。
- 每次 `/api/resolve` 保存结构化意图、工具计划、候选证据、轨迹和反馈；`/evaluation` 提供决策分布、反馈覆盖率、案例筛选和详情回放。

### 案例库接口

- `GET /api/cases`：按决策、反馈和输入文本筛选案例，并返回聚合指标。
- `GET /api/cases?id=...`：读取单次运行的完整证据快照。
- `POST /api/cases`：写入 `positive/negative` 反馈或人工期望决策。
- 正式运行使用 D1 `DB` 绑定；本地 `npm run dev` / `npm run start` 会先应用 `drizzle/` 中未完成的迁移，并将开发记录持久化到 `.wrangler/state`。仅在 D1 绑定或存储故障时才使用服务端内存降级，页面会明确显示该状态。

### MCP 工具接口

- `GET /api/mcp`：查看 MCP 服务信息和无凭据工具清单。
- `POST /api/mcp`：接受 MCP JSON-RPC `initialize`、`tools/list`、`tools/call`、`ping`，通知 `notifications/initialized` 不返回响应体。
- 完整编排工具：`geo.resolve_text`。
- 可组合只读工具：`geo.retrieve_knowledge`、`geo.entity_link`、`geo.resolve_anchor`、`geo.search_text`、`geo.search_around`、`geo.distance`。
- 工具参数经过 Zod 校验；工具描述不暴露密钥。高德只在服务端从运行时环境读取密钥，返回中保留检索参数、原始排序、距离和 GCJ-02 → WGS84 provenance。
- LangGraph 的 `resolve_anchor`、`around_search`、`direct_search` 节点与 MCP 共用同一注册表，因此外部调用与内部 Agent 运行不会出现两套行为。

### Phase 3：可复用平台

- FastAPI/Node 服务层 + PostGIS，存储任务、候选、证据、版本和人工反馈。
- 引入异步任务队列与工作流追踪；加入“人工复核—反馈—再运行”。
- 多数据源许可治理、数据版本、审计和访问控制。

### Phase 4：面向展示与求职

- 提供案例回放、失败案例分析、系统指标面板和架构图。
- 把工作流、工具边界、可观测性和评测结果作为项目亮点，而不是只展示聊天界面。
