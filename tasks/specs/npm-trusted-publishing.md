# npm 发布改用 trusted publishing（GitHub Actions OIDC）
状态：进行中（仓库改动已完成并在本地提交；npmjs.com 配置与首次发版由用户决定）

## 背景与目标
`release.yml` 的 publish job 用 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` 发布。目标：改成 npm trusted
publishing，仓库里不再引用任何 npm token，信任配置一旦出错，publish 直接失败，不会悄悄回退到 token。

## 范围
- 做：`.github/workflows/release.yml` 的 publish job；提到 NPM_TOKEN 的注释和测试；`tests/repo-gates.test.js`
  加一条"workflow 非注释行不得出现 NPM_TOKEN / NODE_AUTH_TOKEN"的断言。
- 不做：npmjs.com 上的配置（用户自己填）；push、打 tag、发版；删除仓库的 NPM_TOKEN secret（首次 OIDC 发版验证
  `_npmUser` 之后，问过用户再删）；validate job 的 Node 版本（它不发布）。

## 验收标准
- [x] AC1：所有 npm 发布点都已列出 — 验证：`git grep` 查 `npm publish|NPM_TOKEN|NODE_AUTH_TOKEN|semantic-release|changeset|workflow_call|pnpm|yarn`
- [x] AC2：新断言在旧 workflow 上失败、在新 workflow 上通过 — 验证：分别在改 workflow 前后运行 `node --test tests/repo-gates.test.js`
- [x] AC3：publish job 用 Node 24，`id-token: write` 还在，任何层级都没有 token；"版本已存在就跳过"仍然保留
- [x] AC4：`npm run lint` 与 `npm test` 全部通过
- [ ] AC5（发版时）：每个包 `npm view <包>@<版本> _npmUser` = `GitHub Actions <npm-oidc-no-reply@github.com>`

## 方案
- 发布点只有一个：`release.yml` → `publish` job → `npm publish "$TARBALL" --access public --provenance`。
  没有 pnpm、yarn、changesets、semantic-release，没有第三方 publish action，也没有 `workflow_call`。
  `package.json` 的 `prepublishOnly` 只在发布目录时运行（npm `lib/commands/publish.js`：
  `if (spec.type === 'directory' ...)`），这里发布的是 tarball，不会触发。
- Node 22 → 24（npm ≥ 11.5.1）；`registry-url` 保留；`--provenance` 保留（`tests/repo-gates.test.js` 断言了它）。
- 删掉 publish step 上的 `NODE_AUTH_TOKEN`。其他层级本来就没有 token。没有"token 为空就跳过"的步骤，也没有去掉
  provenance 重发的回退。Preflight 那一步检查的是 `RELEASE_SIGNING_KEY`（签名用），保留，只改它注释里提到 NPM_TOKEN 的那句。
- 去掉 secret 后会怎样（已核实）：
  - actions/setup-node（固定 SHA a0853c24，v5）的 `src/authutil.ts` 在设置了 `registry-url` 时会写
    `_authToken=${NODE_AUTH_TOKEN}`，并导出 `NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX` 占位值。OIDC 失败时
    npm 回退用的就是这个假 token，publish 会以 401 或 404 失败，不会发出去。
  - npm `lib/utils/oidc.js`：OIDC 换 token 失败时只记 `log.verbose`，然后返回，publish 继续使用已有凭据。
    tarball 发布同样会走这段逻辑。
  - "已发布就跳过"用的 `npm view`，在占位 token 下照常工作（本机 npm 11.19.0 实测：0.19.0 返回 `0.19.0`，99.0.0 返回 E404）。

## 计划
- [x] S1：列出发布点 — 覆盖 AC1
- [x] S2：先加断言并确认它在旧 workflow 上为红 — 覆盖 AC2
- [x] S3：改 workflow 和注释，断言转绿 — 覆盖 AC2、AC3
- [x] S4：lint + 全量测试，本地提交 — 覆盖 AC4
- [ ] S5（等用户）：npmjs.com 配置 → 打 tag 前评审 → 发版 → 核对 `_npmUser` → 问用户是否删 secret — 覆盖 AC5

## 决策与进展
- 分支 `ci/npm-trusted-publishing`，没有提交到 main（项目约定是走 PR）。
- 断言匹配时不区分大小写，覆盖 ci.yml 和 release.yml 两个文件，用 `withoutComments()` 去掉注释后再匹配。
- 新断言不覆盖其他名字的 token（例如 `secrets.NPM_PUBLISH_TOKEN` 配合手写 `_authToken`），按用户给的范围只写这两个名字。
- npm 11 的变化：发布低于已发布最高版本的版本号且不带 `--tag` 时会被拒绝（npm `publish.js`：
  `Cannot implicitly apply the "latest" tag`）。本仓库一直是线性发版，暂时不受影响；要回补旧版本线时需要加 `--tag`。

## 验证记录
- 新断言在旧 workflow 上：`node --test tests/repo-gates.test.js`（只跑新加的那组）→ 失败，`release.yml:202: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`；第 106 行注释里的 NPM_TOKEN 没有被报
- 改 workflow 后：`node --test tests/repo-gates.test.js` → 通过（30/30）
- `python3 yaml.safe_load(release.yml)` → 通过：publish 的 permissions 为 `contents: write` 和 `id-token: write`；setup-node 为 `node-version: 24` 加 `registry-url`；publish step 的 env 只剩 `TARBALL`；job 和 workflow 两级都没有 env；没有 `continue-on-error`
- `npm run lint` → 通过（124 个文件）
- `npm test` → 通过（2142/2142，失败 0，取消 0）；pre-commit 钩子提交时又跑了一遍 → 失败 0
- `bash scripts/gate-replay-changed.sh main HEAD` → DISCRIMINATIVE（在 943fb8b 上 30 条里 1 条失败，就是新断言）
- 占位 token 下的 `npm view`（本机 npm 11.19.0 配 setup-node 同款 .npmrc）→ 0.19.0 返回 `0.19.0`；99.0.0 返回 E404
- 提交：`415151e`（分支 `ci/npm-trusted-publishing`）
- AC5：未运行，要等首次 OIDC 发版
