# weir

给 LLM 聊天界面用的流式文字渲染。约 215 行代码，零依赖，MIT。

[English →](README.md)

做两件事，多半你两件都需要：

1. **把节奏接管过来。** delta 只进缓冲，由 `requestAnimationFrame` 每帧按积压量算出的速率吐字。120Hz 的屏幕上是每秒 120 次匀速小步，而不是八次大跳。
2. **只写还在生长的那一小块。** 被空行封口的段落此后一个字节都不会再被碰。

外加一件可选的：**逐字淡入**——每帧新出的字是浮上来的，而不是啪地贴上去。

```
git clone <本仓库> && cd weir
npm test                 # 63 项断言，纯 node，无开发依赖
open demo/index.html     # 和朴素写法并排对比（浏览器若拦 file://，起个静态服务器即可）
```

demo 用同一串 delta 依次跑三块：朴素写法、`weir-lite`、带淡入的 `weir`，各自记帧率。请在**可见的标签页**里跑，原因见[两个一定会踩的坑](#两个一定会踩的坑)。

---

## 问题

渲染 token 流最常见的写法是这两种之一：

```js
socket.onmessage = (e) => {
  full += JSON.parse(e.data).text;
  el.textContent = full;            // A
  // 或者
  el.textContent += chunk;          // B
  el.scrollTop = el.scrollHeight;
};
```

两句话的回答里它们都挺好，回复越长越难看。原因有三个，而且很容易被当成同一个。

### 一、写 DOM 的节奏就是网络到货的节奏

即使是 token 级的流，到货也不均匀：几个 token 会被合进同一个 WebSocket 帧或同一次 SSE flush，事件循环再合一次，到达间隔本身就抖着几十毫秒。每个 delta 直接写屏，意味着文字完全按网络交付的样子在动——于是你看的是抖动，不是文字。

这一条在性能面板里是隐形的。帧率可以稳稳 120fps，字看起来照样一顿一顿，因为顿在**字什么时候出现**，不在浏览器画得多快。

### 二、每一次写入都在为已经定稿的部分付账

`el.textContent = full` 会销毁原来的文本节点、重建一个新的。浏览器为整条消息算好的断行、字形位置、行盒，全部作废重来。

`el.textContent += chunk` 不会更好：读出整串、拼接、再赋值回去——同样的销毁，同样的重建。

代价随着屏幕上已有的文字增长，所以最贵的时刻恰好是你最不希望它贵的时刻。一条长回复写到一半，此后每一个 delta 都在为「永远不会再变的前半段」重新排版。

### 三、每个 delta 逼一次同步布局

```js
const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;  // 读
el.textContent = full;                                                   // 写
if (atBottom) el.scrollTop = el.scrollHeight;                            // 读 + 写
```

写完之后再读 `scrollHeight`，浏览器必须当场把布局算完才能回答你。一秒钟几十次读—写—读交替，是教科书级的 layout thrashing。

---

## 解法

### 第一步：把节奏从网络手里拿回来

delta 只进缓冲。rAF 循环决定这一帧吐几个字：

```js
const CATCHUP = 0.30;      // 流进行中：0.3 秒内追平当前积压
const CATCHUP_END = 0.09;  // end() 之后：收尾快一些
const MIN_CPS = 8;
const MAX_CPS = 1400;

const backlog = text.length - shown;
const cps = clamp(backlog / (ended ? CATCHUP_END : CATCHUP), MIN_CPS, MAX_CPS);
credit += cps * dt;                       // dt = 距上一帧的秒数
const n = Math.min(Math.floor(credit), backlog);
credit -= n;
```

速率与积压成正比，于是想要的行为是白送的：模型说得快就吐得快，说完了自然收尾，中间保持匀速。`credit` 攒着不满一个字的余数，慢速流才不会每帧四舍五入成零、一个字都不动。

`CATCHUP` 是唯一值得想一想的数字。它不只是个平滑常数——它**就是**显示允许落后网络多久。0.3 秒意味着缓冲里始终躺着约三分之一秒的文字当减震器，足够吃掉一整帧的网络抖动，又短到没人察觉得出延迟。再小抖动就穿过来了，再大文字会显得慢半拍。

缓冲空了循环就停，下一次 `push` 再起——闲着的流不花一分钱。

### 第二步：只碰还在变化的部分

握住当前正在追加的那个文本节点，往它上面追加：

```js
tail.appendData(slice);     // 不销毁，不重建
```

`CharacterData.appendData` 是 DOM 真正提供的「增量」。浏览器知道文字只在末尾加了一点，能复用绝大部分已经算好的东西。

然后按空行分段。一段结束就把引用丢掉：

```js
if (blankLineHere) { block = null; tail = null; }   // 封口——此后再也不写它
```

下一次写入会新建一个 `<p>` 和一个新文本节点。它上面的所有段落从此惰性：不再被写、不再失效，排版结果一直留到流结束。

这里有个褶子。吐字是逐字的，所以 `\n\n` 可能被切在两帧之间——你吐出了 `…文字\n`，要到下一帧才知道后面跟的是另一个换行（段落分隔）还是一个字（段内换行）。所以末尾的换行要扣下一帧再决定：

```js
const m = /\n+$/.exec(t);
if (m) { hold = m[0]; t = t.slice(0, -m[0].length); }   // 下一帧再判
```

漏掉这一步，段落分隔就会随着网络切在哪里而时有时无——大概二十次里复现一次的那种 bug。

### 第三步：一帧最多滚一次

把「是不是在底部」这个判断挪进 `scroll` 监听里——那个时刻没有待处理的写入，读几何是免费的：

```js
let stick = true;
el.addEventListener("scroll", () => {
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}, { passive: true });

// 在 flow 的 onGrow 里，一帧至多一次：
if (stick) el.scrollTop = el.scrollHeight;
```

一秒几十次强制布局，变成一帧最多一次。

### 第四步（可选）：淡入

每帧新出的字进自己的 span：

```js
const w = doc.createElement("span");
w.className = "weir-wet";
w.appendChild(doc.createTextNode(slice));
block.appendChild(w);
```

```css
@keyframes weir-wet { from { opacity: 0 } to { opacity: 1 } }
.weir-wet { animation: weir-wet 300ms ease-out both; }

@media (prefers-reduced-motion: reduce) { .weir-wet { animation: none; } }
```

**一帧一个 span，不是一个字一个。** 高刷屏上一帧就是两三个字，眼睛看到的本来就是连续的浮现；而一个字一个 span 意味着成千个节点、成千个并发动画，换不来任何可见的收益。

四个要紧的细节：

- **只动 `opacity`。** 位移会改变 span 的布局盒，整行会跟着重排抖一下。
- **fill-mode 用 `both`。** 不加的话，动画开始前有一帧 span 是按满不透明度画的——每一帧都闪一下。
- **追加 span 依然不碰已封口的段落。** 前面的性能成果全部保留，区别只是每帧从一次 `appendData` 变成一次 append 节点。
- **流结束时摊平。** 全部到齐之后，把每段的内容换成纯文本：

  ```js
  for (const b of blocks) b.textContent = b.textContent;
  ```

  代价是一次段级重排，发生在没人看着的时刻。它要紧是因为：如果你把读完的 `innerHTML` 缓存起来、之后再贴回去（恢复视图、重开面板），**带着动画 class 的标签会把整段动画重播一遍**，看着像抽搐。顺带也让 DOM 回到每段一个文本节点的最简形态。

补齐帧（从后台切回来的那一下）刻意不淡入——几百个字一起亮起来是闪，不是浮现。

---

## 两个版本

| | `src/weir-lite.js` | `src/weir.js` |
|---|---|---|
| rAF 匀速 | ✔ | ✔ |
| 只追加不重建 | ✔ | ✔ |
| 段落封口 | ✔ | ✔ |
| 后台标签页处理 | ✔ | ✔ |
| 逐字淡入 | — | ✔（`fade: true`） |
| 代码行数（不含注释） | 约 190 | 约 215 |

两个都是独立文件，取一个即可，不要都拿。有 `lite` 是因为淡入确实是可选的，而且如果你打算读懂之后自己改写，短一点的那份更好读。性能收益全部来自节奏和 DOM 写法，这两块两版完全一致。

两版暴露同名的全局变量（`window.Weir`）和同样的 CommonJS 导出，可以互相直接替换。

---

## 接线

```html
<script src="src/weir.js"></script>
```

```js
const flow = Weir.open(container, {
  block: "p",            // 段落标签；null = 不分段，整条一个文本节点
  blockClass: "msg-p",   // 每个段落的 class
  fade: true,            // 仅完整版
  onGrow: () => { if (stick) container.scrollTop = container.scrollHeight; },
});

socket.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "delta") flow.push(m.text);
  if (m.type === "done") {
    flow.end().then(() => {
      // DOM 到这一刻才完整。「这条说完了」要做的事都放这里——
      // markdown 渲染、代码高亮、时间戳、操作按钮。
    });
  }
};
```

**`end()` 返回 Promise，你必须等它。** `done` 往往比最后几十个字先到，抢在前面重绘会把缓冲里没吐完的字一口气蹦出来，前面的功夫全白费。这是接线时最容易错的一处。

如果你的数据源是 async iterable，`pipe` 把整个循环包好了：

```js
await Weir.pipe(container, streamOfChunks, {
  block: "p",
  fade: true,
  firstChunkTimeout: 30000,   // 超时抛 Error("silence")
});
// DOM 完整之后才 resolve
```

上游抛错时，`pipe` 会先让已经收到的字自然吐完再把错误抛出去——免得错误提示抢在半句话前面冒出来。

### API

| | |
|---|---|
| `Weir.open(host, opts)` | 建一条流 |
| `Weir.pipe(host, asyncIterable, opts)` | 建一条并喂到底 |
| `flow.push(text)` | 喂一段 delta |
| `flow.end()` | → `Promise`，DOM 完整时 resolve |
| `flow.flush()` | 立刻写完剩余并收口（拆容器、切视图时用） |
| `flow.cancel()` | 丢弃剩余并停止；会 resolve `drained`，不会让 await 挂死 |
| `flow.text` | 已收到的全文（含没吐出来的） |
| `flow.shown` | 已经写进 DOM 的字数 |
| `flow.drained` | 与 `end()` 返回的是同一个 Promise |

选项：`block`（默认 `"p"`）、`blockClass`、`onGrow`、`fade`、`fadeClass`（默认 `"weir-wet"`）、`firstChunkTimeout`（仅 pipe）、`doc`。

`flush()` 和 `cancel()` 不可互换。`flush` 的意思是**到此为止**——它会收口，之后再来的 delta 一律丢弃，用在你确实不再需要这条流的时候。`cancel` 的意思是**剩下的不要了**，用在容器马上就要被移除的场合。

---

## 三个一定会踩的坑

三个都是在真浏览器里跑出来的，不是推理出来的。它们是同一个形状：`requestAnimationFrame` 没有看上去那么可靠，而且每一个都在健康的 60fps 桌面标签页里完全隐形。

### 一、吐字速度悄悄跟着帧率走，而不是跟着时间走

缓冲空了循环就停，下一次 `push` 再起。重启时最顺手的写法是把时间戳清零，让下一帧把自己当成第一帧：

```js
last = 0;
// ……帧里：
const dt = last ? (ts - last) / 1000 : 1 / 60;   // ← 错的
```

稳稳 60fps 时这个兜底值恰好是对的，这正是它藏得住的原因。但慢速流几乎每个 delta 之间都会把缓冲吐空，于是**大多数**帧都走这个分支，每一帧都按固定的 1/60 秒计费，不管真实过了多久。实际速率变成：

```
实际帧率 ÷ 60 × 目标速率
```

掉到 10fps，字就只剩六分之一的速度。更糟的是 `dt` 永远够不到补齐阈值，「刚才在后台，直接补上」这条兜底路径也永远不会触发。在一个被节流到约 1fps 的 webview 里实测：**五秒吐出五个字**。

改法是重启时记一个真实时间戳，而且要和 rAF 用同一个时钟：

```js
last = performance.now();          // 与 rAF 时间戳同一时基
// ……帧里：
const dt = Math.max(0, ts - last) / 1000;
```

回归线：1fps 下，六秒也必须把该吐的全部吐完。

### 二、标签页切到后台，流会冻住——而且 `end()` 一直悬着

浏览器在后台标签页里不是**节流** `requestAnimationFrame`，是**停掉**。实测两秒才一帧，还是因为截图动作强制了一次合成。

只看文字的话这也许无所谓——反正没人在看。真正的损伤在下游：`end()` 永远不 resolve，你排在它后面的一切都不会发生。消息停在半截，「说完之后要做的事」（重绘、恢复输入框、挂操作按钮）一件都不发生，一直卡到用户切回来为止。

所以隐藏期间跳过演出，直写：

```js
const hidden = () => document.visibilityState === "hidden";

push(t) {
  this.text += t;
  if (hidden()) this._catchUp();    // 立刻落地
  else this._kick();                // 正常的匀速路径
}
```

再配一个 `visibilitychange` 监听，接住切走那一刻正演到一半的流。

坑里还有一个坑：`_catchUp` **不是** `flush`。`flush` 会收口，用在这里等于把后台期间到达的每一个 delta 都悄悄丢掉——而那通常是大多数。它必须是「立刻全部落地，但不封口」。

---

### 三、「可见」并不保证 rAF 真的会跑

上面两条都还假设帧最终会来。有些环境直接推翻这个前提：不在合成的内嵌 webview 可以一边报告 `visibilityState: "visible"`，一边一次 rAF 回调都不执行。在某个这样的面板里实测：朴素写法照常渲染，而 weir **一个字都没吐出来**——比什么都不做还糟。

所以光有可见性判断不够。循环启动时上一个定时器，第一帧要是没来，就退回直写：

```js
this._schedule();
if (!this._guard) {
  this._guard = setTimeout(() => { this._guard = 0; this._catchUp(); }, 250);
}
// ……帧回调里：
this._clearGuard();     // 帧来了，说明这个环境动画正常
```

每次重新起拍一个定时器，被第一帧清掉。正常浏览器里它永远不会触发；真触发的地方，文字从「永远不出现」退化成「每 250ms 批量出现一次」——这正是兜底该做的事。

## 调参

在两份源码任意一份的顶部：

| | 默认 | |
|---|---|---|
| `CATCHUP` | `0.30` | 显示允许落后多少秒。调小更跟手，抖动也更容易穿过来 |
| `CATCHUP_END` | `0.09` | `end()` 之后的追平窗口，防止尾巴拖着 |
| `MIN_CPS` | `8` | 地板，免得最后一两个字被指数逼近卡住 |
| `MAX_CPS` | `1400` | 天花板，一大段涌进来时也仍然「在流」而不是瞬移 |
| `JUMP_DT` | `0.35` | 一帧超过这么久就补齐，不补演 |
| `FADE_MAX` | `48` | 一帧超过这么多字就不淡入 |

淡入时长在你的 CSS 里（`@keyframes weir-wet`），不在 JS 里。300ms 是个稳妥的默认值；低于约 150ms 就不像淡入了，高于约 500ms 会觉得字是隔着雾过来的。

如果渲染的是中日韩文字，注意 `CATCHUP` 的单位是秒而速率的单位是字——同样的设置下，单字信息量更大的语言会显得更慢。那边从 `0.22` 起调更合适。

---

## 测试

```
npm test          # 或者：node test/weir.test.js
```

63 项断言，**两个版本都跑**，用假 DOM 和手摇的 rAF 时钟——纯 node，不开浏览器，无依赖。盯的都是那些会无声坏掉的东西：

- 一个字都不能少：包括同一段文本的 60 种不同切法，以及 `\n\n` 跨在两个 chunk 之间的情况
- 封口的段落不再接受任何写入
- 一大段必须摊到多帧，而不是一次倾泻
- 吐字速度跟真实时间走而不是跟帧率走（坑一的回归线）
- 隐藏的标签页直写，且 `end()` 立刻 resolve（坑二的回归线）
- rAF 完全不触发时文字照样落地（坑三的回归线）
- 淡入收尾要摊平回每段一个文本节点，不留 span

手摇时钟是这套测试能成立的关键：`step(1000)` 精确、确定地模拟出 1fps 的环境，耗时不到一微秒。

---

## 关于名字

堰是横在河上的低坝。它存在的全部理由，就是把湍急不均的来水变成平稳的溢流——「量水堰」这种东西之所以存在，正是为了把不规则的水变成可读的稳定流量。这和 `CATCHUP` 是同一个物理：蓄住一点，上游的脉动就不再传到下游。

从这个形状里还能读出两件事。

堰要工作，必须让上游水位高于下游。**它必须先落后，才能平稳**——那 0.3 秒买的正是这个。

以及，堰不是坝。坝的职责是把水拦住，堰的职责是让水继续走，只是走得均匀。这个区别，恰好就是这个库和「把整条响应缓存起来、最后一次性显示」的区别。都江堰用的也是这套逻辑：不筑高坝拦断，而是分水、导流、顺势而为。

## 许可

MIT。
