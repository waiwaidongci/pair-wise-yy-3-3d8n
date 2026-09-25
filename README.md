# 岩芯分样与外送台账

岩芯分样外送后，检测结果容易与母样混在一起、余料看不清。本应用在原切片流程之上，
补齐**母样余料登记、分样台账、外送冻结与回执归档、余料更正重算**。

运行：

```bash
npm start        # http://localhost:3025
npm test         # 核验层单元测试
npm run e2e      # 接口→核验→保存 端到端自检（临时库，不污染正式数据）
```

## 台账规则

- **母样登记余料**：数量 + 单位（m/kg/g/袋/块）+ 说明，登记一次；分样单位必须与余料一致。
- **分样写明**：编号、深度区间、数量、用途。登记即核验三类冲突：
  - 深度区间重叠（同母样分样之间）
  - 超出母样余料（累计分样数量 > 余料）
  - 编号重复（全台账）
  - 冲突**不拒绝**：新记录照常保留，冲突写入 `conflicts` 并在 `conflictNote`
    说明“原记录已保留”；旧记录一律不动，每次核验留痕在 `conflictHistory`。
- **外送后冻结**：分样置 `status=已外送`、`frozen=true`，不能重复外送。
- **回执归档**：首份回执必须填检测项目与结论，到达即归档（`archived=true`）；
  **迟到回执只进 `lateReceipts` 附注，永远不覆盖已归档结论**。
- **余料更正**：必须填原因，禁止无变化更正，已有分样时禁止改单位。
  - 未外送分样：按新余料**重算“超出余料”标记**（区间重叠、编号重复与余料无关，不重算），
    变化写入 `conflictHistory` 并列入更正记录的 `recomputed`。
  - 已外送分样：旧档冻结不动；仅当超量判定改变时标出
    `affectedByCorrection`（保留旧冲突与按新余料的判定对照），列入 `affectedShipped`。

## 分层结构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 接口层 | `server.js` | HTTP 路由、入参出参、错误码映射、页面；不写业务规则 |
| 核验层 | `src/domain/ledger.js` | 区间/余料/编号核验、冲突留痕、外送冻结、回执归档、更正重算（纯函数） |
| 保存层 | `src/store/json-store.js` | JSON 台账读写，临时文件 + rename 原子落盘 |

分样带内部 `uid`（`SP-...`）：编号重复时，外送/回执按 `uid` 精确定位，
业务编号（如 `FY-001-1`）仍是台账上看到的分样编号。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/samples/:id/remainder` | 登记母样余料 |
| POST | `/api/samples/:id/correct-remainder` | 更正余料（`total`、必填 `reason`） |
| POST | `/api/samples/:id/splits` | 登记分样（`id`、`depthFrom`、`depthTo`、`quantity`、`purpose`） |
| POST | `/api/samples/:id/splits/:uid/ship` | 登记外送并冻结 |
| POST | `/api/samples/:id/splits/:uid/receipt` | 回执（`items`、`conclusion`、可选 `testedAt`） |

原有的样本创建、切片、制片步骤、交付接口保持不变。
