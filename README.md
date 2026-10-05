# 盾构隧道掘进施工管理平台

面向盾构机台账、掘进环次、管片拼装、同步注浆、渣土外运、地表沉降监测与轴线纠偏的一体化盾构隧道施工管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 盾构机台账 | `shield` | 盾构机 | 盾构机编号、盾构机型号、开挖直径 |
| 掘进环次 | `ring` | 掘进环 | 环号、起始里程、掘进速度 |
| 管片拼装 | `segment` | 管片环 | 管片环号、管片型号、拼装点位 |
| 同步注浆 | `grouting` | 注浆记录 | 注浆编号、对应环号、浆液配比 |
| 渣土外运 | `muck` | 渣土运输单 | 运输单号、对应环号、渣土方量 |
| 地表沉降 | `settlement` | 沉降测点 | 测点编号、测点位置、初始高程 |
| 轴线偏差 | `axis` | 轴线测量 | 测量编号、对应环号、设计轴线 |
| 刀具磨损 | `cutter` | 刀具 | 刀具编号、刀盘位置、刀具类型 |
| 管片生产 | `segmentprod` | 管片 | 管片编号、管片型号、生产模具 |
| 浆液拌制 | `mortar` | 浆液批次 | 批次编号、浆液类型、水泥用量 |
| 洞内通风 | `ventilation` | 通风机组 | 机组编号、风筒长度、送风量 |
| 建筑监测 | `building` | 监测对象 | 对象编号、建筑物名称、结构类型 |
| 管线探查 | `utility` | 地下管线 | 管线编号、管线类型、埋设深度 |
| 进度节点 | `progress` | 进度节点 | 节点编号、节点名称、计划完成日 |
| 试验检测 | `testing` | 试验委托 | 委托编号、试样类型、检测项目 |
| 应急演练 | `drill` | 应急演练 | 演练编号、演练科目、演练日期 |
| 班组进场 | `crew` | 施工班组 | 班组编号、班组名称、主要工种 |
| 安全巡检 | `safety` | 巡检记录 | 巡检编号、巡检区域、巡检项目 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `shield-tunnel-construction:entries` 这一项，或调用 `resetModule(模块)`。

## 管片出厂台账（segmentprod）

管片台账是给建设单位的交付件，走一套独立但同源的口径，核心代码：

- `src/data/segment-ledger.ts`：唯一取数/分卷/统计口径。页面表格、出厂打包、进度节点交付清单
  全部经 `querySegmentRows()` / `monthShippedCount()` 取数，两处「本月出厂数」不会出现两套。
- `src/api/segment-service.ts`：权限、登记幂等、导入覆盖、分卷导出与断点续传。
- `src/data/export-store.ts`：导出任务与分块暂存（IndexedDB）；`src/data/zip.ts` 是零依赖 ZIP(STORED) 打包。

打包与导入规则：

- 按「管片型号 + 生产模具」分卷，每卷 CSV 固定含 **管片编号、钢筋笼批号、养护天数、出厂强度**；
  包内另附 `00_包清单.csv`（每卷行数/字节/CRC、总行数、整包校验和、本月出厂数）、
  `00_缺栏清单.csv`（缺哪一栏点到具体管片编号）、`00_本月出厂交付清单.csv`（与进度节点同源）。
- 页面按当前筛选看到的行数 = 包清单总行数 = 各卷行数之和。
- 分卷先逐块写入 IndexedDB 并对 CRC/行数校验，全部通过才原子合成一个 ZIP；中途断了可在
  「导出任务」面板从断掉的分块续传，校验不过绝不产生半包文件。
- 导入补数按 **管片编号覆盖**（不追加，空单元格不抹原值）；文件内重复编号只入一条（后行覆盖）；
  台账中不存在的编号与格式非法行进失败清单并写清原因；浏览器存储写不下时整批撤销。
- 存量管片在本地数据 schema v2 迁移时按「生产日期」重排一遍（见 `local-store.ts`）。

权限（纯前端内置账号，可在右上角切换以验证）：

- 出厂台账的导出/导入/登记/状态流转只放给 **本工区资料员**（默认 `一工区`）；
  监理、访客、其他工区资料员拿到链接也只能查看，服务层对越权操作当场拒绝（FORBIDDEN）。
- 账号定义在 `src/stores/session.ts`，当前选择持久化在 localStorage。

## 校验脚本（不进生产包）

```bash
cd frontend
node scripts/verify-ledger.mjs   # CSV/分卷/CRC/ZIP/打包口径/导入解析
node scripts/verify-service.mjs  # 权限拒绝/登记幂等/导入覆盖/配额回滚/存量重排迁移
```

