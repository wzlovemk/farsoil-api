# FARSOIL API｜账号、经济与拍卖服务

> 本仓库从 `wzlovemk/fram-game/server/auction` 拆分而来。当前阶段仅完成仓库边界拆分，运行时仍保持 Node.js 22 + TypeScript + Fastify + SQLite；迁移 Cloudflare Workers / Durable Objects 属于后续独立阶段，不在本次拆分中改变。
>
> 统一服务端 OAuth/OIDC 回调和桌面客户端一次性会话交接已实现并进入代码验证；真实 Google 授权仍需本地私有密钥和浏览器联调。本文件描述当前代码。

## 运行时仓库边界

- `fram-game` 不得 import 本仓库的 `src/`、数据库类或业务实现。
- 游戏客户端只通过版本化 HTTP API（当前 `/api/v1/*`）以及未来明确的 WebSocket 协议访问服务端。
- 建筑购买/升级的服务器金币权威由 `/api/v1/economy/buildings/*` 提供；本地施工材料、任务与 Simulation 仍属于游戏客户端 Worker。
- 跨仓库 E2E 必须启动真实 API 进程并通过 HTTP/WebSocket 验证，不允许通过相对路径把两仓库源码拼成一个运行时。
- 构建期的一致性脚本可以显式读取另一个仓库的事实文件，但这不构成运行时依赖。

## 架构边界

- Node.js 22、TypeScript、Fastify、SQLite（支持迁移至独立 PostgreSQL 适配层）。独立部署，**不依赖 Cloudflare API**。
- `account_users.user_id` 是永久身份；`account_password_credentials`、`account_identities`、`account_sessions`、`auth_challenges` 单独管理认证与登录方式。Token 是短期不透明 Bearer，服务器只保存哈希。刷新用独立轮换 `HttpOnly; Secure; SameSite=Lax` Cookie，不写入客户端本地存储。
- `markets` 的配置化全服共享 `marketId` 只标记服务器拍卖范围；服务端通过真实认证 Session 确定各方 `userId`。钱包、服务器可售库存、挂单卖家、出价人、成交买家、冻结及托管、结算、出价历史、幂等结果分别按 `userId` 追溯。
- `config/mock-fixtures.v1.json` 是**模拟测试资产**，不代表真实 Worker 生产、金币或背包库存。当前游戏背包尚不读取服务器可售库存；只有拍卖服务端持有其模拟库存。
- 挂单最长有效展示 24 小时，实际支持的竞拍截止选项来自 `auction.v1.json`（30 分钟 / 2 小时 / 6 小时）。**到期的是挂单而非货物**：流拍/合法撤单将完整托管 Lot 原子返还卖家服务器库存，有有效最高出价则成交交付买家；所有结算与退货幂等，账号、余额与交易历史不因挂单到期删除。
- **旧游客 Session 不兼容**：`POST /api/v1/auth/guest` 已从服务器运行路由和 OpenAPI 删除，旧 `sessions` 表升级后删除；不支持旧游客 Token 恢复/迁移。用户的历史 `guestId` **IndexedDB 本地存档另行保留**，两者不是同一概念。

## 本地开发和部署

服务端独立运行（Node.js ≥22.13）：

```bash
npm install
npm run typecheck
npm test
npm start
```

启动后默认 `127.0.0.1:3001`，健康端点 `GET /health`。游戏客户端位于独立仓库 `wzlovemk/fram-game`；其开发/测试客户端默认直接请求该服务器，Vite 的 `/api/v1` 代理仍保留供显式同源模式使用。正式部署要求 HTTPS 并建议同源反向代理。

### 全局客户端服务器地址

游戏客户端的唯一默认服务器地址配置位于 `wzlovemk/fram-game/config/server-request.v1.json` 的 `serverUrls`：

