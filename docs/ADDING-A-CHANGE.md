# 如何新增 / 维护一条本地改动

> 本文面向「要往 GitLens 构建产物里加一处改动」的场景，讲清楚**为什么**不用 `.patch`、**怎么写**一条规则、**怎么验证**、上游重构后**怎么修**。

---

## 1. 为什么不用 `.patch`

历史上 `patches/*.patch` + `git apply` 一直在坏。根因不是补丁写得不对，而是**补丁这种格式本身与上游演进天然冲突**：

```diff
@@ -33,63 +33,12 @@ export function compareSubscriptionPlans(
  * Surfaces gated on this (e.g. the Commit Graph) replace ...   ← 上下文行
  */
-export function isAccountAccessRequired(...) { ... }
+export function isAccountAccessRequired(_subscription) { return false; }
 }
                                                               ← 上下文行
 
 export function getSubscriptionNextPaidPlanId(...)            ← 上下文行：上游一旦在这里插入
                                                                  新函数，整条 hunk 就失配
```

真实案例：上游 v19.4.0 在 `computeSubscriptionState()` 与 `getSubscriptionNextPaidPlanId()` 之间插入了新函数 `omitRefusedTrialReactivation()`，导致整条 hunk#1 报废（hunk#2~#4 本来还能干净应用）。

现在的做法：**按函数名定位、按函数体写回**。上游在旁边增删、重排、改注释都无所谓；只有目标函数本身被重构时才会失败，而且会指名道姓地告诉你失败在哪。

| 维度 | 传统 `.patch` | 现在的 codemod |
|---|---|---|
| 定位依据 | 行号 + 前后 3 行上下文 | 函数名 / 形参签名 / 唯一字面量调用 |
| 上游在旁插入代码 | ❌ 失效 | ✅ 无影响 |
| 上游重排、改注释、动无关函数 | ❌ 失效 | ✅ 无影响 |
| 上游真重构了目标函数 | ❌ `patch does not apply`，不知为何 | ✅ `::error file=…::[规则名] <具体原因>` |
| 二次运行 | ❌ 报错 / 重复插入 | ✅ 幂等，识别「已应用」 |
| 审计 | 读 `.patch` | `--diff` 导出**真实 diff**，写入 Job Summary |

---

## 2. 机制总览

```
build.yml
  ├─ checkout 上游 tag (vX.Y.Z)
  ├─ checkout 本仓库 → source-repo/  (sparse-checkout: scripts)
  ├─ node source-repo/scripts/apply-patches.mjs --root .   ← 唯一入口
  │     ├─ lib/codemod.mjs   扫描原语（零依赖；注释/字符串/模板/正则一律屏蔽）
  │     └─ lib/rules.mjs     改动规则列表
  ├─ pnpm exec oxfmt --write <被改动的文件>
  ├─ pnpm install
  ├─ pnpm package
  └─ 计算 SHA-256 → 创建 Release
```

| 文件 | 职责 |
|---|---|
| `scripts/apply-patches.mjs` | CLI 入口：校验上游 checkout、逐条规划并应用规则、导出 diff、写 Job Summary |
| `scripts/lib/codemod.mjs` | 扫描原语：代码掩码、括号配对、按名定位函数/形参/顶层 `return`/调用表达式 |
| `scripts/lib/rules.mjs` | 规则列表（**新增改动只改这个文件，workflow 不用动**） |

`apply-patches.mjs` 的三个开关：

| 开关 | 作用 |
|---|---|
| `--root <dir>` | 指定上游 checkout（默认当前目录） |
| `--check` | 只校验锚点与写回逻辑，**一个字节都不写**（CI 用的就是它） |
| `--diff <file>` | 应用后把真实 unified diff 导出到文件（同时进 Job Summary） |

---

## 3. 一条规则的契约

在 `scripts/lib/rules.mjs` 的 `rules` 数组里，一条规则就是一个对象：

```js
{
	id: 'my-rule',                              // 稳定标识：出现在报错信息与 Job Summary 里
	file: 'src/plus/gk/utils/xxx.utils.ts',     // 相对上游仓库根
	title: '一句话说明这条规则改了什么',           // 出现在 Job Summary 的表格里

	/** 是否已应用。双重身份：① 已应用则跳过 ② 应用后自检（返回 false = 构建失败） */
	isApplied(src) { /* ... */ },

	/** 纯函数式改写：只返回新源码 + 备注，不落盘、不产生副作用 */
	apply(src) { /* ... */ },
}
```

