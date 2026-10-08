// Raw tables and the session token stay in memory. Browser storage contains only
// the selected project and a pending request ID used to recover a saved release.
export function initStatistics({ callCore, element, download }) {
  const $ = id => document.getElementById(`stats-${id}`);
  const PENDING = 'mpk.statistics.pending.v1';
  const SELECTED = 'mpk.statistics.project.v1';
  const idPattern = /^[A-Za-z0-9_-]{1,320}$/;
  let loaded = false, busy = false, token = '', selected = '', projects = [];
  let table = null, pending = null, snapshot = null, completed = false, historyOffset = 0;
  try {
    selected = sessionStorage.getItem(SELECTED) || '';
    const saved = JSON.parse(sessionStorage.getItem(PENDING) || 'null');
    if (saved && idPattern.test(saved.projectId) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(saved.requestId)) {
      pending = { projectId: saved.projectId, requestId: saved.requestId };
      selected = pending.projectId;
    }
  } catch { /* The first publication checks whether recovery storage is available. */ }
  function message(text = '', error = false) {
    $('notice').textContent = text;
    $('notice').hidden = !text;
    $('notice').classList.toggle('error', error);
    $('notice').setAttribute('role', error ? 'alert' : 'status');
  }
  function sync() {
    const project = projects.find(p => p.id === selected);
    $('workspace').hidden = !project?.status;
    $('budget').hidden = !project?.status;
    $('project').disabled = busy || Boolean(pending);
    $('refresh').disabled = busy;
    for (const control of $('create').elements) control.disabled = busy || Boolean(pending);
    $('inputs').disabled = busy || completed || Boolean(pending && snapshot);
    $('form').hidden = completed;
    $('publish-actions').hidden = completed || !table;
    $('publish').disabled = busy;
    $('recover').disabled = busy;
    $('next').disabled = busy;
    $('history-refresh').disabled = busy;
    $('more').disabled = busy;
    for (const button of $('history').querySelectorAll('button')) button.disabled = busy;
    $('complete').hidden = !completed;
    $('pending').hidden = !pending;
    $('pending-message').textContent = snapshot
      ? '操作可能已经完成。先恢复已保存报告，或用同一份输入重试；不会重新扣减已经提交的这次预算。'
      : '刷新前的发布编号已保留。先恢复报告；尚未找到时，可重新选择原文件、填写原设置，再用同一编号重试。';
    $('publish').textContent = busy ? '正在处理…' : pending ? '重试本次发布' : `生成报告（使用 ε ${$('epsilon').value || '…'}）`;
  }
  async function run(action) {
    if (busy) return;
    busy = true; message(); sync();
    try { await action(); }
    catch (error) { message(error.publicMessage || '本机连接未完成。若刚才发起过发布，请恢复报告或使用原编号重试。', true); }
    finally { busy = false; sync(); }
  }
  function invalid(text) { const error = new Error(text); error.publicMessage = text; throw error; }
  async function connect() {
    const response = await fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) invalid('无法连接本机统计服务，请确认通过本机地址打开工作台。');
    token = payload.data.token;
  }
  async function api(path, data, retry = true) {
    if (!token) await connect();
    const response = await fetch(`/api${path}`, {
      method: data === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(20000),
      headers: { 'X-MoonPrivacyKit-Token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const payload = await response.json();
    if (response.status === 401 && retry) { await connect(); return api(path, data, false); }
    if (!response.ok || !payload.ok) {
      const error = new Error('Local API request failed.');
      error.code = payload.code; error.status = response.status; error.publicMessage = payload.message;
      throw error;
    }
    return payload.data;
  }
  const projectPath = () => `/projects/${selected}`;
  function budget(status) {
    const project = projects.find(p => p.id === selected);
    if (project) project.status = status;
    $('budget').replaceChildren(...[
      ['剩余预算 ε', status.remaining_epsilon], ['已使用 ε', status.spent_epsilon],
      ['总预算 ε', status.total_epsilon], ['已保存报告', String(status.release_count)],
    ].map(([label, value]) => element('div', {}, [element('dt', { text: label }), element('dd', { text: value })])));
  }
  function tab(history) {
    $('publish-view').hidden = history;
    $('history-view').hidden = !history;
    $('publish-tab').setAttribute('aria-pressed', String(!history));
    $('history-tab').setAttribute('aria-pressed', String(history));
  }
  async function history(append = false) {
    if (!selected) return;
    const data = await api(`${projectPath()}/releases?offset=${append ? historyOffset : 0}`);
    if (!append) $('history').replaceChildren();
    if (!data.total) $('history').append(element('p', { class: 'history-empty', text: '还没有已保存的报告。完成一次发布后，可在这里随时取回。' }));
    for (const item of data.items) {
      const button = element('button', { type: 'button', class: 'secondary', text: '查看报告', 'aria-label': `查看第 ${data.total - data.offset - data.items.indexOf(item)} 次报告` });
      button.addEventListener('click', () => run(async () => showReport(await api(`${projectPath()}/releases/${item.request_id}`))));
      $('history').append(element('div', { class: 'history-row' }, [element('div', {}, [
        element('h3', { text: `第 ${data.total - data.offset - data.items.indexOf(item)} 次 · ${item.query === 'count' ? '计数' : '类别分布'}` }),
        element('p', { text: `ε ${item.epsilon} · 每人最多 ${item.max_contributions} 条${item.categories.length ? ` · ${item.categories.length} 个公开类别` : ''}` }),
      ]), button]));
    }
    historyOffset = data.offset + data.items.length;
    $('more').hidden = !data.has_more;
  }
  async function selectProject() {
    $('report').hidden = true; completed = false;
    const project = projects.find(p => p.id === selected);
    if (!project) return;
    if (project.error) invalid(project.error);
    budget(await api(`${projectPath()}/status`));
    try { sessionStorage.setItem(SELECTED, selected); } catch { /* Selection is optional. */ }
    await history();
    if (pending) await recover();
  }
  async function refresh(preferred = selected) {
    projects = await api('/projects');
    selected = pending?.projectId || (projects.some(p => p.id === preferred) ? preferred : projects[0]?.id || '');
    $('project').replaceChildren(...(projects.length ? projects.map(p => element('option', { value: p.id, text: `${p.name}${p.error ? '（无法读取）' : ''}` })) : [element('option', { value: '', text: '尚无项目，请先创建' })]));
    if (pending && !projects.some(p => p.id === selected)) invalid('找不到待确认发布所属的项目。请恢复原项目账本后刷新，避免重新发布。');
    $('project').value = selected;
    $('new').open = !projects.length;
    await selectProject();
  }
  function clearPending() {
    pending = null; snapshot = null;
    try { sessionStorage.removeItem(PENDING); } catch { /* A stale ID only reopens the same saved result. */ }
  }
  async function finish(report) {
    clearPending(); completed = true; tab(false); sync(); showReport(report);
    message('报告已保存。重复下载不会生成新结果，也不增加预算开销。');
    try { budget(await api(`${projectPath()}/status`)); await history(); }
    catch { message('报告已保存，可直接下载。预算与历史暂未刷新，请稍后刷新项目。'); }
  }
  async function recover() {
    if (pending) await finish(await api(`${projectPath()}/releases/${pending.requestId}`));
  }
  function showReport(result) {
    const r = result.report;
    const interval = value => `${Math.max(0, value - r.absolute_error_bound)}–${Math.min(r.output_upper, value + r.absolute_error_bound)}`;
    const save = element('button', { class: 'primary', type: 'button', text: '下载这份报告' });
    save.addEventListener('click', () => download(`private-statistics-${result.release_id}.json`, result));
    const nodes = [element('div', { class: 'result-heading' }, [element('h2', { text: r.query === 'count' ? '受保护计数' : '受保护类别分布' }), save]),
      element('p', { class: 'muted', text: `本次 ε ${r.epsilon} · 每人最多 ${r.max_contributions} 条 · 95% 同时绝对误差界 ±${r.absolute_error_bound}` })];
    if (r.query === 'count') nodes.push(element('div', { class: 'stats-count', text: String(r.counts[0]) }), element('p', { text: `误差范围：${interval(r.counts[0])}` }));
    else {
      const maximum = Math.max(1, ...r.counts);
      nodes.push(element('ul', { class: 'stats-bars' }, r.counts.map((count, i) => element('li', {}, [
        element('span', { text: result.categories[i] }), element('meter', { min: 0, max: maximum, value: count, 'aria-label': `${result.categories[i]}：${count}` }),
        element('span', {}, [element('strong', { text: String(count) }), element('small', { text: `范围 ${interval(count)}` })]),
      ]))));
    }
    nodes.push(element('p', { class: 'footnote', text: '结果已经加入随机噪声；0 不代表无人参与。范围针对按人裁剪后的统计量，不覆盖裁剪偏差、样本偏差或错误标识。报告不包含原始记录。' }));
    $('report').replaceChildren(...nodes); $('report').hidden = false;
    $('report').focus({ preventScroll: true });
    $('report').scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }
  function epsilon(value, total = false) {
    if (!/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/.test(value) || Number(value) < .01 || Number(value) > (total ? 1000 : 8)) {
      invalid(`预算须在 0.01 至 ${total ? '1000' : '8'} 之间，使用最多六位小数，例如 0.3。`);
    }
    return value;
  }
  function settings() {
    const query = $('query').value, cap = Number($('cap').value);
    if (!Number.isInteger(cap) || cap < 1 || cap > 32) invalid('每人贡献上限须为 1 至 32 的整数。');
    const plan = { query, epsilon: epsilon($('epsilon').value), maxContributions: cap, unitField: $('unit').value };
    if (query === 'histogram') {
      const categories = $('categories').value.split('\n');
      if (categories.length < 1 || categories.length > 256 || categories.some(c => !c.trim() || c.length > 128) || new Set(categories).size !== categories.length) invalid('请填写 1 至 256 个不重复的公开类别，每行一个，不能有空行，每个最多 128 个字符。');
      Object.assign(plan, { categoryField: $('category').value, categories });
    }
    return plan;
  }
  function estimate() {
    const histogram = $('query').value === 'histogram';
    $('category-settings').hidden = !histogram;
    $('category').required = histogram; $('categories').required = histogram;
    try {
      const plan = settings();
      const mechanism = callCore({ op: 'centralMechanism', category_count: plan.categories?.length || 1, epsilon: Number(plan.epsilon), max_contributions: plan.maxContributions });
      $('estimate').textContent = `按当前设置，95% 同时绝对误差界为 ±${mechanism.absolute_error_bound}。这里仅评估保护参数，不读取个人记录、不消耗预算。`;
    } catch (error) { $('estimate').textContent = error.publicMessage || '请检查保护参数后再发布。'; }
    sync();
  }
  function loadTable(name, input, format, example = false) {
    table = null; $('settings').hidden = true; $('report').hidden = true;
    let fields;
    try { fields = callCore({ op: 'inspect', format, input }); }
    catch { invalid('无法读取表格，请检查 UTF-8 编码、唯一的列名和 CSV／JSON 结构。'); }
    if (!fields.length) invalid('没有可选择的列。空数据请使用保留表头的 CSV；JSON 需包含字段定义。');
    const oldUnit = $('unit').value, oldCategory = $('category').value;
    for (const control of [$('unit'), $('category')]) control.replaceChildren(element('option', { value: '', text: '请选择列' }), ...fields.map(f => element('option', { value: f, text: f })));
    $('unit').value = fields.includes(oldUnit) ? oldUnit : '';
    $('category').value = fields.includes(oldCategory) ? oldCategory : '';
    table = { input, format };
    $('file-note').textContent = `已载入：${name}。只显示列名，原始记录仅用于本机统计。`;
    $('settings').hidden = false;
    if (example) {
      $('query').value = 'histogram'; $('unit').value = 'person_id'; $('category').value = 'answer';
      $('categories').value = '满意\n一般\n不满意';
    }
    estimate();
  }
  document.querySelector('[data-view="statistics"]').addEventListener('click', () => {
    if (!loaded) run(async () => { await refresh(); loaded = true; });
  });
  $('refresh').addEventListener('click', () => run(() => refresh()));
  $('project').addEventListener('change', () => run(async () => { selected = $('project').value; await selectProject(); }));
  $('create').addEventListener('submit', event => {
    event.preventDefault(); run(async () => {
      const project = await api('/projects', { name: $('name').value, totalEpsilon: epsilon($('total').value, true) });
      await refresh(project.id); $('new').open = false; message('项目已创建。请导入表格并设置本次统计。');
    });
  });
  $('file').addEventListener('change', () => run(async () => {
    table = null; $('settings').hidden = true; $('report').hidden = true; $('file-note').textContent = '未载入有效文件，请选择符合要求的 CSV 或 JSON。';
    const file = $('file').files[0];
    if (!file || file.size > 4_000_000) invalid('请选择不超过 4 MB 的 CSV 或 JSON 文件。');
    const format = file.name.split('.').pop().toLowerCase();
    if (!['csv', 'json'].includes(format)) invalid('请选择 CSV 或 JSON 文件。');
    let input;
    try { input = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, ''); }
    catch { invalid('文件不是有效的 UTF-8 文本，请转换编码后重新选择。'); }
    loadTable(file.name, input, format);
  }));
  $('example').addEventListener('click', () => run(async () => {
    $('file').value = '';
    loadTable('虚构统计示例.csv', 'person_id,answer\nunit-001,满意\nunit-002,一般\nunit-003,满意\nunit-001,不满意\nunit-004,不满意', 'csv', true);
  }));
  $('settings').addEventListener('input', () => { $('report').hidden = true; estimate(); });
  $('form').addEventListener('submit', event => {
    event.preventDefault(); run(async () => {
      if (completed || !table || !selected) return;
      const plan = snapshot?.plan || settings();
      if (!plan.unitField || (plan.query === 'histogram' && !plan.categoryField)) invalid('请选择人员标识列及需要的类别列。');
      const wasPending = Boolean(pending);
      if (!pending) {
        // Check recovery persistence before sending any request that can spend budget.
        const next = { projectId: selected, requestId: crypto.randomUUID() };
        try { sessionStorage.setItem(PENDING, JSON.stringify(next)); }
        catch { invalid('浏览器无法保存恢复编号，尚未发布。请允许本地会话存储后重试。'); }
        pending = next;
      }
      snapshot ||= { ...table, plan: { ...plan, requestId: pending.requestId } };
      sync();
      let result;
      try { result = await api(`${projectPath()}/publish`, snapshot); }
      catch (error) {
        // These rejections occur before sampling or committing. Unknown outcomes
        // retain the exact request and never silently create a new release ID.
        if (['INVALID_TABLE', 'INVALID_REQUEST', 'INVALID_BUDGET', 'BUDGET_EXHAUSTED', 'INPUT_TOO_LARGE', 'JSON_REQUIRED'].includes(error.code)) {
          if (wasPending) snapshot = null;
          else clearPending();
          try { budget(await api(`${projectPath()}/status`)); } catch { /* Keep the original error. */ }
        }
        throw error;
      }
      await finish(result);
    });
  });
  $('recover').addEventListener('click', () => run(recover));
  $('next').addEventListener('click', () => {
    completed = false; $('report').hidden = true; message('请核对新发布的设置。新报告会继续累计消耗本项目预算。'); sync();
    $('query').focus();
  });
  $('publish-tab').addEventListener('click', () => tab(false));
  $('history-tab').addEventListener('click', () => { tab(true); run(() => history()); });
  $('history-refresh').addEventListener('click', () => run(() => history()));
  $('more').addEventListener('click', () => run(() => history(true)));
}
