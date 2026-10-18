import { initDisclosure } from './disclosure.mjs';
import { initPersonQuery } from './person-query.mjs';
import { initCollaboration } from './collaboration.mjs';
import { initPlanningTools } from './planning-tools.mjs';
import { initPrivacyWorkflow } from './privacy-workflow.mjs';
import { initSynthetic } from './synthetic.mjs';

export function initAdvanced({ callCore, element: e, download }) {
  const text = (tag, value, attrs = {}) => e(tag, { ...attrs, text: value });
  const button = (label, action, attrs = {}) => {
    const node = text('button', label, { type: 'button', class: 'secondary', ...attrs });
    node.addEventListener('click', action); return node;
  };
  const field = (label, attrs = {}, tag = 'input') => {
    const input = e(tag, attrs);
    return { input, node: e('label', { class: 'field' }, [text('span', label), input]) };
  };
  const file = label => field(label, { type: 'file', accept: '.json,application/json' });
  async function read(input, json = true) {
    const selected = input.files?.[0];
    if (!selected || selected.size > 4_000_000) throw new Error('请选择不超过 4 MB 的文件。');
    try { const content = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer()); return json ? JSON.parse(content) : content; }
    catch { throw new Error('文件无法读取，请检查 UTF-8 编码和 JSON 格式。'); }
  }
  const panel = (heading, children = []) => e('section', { class: 'panel' }, [text('h2', heading), ...children]);
  const row = (...children) => e('div', { class: 'button-row' }, children);
  const note = value => text('p', value, { class: 'help' });
  function controller(root) {
    const status = text('p', '', { class: 'notice', role: 'status', 'aria-live': 'polite', hidden: true });
    root.append(status);
    let busy = false;
    return async (action, done = '已完成。') => {
      if (busy) return;
      busy = true;
      const controls = [...root.querySelectorAll('input,select,textarea,button')].map(n => [n, n.disabled]);
      controls.forEach(([n]) => { n.disabled = true; });
      status.hidden = false; status.classList.remove('error'); status.setAttribute('role', 'status'); status.textContent = '正在处理…';
      try { await action(); status.textContent = done; }
      catch (error) {
        status.classList.add('error'); status.setAttribute('role', 'alert');
        status.textContent = /[\u4e00-\u9fff]/.test(error.message) ? error.message : '未完成，请核对文件版本、所属任务、有效期和输入范围。原文件未修改。';
      } finally {
        busy = false; controls.forEach(([n, disabled]) => { n.disabled = disabled; });
      }
    };
  }
  function tabs(root, title, description, items) {
    root.append(e('div', { class: 'page-heading' }, [e('div', {}, [text('p', '为具体任务选择保护方式', { class: 'eyebrow' }), text('h1', title), text('p', description)])]));
    const nav = e('nav', { class: 'subnav', 'aria-label': title + '任务' });
    const sections = items.map(([id, name]) => {
      const section = e('div', { id, hidden: true });
      const tab = button(name, () => {
        sections.forEach(s => { s.section.hidden = s.section !== section; s.tab.setAttribute('aria-pressed', String(s.section === section)); });
      }, { 'aria-pressed': 'false' });
      nav.append(tab); return { section, tab };
    });
    root.append(nav, ...sections.map(s => s.section));
    sections[0].section.hidden = false; sections[0].tab.setAttribute('aria-pressed', 'true');
    return sections.map(s => s.section);
  }
  const ui = { e, text, button, field, file, read, panel, row, note, controller, callCore, download };
  initSynthetic(document.querySelector('#view-synthetic'), ui);
  const [disclosure, person, comparison, versions, workflow] = tabs(document.querySelector('#view-review'), '发布检查', '比较处理方案、核对组合披露风险，再选择合适的发布方式。', [['disclosure-tool', '报表防反推'], ['person-tool', '按人保护的多表统计'], ['comparison-tool', '处理方案比较'], ['versions-tool', '两版数据联查'], ['workflow-tool', '隐私流程检查']]);
  initDisclosure(disclosure, ui); initPersonQuery(person, ui);
  initPlanningTools(comparison, versions, ui);
  initPrivacyWorkflow(workflow, ui);
  const [credential, joint] = tabs(document.querySelector('#view-collaboration'), '协作工具', '按角色保管文件，在资格核验、收卷与联合分析之间减少身份和数据暴露。', [['credential-tool', '匿名参与凭证'], ['joint-tool', '联合统计']]);
  initCollaboration(credential, joint, ui);
}
