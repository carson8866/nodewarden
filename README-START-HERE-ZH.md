# Carson Vault：KV 部署版 + R2 加密备份

业务数据使用 D1，附件继续使用 KV；专用私有 R2 桶 `carson-vault-backups` 只保存自动生成的密码库备份。备份包和附件均使用 AES-256-GCM 加密后再写入 R2，不启用公开域名。生产环境每日 03:00 UTC 自动备份，保留最近 30 份；首次部署后第一次 Cron 会立即创建首份备份。本地 dev 未绑定 R2 时会跳过自动备份。

## Windows 试用
1. 安装 Node.js 24 LTS 和 Git。
2. 下载本仓库并解压，进入项目目录。在地址栏输入 cmd 并回车。
3. 依次执行：

```bat
npm ci
npm run verify
```

4. 用记事本创建 `.dev.vars` 文件（不要保存成 .txt），内容为 `JWT_SECRET=` 后接自己生成的至少 32 位随机字符串。仅保存在本机，不上传，不发给任何人。生成命令：

```bat
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

5. 启动：

```bat
npm run dev
```

6. 打开终端显示的 http://127.0.0.1:8787 地址。第一次注册成为管理员，只使用虚构测试数据。
7. Ctrl+C 停止；下次 npm run dev 重启。本地数据在 .wrangler/，删除它会丢失测试数据。

## 账号说明
Bitwarden 官方免费账号不会自动出现在这里。这里需要新建独立账号。免费官方客户端可以选择自托管地址，但本次 localhost 只能供同一电脑访问，手机不能通过自身 localhost 连接此电脑。此阶段不承诺所有官方客户端接受本地 HTTP。

## Cloudflare 网页部署
仓库：carson8866/nodewarden。Worker 名称必须为 carson-vault。
构建命令：npm run verify
部署命令：npm run deploy:kv
根目录：仓库根目录。生产分支：main。此仓库不包含自动发布到 Cloudflare 的 GitHub Actions。
配置使用独立 carson-vault-db 数据库、精确匹配的 KV 命名空间，以及 R2 绑定 `VAULT_BACKUPS` → `carson-vault-backups`；不会按后缀复用其他实例的 KV。附件仍保存在 KV，不要把 `VAULT_BACKUPS` 改成附件绑定。
JWT_SECRET 由用户自己在 Worker 的运行时 Variables and Secrets 中设为 Secret，至少32位随机字符，禁止提交。R2 备份加密密钥由此 Secret 经 HKDF 派生；必须保留 JWT_SECRET 的离线恢复副本，变更或丢失它会导致旧 R2 备份无法解密。
首次部署后立即注册自己的管理员，启用 TOTP，保存恢复码。不要用真实密码做初次验证。

## 域名和搜索收录
推荐独立子域名，例如 mima.bdbrim.com。不要使用主站 /mima 子路径、主站域名或通配主站路由。
自定义域名通过 Cloudflare 后台添加，先核对该子域名未被使用。本仓库不硬编码业务域名。
HTML 已带 X-Robots-Tag: noindex, nofollow, noarchive, nosnippet。
robots.txt 允许抓取，以便搜索引擎读取 noindex。允许抓取不等于允许读取已登录密码库。
不要向主站 sitemap 加入此服务，不需要修改主站 robots.txt。不承诺地址完全不可发现或 SEO 绝对零影响。

## R2 自动备份与恢复
- 自动备份包含密码库记录、文件附件及恢复所需的持久化数据；运行会话、一次性令牌和 API key 不进入备份。
- 备份对象位于 `vault-backups/`，仅通过 Worker 的 `VAULT_BACKUPS` 绑定访问；不要给桶启用 `r2.dev` 或自定义公开域名。
- 管理员接口：`GET /api/admin/backup/r2` 查看快照；`POST /api/admin/backup/r2/run` 手动创建快照；`POST /api/admin/backup/r2/restore` 恢复快照。运行和恢复接口要求管理员重新验证主密码，凭据必须放在 POST JSON body，禁止放 URL。
- 恢复接口的 `replaceExisting: true` 会替换当前实例数据，执行前必须确认目标快照和恢复范围。
- 备份使用 AES-256-GCM，密钥从 `JWT_SECRET` 派生。轮换 `JWT_SECRET` 前必须先完成旧备份迁移；否则旧快照将无法解密。

## 上线验收（尚待完成）
- 首页正常，HTML 带 noindex；robots.txt 允许爬虫读取该响应头。
- /api/web-bootstrap 无缺少 Secret 或数据库错误。
- 用户亲自注册、登录、TOTP，新增虚构密码并在另一个客户端同步。
- 小附件上传、下载，导出备份并在隔离测试实例恢复。
- 对比主站主页和产品页，确保主站响应不受影响。

上游完整说明见 README.md / README_ZH.md；本文件说明此仓库的部署差异。