两条硬性约定：

- **`apply()` 必须是纯函数**：只读 `src`、只返回 `{ src, notes }`。落盘由入口统一在「全部规则规划成功之后」做，这样任何一条规则失败都不会留下半成品。
- **`isApplied()` 必须能从「改后的源码」上判定为真**。它是唯一能防住「规则悄悄失效、构建却照常出包」的闸门。

---

## 4. 扫描原语速查（`scripts/lib/codemod.mjs`）

所有原语都接受一个 **代码掩码** `mask = buildCodeMask(src)`：它是与源码等长的 `Uint8Array`，代码字符标 1，注释 / 字符串 / 模板字面量 / 正则字面量标 0。因此括号统计永远不会被 `'{'` 这样的字符串噪声干扰。

| 原语 | 返回值 / 用途 |
|---|---|
| `buildCodeMask(src)` | `Uint8Array`；每个文件开头算一次，后续所有原语共用 |
| `findFunction(src, mask, name)` | `{ name, line, declStart, paramsStart, paramsEnd, params[{name,start,end}], bodyStart, bodyEnd, body }`；找不到、同名多份、形态异常都会**抛错** |
| `matchBalanced(src, mask, i, '{', '}')` | 从 `i` 处括号找到配对括号的下标 |
| `findTopLevelReturns(src, mask, bodyStart, bodyEnd)` | 函数体**顶层**（不含嵌套块与回调里）的 `return` 起点数组 |
| `findCalls(src, mask, from, to, callee)` | 区间内所有 `callee(...)` 调用表达式，返回 `{ start, end }`（`end` 含右括号） |
| `applyEdits(src, [{ start, end, text, source }])` | 应用编辑；**自动检测重叠**并按 `source` 报错 |
| `escapeRegExp(value)` | 把字符串安全嵌入 `new RegExp(...)` |

坐标一律是**绝对偏移**（可直接用于 `src.slice()` 与 `applyEdits`）。

---

## 5. 新增一条改动：完整流程

### Step 0 · 先问「这改动必须动源码吗？」

优先顺序：上游配置项 → 环境变量 → 扩展设置 → **最后**才是改源码。每加一条规则就多一处上游耦合面。

### Step 1 · 准备上游沙箱

```bash
cd /path/to/Rebuild-gitlens
git clone --depth 1 --branch v19.4.0 \
  https://github.com/gitkraken/vscode-gitlens.git .work/upstream

# 需要类型检查时再装依赖（有缓存时约 20s）
(cd .work/upstream && pnpm install)
```

### Step 2 · 确认目标函数还在、长什么样

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { buildCodeMask, findFunction } from './scripts/lib/codemod.mjs';
const src = readFileSync('.work/upstream/src/plus/gk/utils/subscription.utils.ts', 'utf8');
const mask = buildCodeMask(src);
const fn = findFunction(src, mask, 'getCommunitySubscription');
console.log('line:', fn.line, '| params:', fn.params.map(p => p.name).join(', '));
console.log(fn.body);
"
```

### Step 3 · 在 `scripts/lib/rules.mjs` 追加规则

参见下方第 6 节的两个模板。

### Step 4 · 本地三步验证

```bash
cd /path/to/Rebuild-gitlens

# ① 只读校验：所有锚点都能找到吗（不写任何文件）
node scripts/apply-patches.mjs --root .work/upstream --check

# ② 实际应用 + 导出 diff，人眼核对「改的是不是你要的」
node scripts/apply-patches.mjs --root .work/upstream --diff .work/applied.diff
cat .work/applied.diff

# ③ 类型 + 格式（关键：能抓出收窄、签名一类的错误）
cd .work/upstream
pnpm exec tsc --noEmit --incremental false -p tsconfig.node.json 2>&1 | grep 你改的文件
pnpm exec oxfmt --write <你改动的文件>
```

> **`tsc` 基线对照**：这个工程本来就有 4 条无关既有报错 —— `packages/utils/src/plural.ts` 的 `document`、`src/webviews/apps/shared/events.ts` 的 `EventListener`。
> 判断标准是「**你的文件是否出现新增行**」，而不是「是否有报错」。Webview 侧还要看 `-p tsconfig.browser.json`。

### Step 5 · 提交并观察 CI

```bash
git add scripts/lib/rules.mjs
git commit -m "feat(patches): 新增 xxx 改动"
git push