- `test: "http://127.0.0.1:3001"`：Vite `development` / `test` 模式共用的测试服务器。
- `production: ""`：正式地址待定，留空保持同源相对请求；其他模式也使用此项，不自动带入测试地址。
- Vite 的显式同源开发代理也读取此测试项，仅在 `development/test` 模式启用；正式模式和正式预览不继承测试代理。
- 游戏客户端的账号、Google/Steam 起始跳转、拍卖及成就通过 `wzlovemk/fram-game/src/api/serverAddress.ts` 解析同一地址。地址只包含 HTTP(S) Origin，不包含 `/api/v1`、查询、片段或用户信息；末尾 `/` 自动规范化。
- 优先级：显式客户端 `serverUrl` → 非空 `VITE_GAME_SERVER_URL` → 非空旧 `VITE_AUCTION_SERVER_URL` → 当前模式的 JSON 配置。显式 `serverUrl: ""` 保留同源测试/代理能力；空环境变量不覆盖有效默认值。
- `VITE_AUTH_PUBLIC_ORIGIN` 仅保留为特殊部署的 OAuth Origin 覆盖，空值继承全局地址；原跨主机 Cookie 一致性检查不变。
- JSON 与 `VITE_*` 都是公开的构建期配置；正式配置改变后须重新构建，不能在其中放 Client Secret。可用根目录 `.env.example` 创建按模式的 `.env.*.local` 覆盖，避免测试覆盖污染正式包。

### 本地 Google OAuth（独立 API 服务器负责 Start / Callback）

1. 在 Google Cloud「Web 应用」的已获授权重定向 URI 中登记**精确地址**：`http://127.0.0.1:3001/api/v1/auth/callback`。不能继续使用旧的 `/auth/google/callback`，也不能将 `localhost` 与 `127.0.0.1`、端口 `3000` 与 `3001` 混用。
2. 将 `.env.example` 复制为 `.env`，填写服务器私有 `AUTH_GOOGLE_CLIENT_ID` 和**新轮换的** `AUTH_GOOGLE_CLIENT_SECRET`；该文件被 Git 忽略。不要提交 Google 下载的客户端密钥 JSON。
3. 在本仓库执行 `npm run dev:local`，监听 `127.0.0.1:3001`，授权服务器的 `AUTH_PUBLIC_ORIGIN` 也设为这个 Origin。
4. 从 `wzlovemk/fram-game` 根目录使用 `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort` 启动 Web 客户端，访问 `http://127.0.0.1:5173`。测试服务器地址已在全局 JSON 中配置，默认不需要额外创建前端 `.env.local`。
5. 点击 Google 登录，浏览器将进入 `http://127.0.0.1:3001/api/v1/auth/start?provider=google`，经 Google 授权后回到同一 API 服务器的统一 `/api/v1/auth/callback`，最后由服务器按 `AUTH_CLIENT_RETURN_ORIGIN` 返回游戏前端。Web 客户端沿用已有的 `/auth/restore` 领用 Session。

**Cookie 边界**：本地 `5173` 和 `3001` **必须使用同一个主机名**（本例均为 `127.0.0.1`），这样同主机下的 Host-only Cookie 才能通过 Vite 代理送达服务端；跨设备或远程服务端不能用 `127.0.0.1`，必须配置真实可访问的 HTTPS 域名。浏览器需支持回环地址的 Secure Cookie 例外；正式环境不放宽 Cookie 安全属性。


