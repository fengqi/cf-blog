/**
 * 渲染维护页 —— 全站渲染（阶段一）与增量渲染（阶段二）拆成两个独立操作。
 *
 * 全站渲染：无条件重写全部 R2 对象（模板/样式/设置变更后用），不看脏标记。
 * 增量渲染：只处理 needs_sync = 1 的队列，与 Cron 的对账完全同一套逻辑 ——
 *   Cron 是每小时的自动版，这里是手动立即版。
 *
 * 两个操作互相独立、可分别重跑：都有幂等性（写成功的对象重写一遍结果不变），
 * 失败后直接再点一次即可。
 */

import { AdminLayout } from './layout';

/**
 * ⚠️ 内联脚本必须走 dangerouslySetInnerHTML：Hono JSX 会把字符串子节点转义，
 * `'` 变 `&#39;`，而 <script> 是 raw text 元素、浏览器不还原实体 → 语法错误。
 * （与 layout.tsx 的 STYLE 同一个坑。）SCRIPT 是本文件写死的常量，无用户内容。
 */
const SCRIPT = `
document.addEventListener('DOMContentLoaded', function () {
  function post(path, params) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      credentials: 'same-origin',
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }
  // runner：把「循环调端点直到 done、实时显示进度、失败可重跑」包起来。
  // step 由调用方的工厂函数创建（闭包持有批次进度），每次调用返回
  // { done: 是否结束, label: 进度文案, failed: 失败 key 数组 }。
  function runner(buttonId, progressId, makeStep) {
    var button = document.getElementById(buttonId);
    var progress = document.getElementById(progressId);
    button.addEventListener('click', function () {
      button.disabled = true;
      var step = makeStep();
      var failed = [];
      function run() {
        return step().then(function (report) {
          failed = failed.concat(report.failed || []);
          progress.textContent = report.label;
          return report.done ? null : run();
        });
      }
      run()
        .then(function () {
          progress.textContent = '完成' + (failed.length > 0 ? '，失败 ' + failed.length + ' 个（可重跑）' : '');
          button.disabled = false;
          refreshDirtyCount();
        })
        .catch(function (error) {
          progress.textContent = '失败：' + error.message + '（可重跑）';
          button.disabled = false;
        });
    });
  }

  function refreshDirtyCount() {
    var counter = document.getElementById('dirty-count');
    if (!counter) return;
    fetch('/admin/render', { credentials: 'same-origin' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var match = html.match(/id="dirty-count">([0-9]+)</);
        if (match) counter.textContent = match[1];
      });
  }

  // 阶段一：/admin/rebuild/full 按批往前走，直到 nextOffset = null
  runner('full-start', 'full-progress', function () {
    var offset = 0;
    var written = 0;
    return function () {
      return post('/admin/rebuild/full', { offset: String(offset), limit: '50' }).then(function (report) {
        offset = report.nextOffset === null ? 0 : report.nextOffset;
        written += report.written;
        return {
          done: report.nextOffset === null,
          label: '全站渲染中… ' + written + ' / ' + report.total,
          failed: report.failed || [],
        };
      });
    };
  });

  // 分组独立渲染：同一端点带 group 参数，一次渲染一类对象
  var groupButtons = Array.prototype.slice.call(document.querySelectorAll('.group-buttons [data-group]'));
  var groupProgress = document.getElementById('group-progress');
  groupButtons.forEach(function (groupButton) {
    groupButton.addEventListener('click', function () {
      var group = groupButton.getAttribute('data-group');
      var name = groupButton.textContent;
      groupButtons.forEach(function (b) { b.disabled = true; });
      var offset = 0;
      var written = 0;
      function run() {
        return post('/admin/rebuild/full', { offset: String(offset), limit: '50', group: group }).then(function (report) {
          offset = report.nextOffset === null ? 0 : report.nextOffset;
          written += report.written;
          groupProgress.textContent = '渲染' + name + '中… ' + written + ' / ' + report.total;
          if (report.nextOffset !== null) return run();
        });
      }
      run()
        .then(function () {
          groupProgress.textContent = name + '渲染完成：' + written + ' 个对象';
          groupButtons.forEach(function (b) { b.disabled = false; });
        })
        .catch(function (error) {
          groupProgress.textContent = name + '渲染失败：' + error.message + '（可重跑）';
          groupButtons.forEach(function (b) { b.disabled = false; });
        });
    });
  });

  // 阶段二：/admin/rebuild/batch 每轮磨 20 篇，直到 needsSync = 0
  runner('drain-start', 'drain-progress', function () {
    return function () {
      return post('/admin/rebuild/batch', { limit: '20' }).then(function (report) {
        var done = !(report.needsSync > 0);
        return {
          done: done,
          label: done
            ? '队列已清零（本轮写 ' + report.objects + ' 个对象）'
            : '增量渲染中… 剩余 ' + report.needsSync + ' 篇',
          failed: report.failed || [],
        };
      });
    };
  });
});
`;

export interface RenderPageProps {
	needsSync: number;
	user: { screen_name: string | null; username: string };
	message?: string;
	error?: string;
}

export function RenderPage(props: RenderPageProps) {
	return (
		<AdminLayout title="渲染 · 博客后台" user={props.user} message={props.message} error={props.error}>
			<div class="render-block">
				<h2>全站渲染</h2>
				<p class="hint">
					无条件重写 R2 上全部对象（文章页、分页、归档、索引页、feed、sitemap、主题资源，约 800 个）。
					改了模板、样式、站点设置之后用；不看「待同步」标记，跑完计数也不变。
				</p>
				<p class="hint" style="margin-top:0.75rem">
					只改了某一类东西的话，可以单独渲染对应分组：
				</p>
				<div class="group-buttons">
					<button type="button" data-group="assets">主题资源</button>
					<button type="button" data-group="index">首页与分页</button>
					<button type="button" data-group="overview">索引清单页</button>
					<button type="button" data-group="posts">文章页</button>
					<button type="button" data-group="pages">独立页面</button>
					<button type="button" data-group="categories">分类归档</button>
					<button type="button" data-group="tags">标签归档</button>
					<button type="button" data-group="months">月份归档</button>
					<button type="button" data-group="feed">Feed</button>
					<button type="button" data-group="sitemap">Sitemap</button>
				</div>
				<span id="group-progress" class="hint" role="status" />
				<div class="actions">
					<button type="button" id="full-start">
						开始全站渲染
					</button>
					<span id="full-progress" class="hint" role="status" />
				</div>
			</div>

			<div class="render-block">
				<h2>增量渲染</h2>
				<p class="hint">
					只处理「待同步」队列（D1 改了但还没渲进 R2 的文章），写成功一篇清一个标记。
					和 Cron 的对账是同一套逻辑——Cron 是每小时的自动版，这是手动立即版。
				</p>
				<div class="actions">
					<button type="button" id="drain-start">
						开始增量渲染
					</button>
					<span class="hint">
						当前待同步 <span id="dirty-count">{props.needsSync}</span> 篇
					</span>
					<span id="drain-progress" class="hint" role="status" />
				</div>
			</div>

			<script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
		</AdminLayout>
	);
}
