export function initPrivacyAttack(root, ui) {
  const { e, text, button, field, file, read, panel, row, note, controller, download } = ui;
  const run = controller(root);
  const table = label => { const f = file(label); f.input.accept = '.csv,.json'; return f; };
  const members = table('参与生成的原始成员表'), controls = table('未参与生成的独立对照表');
  const releases = table('待测合成表或完整生成记录（最多 3 份）'); releases.input.multiple = true;
  const unit = field('两份私有表的人员标识列', { value: 'person' });
  const known = field('攻击者已知的字段（每行一个）', { rows: 2 }, 'textarea'); known.input.value = 'group';
  const sensitive = field('尝试推断的敏感字段', { value: 'choice' });
  const values = field('敏感字段的全部类别（每行一个）', { rows: 3 }, 'textarea'); values.input.value = 'yes\nno';
  const seed = field('固定分组种子', { type: 'number', min: 1, max: 2147483646, step: 1, value: 20261018 });
  const confirmed = field('确认成员确实参与过生成，对照人员未参与，且来自可比较人群；所有候选使用同一成员范围', { type: 'checkbox' });
  confirmed.node.classList.add('attack-confirm');
  const attached = note('可导入已保存的合成 CSV、JSON 表或完整生成记录；不会重新生成数据。');
  const results = e('section', { class: 'panel', id: 'attack-results', hidden: true, tabindex: -1, 'aria-label': '隐私泄露实测结果' });
  let handoff, reports;
  const clearResults = () => { reports = undefined; results.replaceChildren(); results.hidden = true; };
  root.addEventListener('input', clearResults); root.addEventListener('change', clearResults);
  const selection = () => ({ schema_version: 1, unit_field: unit.input.value, known_fields: known.input.value.split('\n'), sensitive_field: sensitive.input.value, sensitive_values: values.input.value.split('\n'), split_seed: Number(seed.input.value) });
  const source = async input => ({ format: input.files[0]?.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json', input: await read(input, false) });
  function evaluate(request) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('/web/privacy-attack-worker.mjs', { type: 'module' });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('评估超时，请减少数据行数。没有给出安全结论。')); }, 30000);
      const finish = (value, error) => { clearTimeout(timer); worker.terminate(); error ? reject(new Error(error)) : resolve(value); };
      worker.onmessage = event => finish(event.data.report, event.data.error);
      worker.onerror = () => finish(null, '评估未完成，请检查文件与输入规模后重试。');
      worker.postMessage(request);
    });
  }
  const percent = n => `${(100 * n).toFixed(1)}%`;
  const bound = (n, upper) => ((upper ? Math.ceil(n * 1000) : Math.floor(n * 1000)) / 10).toFixed(1);
  const interval = r => `${percent(r.rate)}（95% 区间 ${bound(r.lower95, false)}%–${bound(r.upper95, true)}%）`;
  const points = n => `${(100 * n).toFixed(1)} 个百分点`;
  function render() {
    results.replaceChildren(text('h2', '实测结果 · 仅供内部复核'), note('攻击成功不等于识别出某个具体人；未发现有效攻击也不能证明数据安全。区间只针对本次固定评估，不覆盖反复调参或多份候选的整体比较。'));
    reports.forEach((report, index) => {
      const m = report.membership, a = report.attribute, split = report.split;
      const grid = e('table', {}, [
        e('caption', { text: '敏感属性推断：攻击者只使用已知字段；基线始终猜校准对照组中最多的类别。' }),
        e('thead', {}, [e('tr', {}, ['测试群体', '攻击准确率及 95% 区间', '基线准确率及 95% 区间', '相对基线增益'].map(t => text('th', t, { scope: 'col' })))]),
        e('tbody', {}, [['成员', a.members], ['未参与者', a.nonmembers]].map(([label, r]) => e('tr', {}, [text('th', label, { scope: 'row' }), text('td', interval(r.accuracy)), text('td', interval(r.baseline_accuracy)), text('td', points(r.gain.estimate))]))),
      ]);
      results.append(e('section', { class: 'attack-candidate' }, [
        text('h3', `候选 ${index + 1} · ${report.release_rows} 行合成数据`),
        text('p', `独立测试：成员 ${split.test_members} 人，对照 ${split.test_nonmembers} 人。另用成员 ${split.calibration_members} 人、对照 ${split.calibration_nonmembers} 人校准。`, { class: 'help' }),
        text('p', m.advantage.lower95 > 0 ? '本次成员推断优势区间高于 0，建议复核发布方案与评估人群。' : '本次成员推断证据不足，不能据此认定匿名或无泄露。', { class: 'attack-verdict' }),
        e('dl', { class: 'attack-metrics' }, [
          e('div', {}, [text('dt', '成员命中率'), text('dd', interval(m.true_positive_rate))]),
          e('div', {}, [text('dt', '未参与者误报率'), text('dd', interval(m.false_positive_rate))]),
          e('div', {}, [text('dt', '成员推断优势'), text('dd', points(m.advantage.estimate)), text('p', `近似 95% 区间：${bound(m.advantage.lower95, false)} 至 ${bound(m.advantage.upper95, true)} 个百分点`, { class: 'footnote' })]),
        ]),
        e('div', { class: 'synthetic-preview', tabindex: 0, 'aria-label': '属性推断结果，可横向滚动' }, [grid]),
        e('details', {}, [text('summary', '核对实验设置与限制'), text('p', `成员推断使用全部所选字段，汉明距离阈值 ${m.threshold_mismatches}；−1 表示校准时未找到优于全部判为未参与者的阈值。分组种子 ${split.seed}。`), text('p', '一份固定合成结果、一次拆分。群体差异也可能导致攻击分数升高；属性预测可能只反映群体规律。先确定字段、类别顺序和种子，不能反复看测试结果挑最优设置。'), text('p', '本报告不含逐人预测与原值，但汇总指标仍依赖私有数据。对外发布本报告或根据它选择新发布方案，需要另行评估隐私开销。')]),
      ]));
    });
    results.append(button('下载内部实测报告', () => { if (reports) download('private-privacy-attack.json', { schema_version: 1, kind: 'moonprivacykit/privacy-attack-comparison', audience: 'internal', reports }); }));
    results.hidden = false; results.focus();
  }
  const remove = button('清除已带入结果', () => { handoff = undefined; attached.textContent = '请选择待测合成数据。'; clearResults(); remove.hidden = true; }); remove.hidden = true;
  releases.input.addEventListener('change', () => { handoff = undefined; remove.hidden = true; attached.textContent = '按所选顺序比较候选；所有候选使用相同分组和攻击定义。'; });
  const demo = button('载入虚构泄露示例', () => run(async () => {
    clearResults();
    const fixture = await (await fetch('/examples/privacy-attack-demo.json')).json();
    const setFile = (input, data, name) => { const transfer = new DataTransfer(); transfer.items.add(new File([JSON.stringify(data)], name, { type: 'application/json' })); input.files = transfer.files; };
    unit.input.value = 'person'; known.input.value = 'group'; sensitive.input.value = 'choice'; values.input.value = 'yes\nno'; seed.input.value = 20261018;
    setFile(members.input, fixture.members, 'fictional-members.json'); setFile(controls.input, fixture.nonmembers, 'fictional-controls.json');
    setFile(releases.input, fixture.released, 'fictional-release.json'); handoff = undefined; remove.hidden = true; confirmed.input.checked = false;
    attached.textContent = '虚构反例故意复制了成员类别组合，用来验证工具能发现泄露信号；不代表真实数据上的效果。';
  }, '虚构示例已载入，请核对评估条件。'));
  root.append(panel('检查合成数据暴露了多少信息', [note('仅在浏览器本机内存评估，不上传私有表、不消耗发布预算。先准备参与生成的成员表，以及同一人群中未参与生成的独立对照表。'), row(demo),
    e('div', { class: 'two-col' }, [members.node, controls.node]),
    note('两份私有表各 20–2,000 人，一人一行且标识互不重复；每组约一半校准、一半测试。不能仅靠不同编号证明同一人未重复出现，也不能用不同来源的人群冒充对照。'),
    releases.node, attached, row(remove),
    e('details', { open: true }, [text('summary', '设置已知信息与推断目标'), e('div', { class: 'two-col' }, [unit.node, known.node, sensitive.node, values.node]), note('首版仅处理分类字符串：1–5 个已知字段、1 个敏感字段。待测表须恰好包含这些字段，不得含标识或其他未检查列。使用本工具生成的数据时，优先导入完整记录，避免 CSV 公式保护前缀改变类别。')]),
    e('details', {}, [text('summary', '固定评估分组'), seed.node, note('同一输入和种子可复现，调换行顺序不改变结果。修改种子后再次看分数属于重复分析。')]),
    confirmed.node,
    row(button('开始泄露实测', () => run(async () => {
      clearResults();
      if (!confirmed.input.checked) throw new Error('请先核对成员、对照人群和候选范围。');
      const files = [...releases.input.files];
      if (!handoff && (files.length < 1 || files.length > 3)) throw new Error('请选择 1 至 3 份待测数据。');
      const request = { config: selection(), members: await source(members.input), nonmembers: await source(controls.input) };
      const inputs = handoff ? [{ format: 'artifact', input: JSON.stringify(handoff) }] : await Promise.all(files.map(f => source({ files: [f] })));
      const next = [];
      for (const released of inputs) next.push(await evaluate({ ...request, released }));
      reports = next; render();
    }, '实测完成；报告仅供内部复核。'), { class: 'primary' })),
  ]), results);
  document.addEventListener('moonprivacykit:audit-synthetic', event => {
    document.querySelector('[data-view="review"]').click(); document.querySelector('[data-tool="attack-tool"]').click();
    run(() => {
      clearResults();
      handoff = undefined; releases.input.value = ''; remove.hidden = true;
      const result = event.detail, plan = result?.synthetic?.plan;
      if (!plan || plan.fields.length < 2) throw new Error('这份合成数据至少需要两个字段，才能同时进行成员与属性推断。');
      handoff = structuredClone(result); releases.input.value = ''; confirmed.input.checked = false;
      unit.input.value = plan.unit_field;
      known.input.value = plan.fields.slice(0, -1).map(f => f.name).join('\n');
      sensitive.input.value = plan.fields.at(-1).name; values.input.value = plan.fields.at(-1).categories.join('\n');
      remove.hidden = false; attached.textContent = `已带入保存的合成结果（${result.synthetic.rows.length} 行）。请补充与这次生成对应的成员表和独立对照表。`;
    }, '已带入合成数据，原发布和预算不变。');
  });
}