gh run watch $(gh run list -R aliveranme/Rebuild-gitlens -L1 --json databaseId -q '.[0].databaseId')
```

`ci.yml`（Local Modification Validation）会自动对一个**全新的最新上游 release** 做两件事：

1. 应用全部规则 —— 任一锚点找不到即失败，并输出 `::error file=…::[规则名] 原因`；
2. 再跑一次 `--check` 校验**幂等性** —— 必须输出 `0 modified`。

### Step 6 · 出包（可选）

```bash
# 指定版本（该 tag 在本仓库不存在才会完整构建）
gh workflow run "Fix gitlens and build" -R aliveranme/Rebuild-gitlens -f version=v19.4.0

# 留空则自动取上游最新 release
gh workflow run "Fix gitlens and build" -R aliveranme/Rebuild-gitlens
```

---

## 6. 两个可复制模板

两个模板都假定 `rules.mjs` 顶部已有的这行 import 存在（用到新原语时记得补进去）：

```js
import { applyEdits, buildCodeMask, findCalls, findFunction, findTopLevelReturns, matchBalanced } from './codemod.mjs';
```

下面为了聚焦「改写逻辑」省略了防御性校验；**真实规则必须像现有规则那样，对 `null` / `-1` / 数量不符的情况抛错**（错误信息里带上函数名与规则名），否则一个静默的漏改会直接变成一次坏出包。

### 形态 A —— 整函数体替换（最常用）

```js
{
	id: 'my-rule',
	file: 'src/plus/gk/utils/xxx.utils.ts',
	title: 'myFunction() 恒返回 true',
	isApplied(src) {
		const mask = buildCodeMask(src);
		return findFunction(src, mask, 'myFunction').body.trim() === 'return true;';
	},
	apply(src) {
		const mask = buildCodeMask(src);
		const fn = findFunction(src, mask, 'myFunction');

		return {
			src: applyEdits(src, [
				{
					start: fn.bodyStart + 1,   // 左花括号之后
					end: fn.bodyEnd,           // 右花括号之前（end 不含）
					text: '\n\treturn true;\n',
					source: `${fn.name}() body`,
				},
				// 若形参因此不再被使用，可顺手改成 `_` 前缀（本仓库约定）
				// { start: fn.params[0].start, end: fn.params[0].end, text: `_${fn.params[0].name}` },
			]),
			notes: [`line ${fn.line}: myFunction() -> return true`],
		};
	},
},
```

### 形态 B —— 只改函数内的一处（插入 + 定位某个对象属性）

参考现有规则 `checkin-subscription-is-enterprise` 的骨架：

```js
apply(src) {
	const mask = buildCodeMask(src);
	const fn = findFunction(src, mask, 'funcName');

	// 1) 找到函数体里最后一个顶层 return
	const returns = findTopLevelReturns(src, mask, fn.bodyStart, fn.bodyEnd);
	if (returns.length === 0) throw new Error(`${fn.name}() has no top-level return statement to override`);
	const lastReturn = returns[returns.length - 1];

	// 2) 定位 return 对象里的目标属性，用括号配对抠出它的值区间
	const tail = src.slice(lastReturn, fn.bodyEnd);
	const prop = /\bplan\s*:\s*\{/.exec(tail);
	if (prop == null) throw new Error(`could not find the \`plan\` property of ${fn.name}()'s final return statement`);
	const valueStart = lastReturn + prop.index + prop[0].length - 1;   // 值对象的 '{'
	const valueEnd = matchBalanced(src, mask, valueStart, '{', '}');   // 值对象的 '}'
	if (valueEnd === -1 || valueEnd > fn.bodyEnd) throw new Error(`could not find the end of the \`plan\` property`);

	// 3) 插入声明 + 只替换属性值
	const insertAt = src.lastIndexOf('\n', lastReturn) + 1;
	return {
		src: applyEdits(src, [
			{ start: insertAt, end: insertAt, text: '	const x = ...;\n\n', source: 'declaration' },
			{ start: valueStart + 1, end: valueEnd, text: ' /* 新值 */ ', source: 'plan property' },
		]),
		notes: [`line ${fn.line}: funcName() -> ...`],
	};
},
```

**克隆优于手写**：如果需要的表达式上游本来就有一份（例如 `getSubscriptionPlan('community-with-account', …)` 的兜底调用），就用 `findCalls()` 找到它、`.slice()` 出原文、只替换关键的字符串字面量再写回去。这样上游增删参数、改字段名时，我们的代码自动跟随，永远编译得过 —— 现有规则 4 就是这么做的。

---

## 7. 四条铁律（都是踩过的坑）

1. **锚点只用结构**：函数名、形参名序、唯一字面量调用。**绝不用行号**。
2. **能克隆上游自己的表达式就克隆**，不要手写字面参数列表。
3. **`isApplied()` 只检测被改的那一个函数体**，不要用整文件 `src.includes('xxx')` —— 上游恰好存在同名标识符就会误判成功。
4. **不要在闭包读过某个 `let` 之后再给它赋值** —— 会破坏 TypeScript 的收窄，`tsc` 直接报 `TS18048`。

   实例：规则 4 第一版写成「在 return 前 `effective = enterprisePlan;`」，因为函数体前面有个箭头函数读 `effective`，TS 立即失去收窄并在 `effective.organizationId` 上报错。正确做法是**重写 return 里的 `plan` 属性**，不动任何 `let`。这个坑本地 `tsc` 抓得到，所以 Step 4-③ 不能省。

---

## 8. 上游重构后，修复既有规则

1. 读 CI 报错行：`::error file=src/...::[规则名] <消息>` —— 已点名**哪条规则、哪个函数、什么原因**；
2. 打开 Job Summary 的「实际生成的 diff」，确认其余规则都正常；
3. 用第 5 节 Step 2 的调试片段看一眼上游新代码，调整「从哪里取、写回什么」；
4. 重跑 Step 4 三步验证 → 提交推送。

---

## 9. 排错速查表

| 报错信息 | 原因 | 处置 |
|---|---|---|
| `could not find function X()` | 上游删了/改名了该函数 | 确认新名字或新位置，改规则里的函数名 |
| `found more than one top-level declaration of function X()` | 文件里出现两个同名函数 | 改用更精确的锚点（`findCalls` + 唯一字面量）；或按 `fn.declStart` 位置筛选 |
| `function X() no longer has a plain parameter list` | 声明被改成了箭头函数 / 带泛型等形态 | 确认上游写法，必要时改用 `findCalls` 定位 |
| `function X() has no body (declaration only)` | 变成了类型声明 | 说明该函数已不在这里实现，需要改锚点到别处 |
| `unbalanced body in function X()` | 源码不完整或解析越界 | 确认 checkout 是否完整 |
| `overlapping edits: A and B` | 一个规则里的两处编辑区间重叠 | 合并成一处编辑，或调整区间 |
| `X() has no top-level return statement to override` | 上游把返回值改成表达式体函数或提前返回 | 重新设计规则（可能需要改 `fn.bodyEnd` 前的表达式） |
| `could not find the \`plan\` property of X()'s final return statement` | return 对象结构变了 | 打开上游代码，更新属性名/正则 |
| `getSubscriptionPlan() signature changed: expected (…) but found (…)` | 工厂函数形参名序变了 | 按新的名序更新规则里的 `expected` 与调用写法 |
| `expected exactly one getSubscriptionPlan('community-with-account', ...) call … but found N` | 上游的兜底调用被删/改名/变成多个 | 换一个新的「可克隆表达式」，或改为手写 |
| `file not found: <path>` | 上游把文件挪了 | 更新规则里的 `file`，并同步 README 表格 |
| `post-apply verification failed` | `apply()` 跑了但 `isApplied()` 仍为假 | 两处的判定标准写得不一致，对齐它们 |
| `<root> is not the GitLens extension (package.json name is "…")` | `--root` 指错了目录 | 指向 GitLens 仓库根 |
| 本地 `--check` 通过、CI 失败 | 上游最新 release 比你本地沙箱新 | 按 CI 报错更新规则（这正是 CI 存在的意义） |

---

## 10. 调试技巧

**打印某个函数当前的样子**

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { buildCodeMask, findFunction } from './scripts/lib/codemod.mjs';
const src = readFileSync('.work/upstream/src/plus/gk/utils/checkin.utils.ts', 'utf8');
const fn = findFunction(src, buildCodeMask(src), 'getSubscriptionFromCheckIn');
console.log(fn.body);
"
```

**只看改动落在哪几行**：`--diff` 的结果就是 `git diff` 的输出，带行号上下文，比对着看最直观。

**验证规则幂等**：连续跑两次 `--check`，第二次应全部显示 `already applied`。CI 里已经固化这条断言。

**验证失败路径**（可选）：临时把上游某个函数改名，确认脚本以 exit 1 退出、输出 `::error file=…::`，并且**工作区不留半成品**（`git diff --stat` 应当只有你自己人为改的那一处）。