| 环境变量 | 含义 |
| --- | --- |
| `AUCTION_HOST` | 监听地址，默认 `127.0.0.1` |
| `AUCTION_PORT` | 端口，默认 `3001` |
| `AUCTION_SQLITE_PATH` | 数据库路径，默认 `data/auction-demo.sqlite` |
| `AUCTION_CORS_ORIGINS` | 允许网页 Origin 的精确白名单，以逗号分隔 |
| `AUTH_PUBLIC_ORIGIN` | Google/Steam 的授权服务器 Origin；本地示例 `http://127.0.0.1:3001`，正式环境必须为 HTTPS |
| `AUTH_CLIENT_RETURN_ORIGIN` | 浏览器认证成功后跳转的前端 Origin；必须由服务器环境配置，不允许客户端任意指定 |
| `AUTH_GOOGLE_CLIENT_ID` | Google OAuth/OIDC Client ID |
| `AUTH_GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret |

不要把生产密钥提交 Git。Google/Steam Provider 的允许开关在 `config/auth.v1.json`，对应客户端入口在 `wzlovemk/fram-game/config/account-auth-client.v1.json`：**Google 已启用，Steam 暂未启用，Apple 首期不实现**。Provider 仍需正确环境变量与真实授权联调才可使用。Steam 网页 OpenID 2.0 登录无需 Google OAuth Client Secret。

配置文件：
- `config/auth.v1.json`：密码、KDF、Session、Provider、OAuth challenge 和桌面一次性交接有效期、限流。
- `auth-handoff-schema.sql`：v10 桌面登录事务数据库持久层（仅保存客户端证明哈希，绝不保存明文 Token）。
- `user-profile-schema.sql`：v11 用户资料与账号已验证邮箱归属的增量迁移；既有邮箱密码、会话、拍卖、成就不重置。
- `config/user-profile.v1.json`：资料昵称长度、头像 URL 域名白名单及编辑限流。
- `config/auction.v1.json`：共享市场 ID、挂单截止上限、竞价/买断/幂等/分页。
- `config/mock-fixtures.v1.json`：演示用户初始金币/库存、NPC 挂单和多语言商品 catalog。

## 认证 API（`/api/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/register` | 邮箱密码注册，**不验证邮箱**；建立永久 userId |
| POST | `/auth/login` | 已注册邮箱密码登录，不静默自动注册 |
| GET | `/auth/me` | 当前用户的主账号认证邮箱（及验证状态/来源）、密码登录邮箱、Provider 绑定与邮箱冲突状态 |
| POST | `/auth/restore` | 旋转 HttpOnly Refresh Cookie，返回新 Access Token |
| POST | `/auth/renew` | 有效 Bearer Access Token 轮换 |
| POST | `/auth/revoke` | 撤销当前账户 Session，并清除刷新 Cookie |
| GET | `/auth/start?provider=google\|steam` | 浏览器进入独立认证服务器，由服务器创建 Provider 授权事务 |
| POST | `/auth/start` | 桌面客户端请求 `{provider,clientType:"desktop"}`，得到 `loginId`、一次性 `clientSecret`、`browserUrl` 和到期时间 |
| GET | `/auth/start?loginId=...` | 浏览器用桌面授权事务打开 Google/Steam 页面，服务器创建不可重放的 OAuth challenge |
| GET | `/auth/callback` | **统一回调**：由服务器存储的 state 判定 Provider；Google 验证 OIDC，Steam 验证 OpenID 断言 |
| GET | `/auth/status?loginId=...` | 桌面客户端轮询 pending/ready/consumed/expired，不返回身份或 Token |
| POST | `/auth/complete` | 桌面端通过 `loginId+clientSecret` **单次**领取会话；浏览器回调绝不携带 Session Token |
| POST | `/auth/link/{google\|steam}` | 已登录账号显式绑定第三方，禁止按邮箱自动合并 |
| POST | `/auth/password/setup` | 第三方账号近期认证后设置邮箱密码 |
| POST | `/auth/password/change` | 最近登录且提交原密码后修改密码、撤销其它 Session |
| GET | `/users/me/profile` | 当前 Session 所属 `userId` 的昵称、头像及来源，Bearer 认证 |
| PATCH | `/users/me/profile` | 修改当前玩家昵称/默认或 Google 头像选择，配置化校验及限流 |

认证 Cookie 请求需要 `X-SBF-Auth: v1` 且执行 CSRF/Origin 校验。Access Token 仅在 JS 运行内存，其他受保护业务 API 使用 `Authorization: Bearer <token>`、`credentials:"omit"`。**邮箱密码自行注册的邮箱仍默认为未验证**；Google 经可信 OIDC 核实 `email_verified=true` 后，将对应邮箱写入当前 `userId` 的认证邮箱，但不自动开通密码登录或合并账号。Steam OpenID 当前不提供可信邮箱；Google/Steam 未来返回的邮箱冲突均不得接管另一账号。忘记密码暂不支持自助找回。

## 拍卖 API（`/api/v1/auction`）

- 查询：`GET /bootstrap`、`/listings`、`/listings/{id}`、`/sellable-items`、`/mine`、`/requests/{id}`。
- 写入：`POST /listings`、`/listings/{id}/bids`、`/listings/{id}/buyout`、`/listings/{id}/cancel`。
- 写入必须携带唯一 `Idempotency-Key`，竞拍/一口价/撤单必须使用最新 `expectedVersion`，全部资产改变/托管和退货在服务器事务完成。同一意图重复重试不重复扣款/返货。
- 商品名称搜索、过滤、分类与结果语言使用 `Accept-Language`，商品 ID/库存数量/货币精度保持语言无关。可售商品数量从服务器 `inventories` 按当前 `userId` 读取；当前背包 UI 暂不同步。
- HTTP 公共 Header、请求 ID、语言、平台由游戏客户端 `wzlovemk/fram-game/src/api/serverRequest.ts` 统一生成；`timestamp`/`nonce`/`deviceFingerprint` 仍按原配置禁用。

## 迁移与验证

- SQLite `user_version=11`：在既有 v10 账号、共享拍卖、成就、掉落及 OAuth 桌面交接表之上，增量新增 `user_profiles/account_emails`；回填已注册的原密码登录邮箱，并以 `userId` 关联，不更改旧身份；升级前备份数据库。
- `npm test`：验证邮箱/第三方模拟授权、Session 轮换、共享拍卖、两人交叉竞拍、挂单到期退货、库存守恒和请求幂等。
- 本仓库 `.github/workflows/api-ci.yml` 负责服务端类型检查、构建、测试和 Docker smoke；游戏客户端的 Chromium 联调验收继续位于 `wzlovemk/fram-game`，CI 会在运行时检出本仓库。
- **验收限制**：测试使用模拟的 Provider 响应；真实 Google 登录仍需在授权网页完成端到端联调。桌面系统浏览器的启动行为和凭据安全保存应由具体桌面外壳（如 Electron/Tauri）适配；本阶段仅提供服务端交接 API 和客户端调用方法。原有本地游戏背包与服务器资产可信同步不属于本次 OAuth 修改。

## DROP-01：正式掉落配置和上线前检查

DROP-01 当前仅为**已经实现的服务器抽奖能力**，并非生产奖品已经启用。默认 `config/event-drops.v1.json` 的两条示例规则仍关闭，`assetIssuanceEnabled:false`；示例蓝晶石不在当前服务器可售目录内。当前拍卖采用 `demo` 市场/金币/库存，不能把 Mock 测试结论当作真实经济放行。

- 可由服务端进程环境变量 `AUCTION_DROP_CONFIG_FILE` 选择审核后的私有 JSON 规则文件；未设置则继续读取默认示例配置。Docker 支持把正式配置只读挂载至 `/app/config/event-drops.production.json`；文件在**启动时**读取，不接受客户端覆盖，也不支持热更新。
- `config/event-drops.production.template.json` 是空规则、关闭发行的安全模板，**不是最终正式稀有物品列表**。将来需要核准奖励商品 ID、数量、触发条件和概率后单独生成正式配置。
- `npm run drop:preflight`：只验证配置和商品目录一致性，返回 `CONFIG_VALID` 不代表已经可上线。
- `npm run drop:release-check`：只读上线前置门禁，要求显式指定独立正式配置、抽奖及发奖总开关均开启、至少一条规则启用，且拍卖市场不为 `demo`；否则返回非零退出码 `RELEASE_BLOCKED`。即使返回 `RELEASE_PRECHECK_PASS`，仍须通过真实账号、HTTPS、持久化数据库、可售入库和跨账号交易的独立环境验收。
- 服务器运行入口另外拒绝**默认发行引擎**在 `demo` 市场下开启资产发行。仅由专项测试明确注入的测试 `DropEngine` 不受此运行时门禁影响，方便在隔离 SQLite 中验证原子入账。
- 线上问题应先关闭发奖配置并重启，而不是删除历史抽奖、最后中奖时间和已入账库存。

上线任务清单见 `wzlovemk/fram-game/doc/59-ACHIEVEMENTS-V1.md` §15.2。本阶段仍为 `BLOCKED`，不可擅自将占位规则转成正式概率。
