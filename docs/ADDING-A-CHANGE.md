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
| 「改动悄悄没打上」 | ❌ 看不出来 | ✅ 哨兵标记 + 计数不变量（见 §3、§7） |
| 审计 | 读 `.patch` | `--diff` 导出**真实 diff**，写入 Job Summary |

---

## 2. 机制总览

```
build.yml（GitHub Actions）
  ├─ checkout 上游 tag (vX.Y.Z)
  ├─ checkout 本仓库 → source-repo/ (sparse-checkout: scripts)
  ├─ 把 codemod 复制到 $RUNNER_TEMP/codemod，删掉 source-repo
  ├─ node $RUNNER_TEMP/codemod/apply-patches.mjs --root . --expect-version $VERSION --assert-fresh
  │     ├─ lib/codemod.mjs   扫描原语（零依赖；注释/字符串/模板文本/正则一律屏蔽）
  │     └─ lib/rules.mjs     改动规则列表
  ├─ pnpm install
  ├─ pnpm exec oxfmt --write <codemod 报告的文件清单>
  ├─ node $RUNNER_TEMP/codemod/apply-patches.mjs --root . --diff … --assert-applied
  │     └─ 导出**格式化之后**的权威 diff，并证明格式化没有破坏任何哨兵
  ├─ pnpm package   （内部并行跑 oxlint --type-aware --type-check --deny-warnings、check-deps、l10n、fmt:check）
  └─ 计算 SHA-256 → 创建 Release → 校验资产真的挂上去了
```

`apply-patches.mjs` 的开关：

| 开关 | 作用 |
|---|---|
| `--root <dir>` | 指定上游 checkout（默认当前目录） |
| `--check` | 只校验锚点与写回逻辑，**一个字节都不写**（不能与 `--diff` 同用） |
| `--diff <file>` | 应用后把真实 unified diff 导出到文件（同时进 Job Summary） |
| `--expect-version <v>` | 校验 checkout 的版本（`v19.4.0` 与 `19.4.0` 都接受） |
| `--assert-fresh` | 断言「这次运行把每条规则都应用了」——全新 checkout 的不变量 |
| `--assert-applied` | 断言「每条规则都已应用且没有重写」——二次运行的不变量 |
| `--list-files` | 打印规则会改到的文件（每行一个），不读取上游 |

参数写错会立刻报错：`--root` / `--diff` / `--expect-version` **缺值**或以 `-` 开头、`--check` 与 `--diff` 同用、未知参数，全部 exit 1（历史上 `--root --check` 会把 `--check` 当成目录名吞掉，然后在你以为只校验的时候真的写盘）。

---

## 3. 一条规则的契约

在 `scripts/lib/rules.mjs` 的 `rules` 数组里，一条规则就是一个对象：

```js
{
	id: 'my-rule',                              // 稳定标识：出现在报错信息、Job Summary 与哨兵标记里
	file: 'src/plus/gk/utils/xxx.utils.ts',     // 相对上游仓库根
	title: '一句话说明这条规则改了什么',           // 出现在 Job Summary 的表格里

	/** 是否已应用。双重身份：① 已应用则跳过 ② 应用后自检（返回 false = 构建失败） */
	isApplied(src) { /* ... */ },

	/** 纯函数式改写：只返回新源码 + 备注，不落盘、不产生副作用 */
	apply(src) { /* ... */ },
}
```

三条硬性约定：

- **`apply()` 必须是纯函数**：只读 `src`、只返回 `{ src, notes }`。落盘由入口统一在「全部规则规划成功之后」做，写盘中途失败会回滚，不会留下半成品。
- **`isApplied()` 只认自己写下的哨兵标记**，例如 `body.includes(markerFor('my-rule'))`（`markerFor` 已经从 `rules.mjs` 导出）。**不要**用「函数体看起来像我的输出」来判定：

  ```js
  // ❌ 上游只要自然出现这个名字，规则就被判为「已应用」，构建会静默跳过这条改动
  isApplied(src) { return findFunction(src, mask, 'f').body.includes('enterprisePlan'); }
  ```

  ```js
  // ✅ 只有我们自己的标记能满足它
  isApplied(src) { return findFunction(src, mask, 'f').body.includes(markerFor('checkin-subscription-is-enterprise')); }
  ```

