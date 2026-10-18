import { evaluatePrivacyAttack } from '/runtime/privacy-attack.mjs';

self.onmessage = event => {
  try { self.postMessage({ report: evaluatePrivacyAttack(event.data) }); }
  catch (error) {
    const message = String(error.message);
    const explanation = /unique and disjoint/.test(message) ? '成员或对照表有重复人员，或两表人员标识重叠。请检查真实人员对应。'
      : /20 to 2000/.test(message) ? '成员表和独立对照表各需 20–2,000 人。请补充样本或减少规模。'
      : /work limit/.test(message) ? '比较规模超过首版上限，请减少待测表行数或所选字段。没有给出安全结论。'
      : /outside the declared/.test(message) ? '有敏感字段值不属于声明类别，请核对配置；不会自动忽略记录或添加类别。'
      : /exactly the known|columns/.test(message) ? '待测表须恰好包含已知字段和敏感字段，不能包含人员标识或其他未检查列。'
      : '无法评估，请核对 UTF-8 文件格式、字段名、分类字符串和输入规模。未输出安全结论。';
    self.postMessage({ error: explanation });
  }
};
