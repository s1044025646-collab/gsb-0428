# 国际象棋合法走子与王安全核验后端

标准国际象棋局面的离线合法走子服务。输入 FEN，列出轮到一方的全部合法着法，验证指定的 UCI 坐标着法，并在合法时生成新 FEN 与逐项解释。只做局面规则与历史回放：不接入棋力引擎、不搜索最佳着法、不做联网对战。限定标准初始规则，不支持 Chess960；不追溯任意导入局面能否从开局真实到达。

技术栈：TypeScript + Node.js（内置 `node:http` 与 `node:sqlite`，零运行时依赖）+ SQLite。Windows 本地运行，不需要 Docker / WSL / 外部服务。

## 环境要求

- Node.js ≥ 22.5（使用内置 `node:sqlite`；在 Node 25 上开发验证）
- Windows / PowerShell

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript / tsx）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 运行全部规则与持久化测试
npm start          # 启动 API 服务（默认自动选择空闲端口）
npm run demo       # 演示：正常着法 / 王安全拒绝 / 短易位
```

指定端口：`node dist/cli.js serve --port 8080`，或设置环境变量 `PORT`。端口为 0（默认）时由系统分配空闲端口并打印实际端口。

数据目录：项目内 `data/chess.db`，可用环境变量 `CHESS_DB` 覆盖。

## 规则实现要点

- **候选走子与王安全分离**：先生成六种棋子的候选走子（`src/movegen.ts`），再在试走后的局面中排除己方王仍受攻击的着法。受攻击判定是纯攻击规则扫描（兵的攻击格与移动格不同、被钉住的棋子仍计入攻击），不递归调用合法走子生成，无循环依赖。不允许吃掉对方王。
- **易位**：需要原有权利、王车在位、途中空格，且王起点/经过格/终点均不受攻击；王车同时移动。王移动、车移动或角落车被吃后永久移除对应权利。
- **吃过路兵**：只对 FEN 给定的本轮机会有效；试走时移除旁边的兵再检查暴露的攻击线（如横线车/后的牵制）。
- **升变**：兵到底线必须显式指定 `q/r/b/n`，不默认升后。
- **计数**：兵移动或吃子重置半回合计数，否则 +1；黑方走后回合编号 +1。
- **着法输出顺序固定**：起点格 a1→h8，再终点格 a1→h8，升变按 q,r,b,n。

## 局面一致性规则（导入时校验）

FEN 六个字段的形式校验（8 行、每行 8 格、合法棋子、行棋方、易位权利、过路格格式、计数非负）之外，还校验：

- 双方各恰好一个王
- 兵不能停在第 1/8 横排
- 双方王不能相邻
- 非行棋方的王不能正被攻击（否则上一手不合法）
- 易位权利所需的王与车必须在原位
- 过路兵格：目标格为空、对应纵线有刚走两格的兵、兵起点为空（不保证一定存在合法的吃过路兵着法）

形式合法但无法从初局到达的局面不额外追溯。

## HTTP API

无状态局面接口（`POST`，JSON 请求体）：

| 路径 | 请求体 | 说明 |
| --- | --- | --- |
| `/api/positions/validate` | `{fen}` | 校验 FEN 与一致性规则 |
| `/api/positions/legal-moves` | `{fen}` | 列出全部合法着法（UCI，固定顺序） |
| `/api/positions/explain` | `{fen, move}` | 解释候选着法：合法给逐项说明，非法给实际原因与相关格子 |
| `/api/positions/apply` | `{fen, move}` | 执行着法，返回新 FEN 与状态 |
| `/api/positions/status` | `{fen}` | 将军 / 将死 / 逼和 / 合法着法数 |

持久化对局接口：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/games` `{fen?}` | 导入局面创建对局（缺省初始局面） |
| `GET /api/games` / `GET /api/games/:id` | 列出 / 查询对局 |
| `GET /api/games/:id/moves` | 当前合法着法 |
| `POST /api/games/:id/moves` `{move, version}` | 落子；`version` 必须等于当前版本，否则 `409 VERSION_CONFLICT`；非法走子不写库 |
| `GET /api/games/:id/explain?move=e2e4` | 解释当前局面下的一步候选着法 |
| `GET /api/games/:id/status` | 将军 / 将死 / 逼和状态 |
| `GET /api/games/:id/history` | 着法链 |
| `POST /api/games/:id/replay` | 从初始 FEN 按已保存着法链重放并核验 |
| `GET /api/games/:id/export` | 导出初始 FEN + 着法链 |

错误统一为 `{"error": {code, message, details}}`，错误码包括：`INVALID_FEN`、`INVALID_POSITION`、`BAD_MOVE_FORMAT`、`ILLEGAL_MOVE`、`VERSION_CONFLICT`、`GAME_FINISHED`、`NOT_FOUND`、`BAD_JSON`、`MISSING_FEN`、`MISSING_MOVE`、`MISSING_VERSION`。

无合法着法时区分将死（被将军）与逼和（未被将军）；不实现三次重复、五十回合裁定与计时胜负。

## CLI

```powershell
node dist/cli.js validate "<fen>"     # 校验
node dist/cli.js legal "<fen>"        # 列合法着法
node dist/cli.js explain "<fen>" e2e4 # 解释候选着法
node dist/cli.js apply "<fen>" e2e4   # 执行并输出新 FEN
node dist/cli.js status "<fen>"       # 将军/将死/逼和
node dist/cli.js perft 2              # 叶子计数（初始局面 1 层=20，2 层=400，仅供规则测试）
node dist/cli.js new [fen]            # 导入创建对局
node dist/cli.js play <id> e2e4 [ver] # 落子（缺省自动读取当前版本）
node dist/cli.js history <id>         # 着法链
node dist/cli.js replay <id>          # 重放核验
node dist/cli.js export <id>          # 导出
node dist/cli.js serve [--port N]     # 启动 API
node dist/cli.js demo                 # 演示
```

FEN 含空格，需用引号包裹。

## 测试

`npm test` 覆盖：初始局面 perft 1/2/3 层（20 / 400 / 8902）、易位穿越受攻击格、吃过路兵暴露己王、四种升变、被钉住的子（不能走但仍攻击）、双将、将死与逼和、FEN 往返、回放一致、非法移动无写入、版本冲突、捕获车后权利消失、王不能相邻等。

## 已知限制

- 仅标准初始规则，不支持 Chess960；不校验局面是否可从开局真实到达。
- 不实现三次重复、五十回合裁定、计时胜负；`perft` 仅供规则测试，不做棋力搜索。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 单进程服务；并发安全依赖 SQLite 事务与版本号乐观锁。