- **`apply()` 必须把哨兵写进被改的那个函数体**（放在注释里即可，`oxfmt` 不会动它）。哨兵同时是 `isApplied` 的判据和「这条规则真的跑过」的证据。

---

## 4. 扫描原语速查（`scripts/lib/codemod.mjs`）

所有原语都接受一个 **代码掩码** `mask = buildCodeMask(src)`：它是与源码等长的 `Uint8Array`，代码字符标 1，注释 / 字符串 / 模板字面量的**文本部分** / 正则字面量标 0。模板插值（`${…}`）里面是真实代码，会被递归标为 1，所以嵌套模板不会提前终止外层模板。因此括号统计永远不会被 `'{'` 这样的字符串噪声干扰。

| 原语 | 返回值 / 用途 |
|---|---|
| `buildCodeMask(src)` | `Uint8Array`；每个文件开头算一次，后续所有原语共用 |
| `findFunction(src, mask, name)` | `{ name, line, declStart, paramsStart, paramsEnd, params[{name,start,end}], bodyStart, bodyEnd, body }`；找不到、同名多份、形态异常都会**抛错**。会跳过返回类型注解里的 `{`（`): { a: 1 } {`、`): Promise<{ ok: boolean }> {`），也不会把 `const f = function f() {}` 这种表达式算作重复声明 |
| `matchBalanced(src, mask, i, '{', '}')` | 从 `i` 处括号找到配对括号的下标 |
| `findTopLevelReturns(src, mask, bodyStart, bodyEnd)` | 函数体**顶层**（不含嵌套块与回调里）的 `return` 起点数组 |
| `findCalls(src, mask, from, to, callee)` | 区间内所有 `callee(...)` 调用表达式，返回 `{ start, end }`（`end` 含右括号）；成员调用（`a.b(...)`，含跨行与注释隔开）不算 |
| `findObjectProperty(src, mask, objStart, objEnd, name)` | 对象字面量**顶层**同名属性的 `{ keyStart, keyEnd, valueStart, valueEnd }`（`valueEnd` 不含）；嵌套对象里的同名属性不会被误选 |
| `applyEdits(src, [{ start, end, text, source }])` | 应用编辑；**自动检测重叠**并按 `source` 报错，同起点的插入按传入顺序拼接 |
| `escapeRegExp(value)` | 把字符串安全嵌入 `new RegExp(...)` |

坐标一律是**绝对偏移**（可直接用于 `src.slice()` 与 `applyEdits`）。

> **已知限制**：`buildCodeMask` 判断「斜杠是正则还是除法」时只看前一个字符，所以 `return /}/.test(x)` 这类**关键字后紧跟正则字面量**的写法会被当成除法，掩码里正则的 `}` 会污染后续括号配对。当前 4 条规则不涉及这种写法。这个判定点留了一个 `TODO(human)`（`scripts/lib/codemod.mjs` 的 `startsRegexLiteral`），对应的用例在 `scripts/__tests__/codemod.test.mjs` 里处于 `skip` 状态，实现后把它打开即可。

---

## 5. 新增一条改动：完整流程

### Step 0 · 先问「这改动必须动源码吗？」

优先顺序：上游配置项 → 环境变量 → 扩展设置 → **最后**才是改源码。每加一条规则就多一处上游耦合面。

### Step 1 · 准备上游沙箱（并用之前先复位）

```bash
cd /path/to/Rebuild-gitlens
git clone --depth 1 --branch v19.4.0 \
  https://github.com/gitkraken/vscode-gitlens.git .work/upstream

# 需要类型检查 / lint 时再装依赖（有缓存时约 20s）
(cd .work/upstream && pnpm install)
```

