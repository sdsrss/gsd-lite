# PATTERNS — 本项目反复出现的缺陷形状（≤10 条，选题前先读）

1. **无条件宣布成功** — 出现 4 次。安装器解析不了 settings.json 照样打印
   「installed successfully」；卸载器对着错目录打印「uninstalled」；
   `gsd update` 把 6 种未比较的结局都说成「已是最新」；
   重装丢掉了承诺保留的 runtime/ 仍然报成功。
   **修法**：让收尾那句话由「实际发生了什么」推导（计数、返回值），
   而不是由「代码跑到了这一行」推导。三处 catch-and-continue 是共同的近因。

2. **散文声明没有可执行闸门在保证它** — 出现 3 次。README 指向 gitignore 掉的 `docs/`；
   README 自报的测试数与实际脱节；`scripts/pre-commit.sh` 以 100644 入库，
   仓库自带的 lint/test 闸门对任何克隆者从未生效。
   **修法**：把声明接到一条行为性测试上，并写明这条闸门**不**覆盖什么。

3. **平行路径只有一部分带闸门** — 出现 2 次。三条计划编写路径里只有两条校验
   `requires`；`install.js` 有 CLAUDE_DIR 守卫而 `uninstall.js` 没有。
   **修法**：把校验抽成一个函数让所有路径共用；
   消费者集合从源码派生，别手写名单。

4. **解析失败被当成「空值」而不是「未知」** — 出现 2 次。
   settings.json 解析失败 → `{}` → 覆写用户全部配置；
   task id 里 `parseInt` 得到 `NaN` → `Math.max` 永久传播 → `1.NaN` 落盘。
   **修法**：分清「没有值」和「读不出来」。前者可以给默认值，后者必须停下来。

5. **用 rename 做原子写，但目标是软链或被别的步骤删掉** — 出现 2 次。
   SessionStart 把软链形式的 CLAUDE.md 换成普通文件；
   自动更新的 `package.json.bak` 放在安装器会整个删掉的目录里。
   **修法**：写之前先 `realpath`；备份不要放在会被清理的路径下。
