import { renderReport } from '/runtime/report-export.mjs';

// Both downloads refer to one saved result, never a new query or random draw.
export function reportActions({ kind, report, filename, jsonLabel, jsonClass = 'secondary', element, download }) {
  const snapshot = JSON.parse(JSON.stringify(report));
  const json = element('button', { class: jsonClass, type: 'button', text: jsonLabel });
  const html = element('button', { class: 'secondary', type: 'button', text: '下载可读报告（HTML）' });
  const error = element('p', { class: 'report-export-error', role: 'alert', hidden: true });
  let rendered;
  json.addEventListener('click', () => download(`${filename}.json`, snapshot));
  html.addEventListener('click', () => {
    try {
      rendered ??= renderReport(kind, snapshot);
      download(`${filename}.html`, rendered, 'text/html');
      error.hidden = true;
    } catch {
      error.textContent = '可读报告导出失败，已有结果仍保留。可先下载 JSON，核对版本后重试。';
      error.hidden = false;
    }
  });
  return element('div', { class: 'report-downloads' }, [element('div', { class: 'button-row' }, [json, html]), element('p', { class: 'footnote', text: 'HTML 可离线查看，也可用浏览器打印。' }), error]);
}