> ⚠️ **每次验证前先复位**：沙箱一旦被 rules 改过，`--check` 会全部报 `already applied`，而 §10 的调试片段打印的会是**我们自己注入的代码**而不是上游原貌：
>
> ```bash
> git -C .work/upstream checkout -- .
> git -C .work/upstream status --porcelain   # 应当为空
> ```
>
> 这条纪律很重要：`apply-patches.mjs` 对脏 checkout 只会**警告**（因为规则是整段替换函数体，会静默抹掉你的人工编辑），不会替你拦住。

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

### Step 4 · 本地验证（五步）

```bash
cd /path/to/Rebuild-gitlens

# ① 只读校验：所有锚点都能找到吗（不写任何文件）
node scripts/apply-patches.mjs --root .work/upstream --check

# ② 实际应用 + 导出 diff，人眼核对「改的是不是你要的」
node scripts/apply-patches.mjs --root .work/upstream --expect-version v19.4.0 --diff .work/applied.diff
cat .work/applied.diff

# ③ 幂等：二次运行必须一条都不改
node scripts/apply-patches.mjs --root .work/upstream --check --assert-applied

# ④ 真实门禁：上游构建跑的就是 oxlint 的类型感知检查（不是 tsc），外加格式检查
(cd .work/upstream && pnpm exec oxlint --type-aware --type-check --deny-warnings \
    src/plus/gk/utils/subscription.utils.ts src/plus/gk/utils/checkin.utils.ts)
(cd .work/upstream && pnpm exec oxfmt --check \
    src/plus/gk/utils/subscription.utils.ts src/plus/gk/utils/checkin.utils.ts)

# ⑤ 单测：扫描原语 / 规则锚点与哨兵 / CLI 计数不变量 / 文档代码块
node --test scripts/__tests__/*.test.mjs
```

两个容易误判的点：

- **`oxlint` 干净时什么都不打印**（退出码 0 才是结论）。想看它确实在工作，随便造一个未使用变量跑一次即可。
- **`oxlint --type-aware --type-check` 才是权威门禁**（`pnpm package` 内部并行跑它 + `check-deps` + l10n + `fmt:check`；webpack 用的 esbuild-loader 只转译、**不做类型检查**）。文档早期版本让你跑 `tsc`，那只覆盖类型、不覆盖上游那些自定义 lint 规则（`one-var`、`require-block-body`、l10n 字面量……），会出现「本地过了、构建挂」。

### Step 5 · 提交并观察 CI

```bash
git add scripts/
git commit -m "feat(rules): 新增 xxx 改动"
git push

gh run watch $(gh run list -R aliveranme/Rebuild-gitlens -L1 --json databaseId -q '.[0].databaseId')
```

`ci.yml`（Local Modification Validation）会跑两个 job：

1. **Codemod Unit Tests** —— `node --test scripts/__tests__/*.test.mjs`，零依赖、不需要网络；
2. **Validate Modifications Against Upstream** —— 对一个**全新的最新上游 release**：
   - 应用全部规则，并且用 `--assert-fresh` 断言**这一轮把 4 条都应用了**（任何一条被误判为「已应用」都会红）；
   - 再跑一次 `--assert-applied` 断言幂等。

`ci.yml` 还有一个每天 12:00 UTC 的定时跑，让上游漂移在发布构建之前就暴露出来。

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
import { applyEdits, buildCodeMask, findCalls, findFunction, findObjectProperty, findTopLevelReturns, matchBalanced } from './codemod.mjs';
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
		return findFunction(src, mask, 'myFunction').body.includes(markerFor('my-rule'));
	},
	apply(src) {
		const mask = buildCodeMask(src);
		const fn = findFunction(src, mask, 'myFunction');

		return {
			src: applyEdits(src, [
				{
					start: fn.bodyStart + 1,   // 左花括号之后
					end: fn.bodyEnd,           // 右花括号之前（end 不含）
					text: `\n\treturn true; ${markerFor('my-rule')}\n`,
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

### 形态 B —— 只改函数内的一处（定位对象属性 / 克隆上游自己的表达式）

参考现有规则 `checkin-subscription-is-enterprise` 的骨架。**不要**再把新声明插到某个 `return` 所在行首 —— 上游一旦把 `return` 写成 `} else return {`，那个位置插进去就是语法错误：

```js
apply(src) {
	const mask = buildCodeMask(src);
	const fn = findFunction(src, mask, 'funcName');

	// 1) 找到函数体里最后一个顶层 return 交出的对象字面量
	const returns = findTopLevelReturns(src, mask, fn.bodyStart, fn.bodyEnd);
	if (returns.length === 0) throw new Error(`${fn.name}() has no top-level return statement to override`);
	const objectStart = src.indexOf('{', returns[returns.length - 1]);
	const objectEnd = matchBalanced(src, mask, objectStart, '{', '}');
	if (objectEnd === -1) throw new Error(`could not find the object ${fn.name}() hands back`);

	// 2) 只认这个对象的**顶层**属性（嵌套对象里的同名属性不会被误选）
	const plan = findObjectProperty(src, mask, objectStart, objectEnd, 'plan');
	if (plan == null) throw new Error(`could not find a top-level \`plan\` property in ${fn.name}()`);

	// 3) 克隆上游自己的等价表达式，只改我们要改的那一处
	const [call] = findCalls(src, mask, fn.bodyStart, fn.bodyEnd, 'getSubscriptionPlan');
	if (call == null) throw new Error(`could not find a getSubscriptionPlan(...) call to clone in ${fn.name}()`);
	const cloned = src.slice(call.start, call.end + 1).replace("'community'", "'enterprise'");

	return {
		src: applyEdits(src, [
			{
				start: plan.valueStart,
				end: plan.valueEnd,
				text: `{\n\t\t${markerFor('my-rule')}\n\t\tactual: ${cloned},\n\t\teffective: ${cloned},\n\t}`,
				source: `${fn.name}() plan property`,
			},
		]),
		notes: [`line ${fn.line}: ${fn.name}() plan -> enterprise`],
	};
},
```

**克隆优于手写**：需要的表达式上游本来就有一份时，用 `findCalls()` 找到它、`.slice()` 出原文、只替换关键的字符串字面量再写回去。这样上游增删参数、改字段名、改读哪个字段，我们的代码自动跟随，永远编译得过 —— 规则 3 与规则 4 都是这么做的。

**缩进**：克隆来的多行表达式要按新位置重新缩进（见 `rules.mjs` 里的 `reindentTo`），否则虽然 `oxfmt` 会在构建里修好，但本地 diff 会很难看。

---

## 7. 五条铁律（都是踩过的坑）

1. **锚点只用结构**：函数名、形参名序、唯一字面量调用。**绝不用行号**。
2. **能克隆上游自己的表达式就克隆**，不要手写字面参数列表。
3. **`isApplied()` 只认自己写下的哨兵标记**，绝不用「函数体里出现某个标识符/子串」来判定 —— 上游恰好同名就会让这条改动**静默消失**，而构建一路绿灯。改写后的函数体里必须带上哨兵。
4. **不要在闭包读过某个 `let` 之后再给它赋值** —— 会破坏 TypeScript 的收窄，类型检查直接报错。

   实例：规则 4 第一版写成「在 return 前 `effective = enterprisePlan;`」，因为函数体前面有个箭头函数读 `effective`，TS 立即失去收窄并在 `effective.organizationId` 上报错。正确做法是**重写 return 里的 `plan` 属性**，不动任何 `let`。
5. **不要在规则里新增面向用户的 l10n 字符串**：上游构建会跑 `localization.mjs check`，新增文案没有进语言目录会让构建失败。

---

## 8. 上游重构后，修复既有规则

1. 读 CI 报错行：`::error file=src/…::[规则名] <消息>` —— 已点名**哪条规则、哪个函数、什么原因**；
2. 打开 Job Summary 的「实际生成的 diff」，确认其余规则都正常；
3. 用第 5 节 Step 2 的调试片段看一眼上游新代码，调整「从哪里取、写回什么」（别忘了先复位沙箱）；
4. 重跑 Step 4 五步验证 → 提交推送。

失败路径上的一个诚实说明：`apply-patches.mjs` 在有规则失败时**提前返回**，不会写 Job Summary 的 diff —— 那时请直接看 `::error::` 注解，或在本地对复位后的沙箱重跑。

---

## 9. 排错速查表

| 报错信息 | 原因 | 处置 |
|---|---|---|
| `could not find function X()` | 上游删了/改名了该函数，或它变成了函数表达式 | 确认新名字或新位置，改规则里的函数名 |
| `found more than one top-level declaration of function X()` | 文件里出现两个真正的同名声明 | 改用更精确的锚点（`findCalls` + 唯一字面量）；或按 `fn.declStart` 位置筛选 |
| `function X() no longer has a plain parameter list` | 声明被改成了箭头函数 / 带泛型等形态 | 确认上游写法，必要时改用 `findCalls` 定位 |
| `function X() has no body (declaration only)` | 变成了类型声明 | 说明该函数已不在这里实现，需要改锚点到别处 |
| `unbalanced body in function X()` | 源码不完整或解析越界 | 确认 checkout 是否完整 |
| `overlapping edits: A and B` | 一个规则里的两处编辑区间重叠 | 合并成一处编辑，或调整区间 |
| `X() has no top-level return statement to override` | 上游把返回值改成表达式体函数或提前返回 | 重新设计规则 |
| `the final return of X() no longer hands back an object literal to rewrite` | 返回值不是对象字面量（可能是变量） | 先确认上游新写法，再决定改写哪一段 |
| `could not find a top-level \`plan\` property in the object X()'s final return hands back` | 属性改名，或只剩简写属性（`plan,`） | 更新属性名；简写属性要先在规则里展开 |
| `found no getSubscriptionPlan('community', ...) call to clone inside X` | 可克隆的锚点被删/改名 | 换一个「可克隆表达式」，或改为手写（并接受耦合） |
| `file not found: <path>` | 上游把文件挪了 | 更新规则里的 `file`，并同步 README 表格 |
| `post-apply verification failed` | `apply()` 跑了但 `isApplied()` 仍为假 | 两处的判定标准写得不一致，对齐它们（通常是漏了哨兵） |
| `a fresh checkout must have every rule applied by this run, but N of M were applied and K were reported as already in place` | 有规则把**上游代码**误判成自己的输出，于是被静默跳过 | 检查该规则的 `isApplied()` 是否只认哨兵（§3、§7 铁律 3） |
| `should already carry every local modification, but N were rewritten again` | 二次运行时仍有规则改写文件（幂等性被破坏） | 检查 `apply()` 的输出是否稳定，以及哨兵是否真的写进了被改函数体 |
| `no rules are registered — every run would report success` | `rules` 数组空了 | 别删规则；这条断言是为了让「0 条规则的绿色构建」不可能发生 |
| `duplicate rule id` | 两条规则用了同一个 `id` | 改成唯一 id（哨兵标记依赖它） |
| `--root requires a value` / `--check never writes, so --diff has nothing to export` | 参数写错 | 按提示改；这类错误以前是**静默**的，现在必须显式修正 |
| `expected GitLens 19.4.0 but <dir> holds 19.3.0` | `--expect-version` 与 checkout 不符 | 换正确的沙箱/版本，或去掉该开关 |
| `checkout is not clean for the files the rules touch`（警告） | 沙箱里已有改动/人工编辑 | 先 `git -C <dir> checkout -- .` 复位；规则会整段替换函数体，抹掉的东西不会出现在 diff 里 |
| `<root> is not the GitLens extension (package.json name is "…")` | `--root` 指错了目录 | 指向 GitLens 仓库根 |
| 本地 `--check` 通过、CI 失败 | 上游最新 release 比你本地沙箱新 | 按 CI 报错更新规则（这正是 CI 存在的意义） |
| 构建红在 `pnpm package` 的 `fmt:check` / `oxlint` 上 | 生成的代码没过格式化或类型感知检查 | 本地跑 §5 Step 4-④ 的两条命令 |

---

## 10. 调试技巧

**打印某个函数当前的样子**（跑之前先复位沙箱，否则打印的是我们自己的补丁）

```bash
git -C .work/upstream checkout -- .
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { buildCodeMask, findFunction } from './scripts/lib/codemod.mjs';
const src = readFileSync('.work/upstream/src/plus/gk/utils/checkin.utils.ts', 'utf8');
const fn = findFunction(src, buildCodeMask(src), 'getSubscriptionFromCheckIn');
console.log(fn.body);
"
```

**只看改动落在哪几行**：`--diff` 的结果就是 `git diff HEAD` 的输出，带行号上下文，比对着看最直观。

**验证幂等**：先 `apply`（写盘），再 `--check --assert-applied` —— 第二次必须报 `0 modified, 4 already applied` 并以退出码 0 结束。

**验证失败路径**（可选）：临时把上游某个函数改名，确认脚本以 exit 1 退出、输出 `::error file=…::`、并**在干净的 checkout 上不留半成品**（`git status --porcelain` 应当只有你自己人为改的那一处）。

**跑测试**：

```bash
node --test scripts/__tests__/*.test.mjs
```

测试用的是 `scripts/__tests__/fixtures/upstreamSources.mjs` 里那两份**微缩版**上游文件（同名函数、同样的嵌套与锚点）。上游重构了目标函数时，**夹具和规则要一起改** —— 这样夹具本身也成了一道「上游长什么样」的备忘。

---

## 11. 重新发布与回滚（runbook）

**触发条件**：某个版本发布的是坏产物（少打了一条补丁、改错了位置、资产没传上去）。判断依据看 Job Summary 里的「实际生成的 diff」与 `--assert-*` 断言。

**为什么必须手动**：工作流遇到本仓库已存在的同名 tag 会**整体跳过**（`resolve` job 直接判 `exists=true`），所以坏版本不会因为重跑而自愈。

```bash
# 1) 删掉 Release 与 tag（--cleanup-tag 会一并删除远端 tag）
gh release delete v19.4.0 -R aliveranme/Rebuild-gitlens --cleanup-tag --yes

# 2) 重新触发该版本的构建
gh workflow run "Fix gitlens and build" -R aliveranme/Rebuild-gitlens -f version=v19.4.0
```

**注意事项**

- 重发前后的**文件名与版本号完全相同**，只有 `.sha256` 内容不同 —— 已下载的用户无法从版本号分辨，必要时在 Release 说明里注明，或直接在本地校验：

  ```bash
  sha256sum -c gitlens-19.4.0.vsix.sha256
  ```

- 构建日志会随归档过期，Job Summary 里的 diff 才是长期可查的证据；如果某次改动很关键，把 diff 存进 Issue/PR 里。
- 想确认某个已发布版本到底由哪版规则构建：tag 只近似等于当时的 `main`（两个版本可能共享同一个提交），**唯一精确来源是那次运行的构建日志**。

---

## 12. 测试都在测什么

`scripts/__tests__/` 零依赖，用 Node 内置的 `node:test`：

| 文件 | 覆盖 |
|---|---|
| `codemod.test.mjs` | 掩码（注释/字符串/模板/正则/嵌套模板/插值）、括号配对、按名找函数（含返回类型里的花括号、命名函数表达式、重复声明）、顶层 `return`、调用表达式、对象顶层属性、`applyEdits` 的相邻与重叠语义 |
| `rules.test.mjs` | 每条规则「应用后 isApplied 为真」且留下哨兵、**上游同名代码不会被误判为已应用**、`plan` 属性只改顶层那一个、`} else return {` 布局、克隆锚点缺失时报错可读 |
| `applyPatchesCli.test.mjs` | 参数校验、`--expect-version`、`--assert-fresh` / `--assert-applied` 两个不变量、`--check` 不写盘、`--diff` 导出真实改动（含 `git add` 之后）、锚点失败时不留半成品 |
| `docBlocks.test.mjs` | 本文档里每个 ```js 代码块都能被解析 —— 免得模板里的笔误被复制进规则 |

新增一条规则时，请顺手在 `rules.test.mjs` 里补一条「上游同名代码不会被误判」的用例（照抄现有写法即可）。
