#!/usr/bin/env node
/**
 * 派生视图.js —— 数字柏林墙设定集 派生视图生成与校验
 *
 * 用法:
 *   node 工具/派生视图.js              生成派生视图至 派生视图/ 目录
 *   node 工具/派生视图.js --check      只校验登记字段, 不写文件
 *   node 工具/派生视图.js --root <路径>  指定设定集根目录
 *
 * 设计原则(见 CONTRIBUTING.md 01 与 02):
 *   设定文件是唯一事实来源; 本脚本只读取, 永不改写设定正文.
 *   所有清单均由各文件自身的登记字段与所在路径推得, 因此新增文件不需要改动任何既有文件.
 *
 * 登记字段写法: **字段名** 值 或 **字段名**：值, 冒号须为半角, 值不得为空.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = '派生视图';
const PERSON_DIR = '人物设定集';
const FACTION_DIR = '势力设定集';
const WEAPON_DIR = '武器与装备设定集';
const CHAPTER_DIR = '孤章集';
const DOC_DIR = '数字柏林墙文档库';
const WORLD_DIR = '世界观大纲';

const COLLAB_FILES = [
  WORLD_DIR + '/历史年表.md',
  WORLD_DIR + '/术语与概念.md',
];

const FIELD_RE = /^\*\*\s*([^*\s]+?)\s*\*\*\s*[:：]?\s*(.*)$/;

/** 去掉行内被转义的星号, 使 \\*\\*所属势力\\*\\* 之类的写法仍可解析 */
function cleanEscapes(line) {
  if (line.indexOf('\\') < 0) return line;
  return line.split('\\\\*').join('*');
}
const TITLE_RE = /^#\s+(.*)$/;

let ROOT = process.cwd();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) ROOT = path.resolve(argv[++i]);
}
const CHECK_ONLY = argv.includes('--check');

/* ---------- 基础工具 ---------- */

function walk(dir, out) {
  out = out || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  entries.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === OUT_DIR || ent.name.charAt(0) === '.') continue;
      walk(full, out);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function readDoc(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const doc = { file: file, rel: rel(file), lines: lines, title: '', fields: {}, fieldLines: {}, stray: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.match(TITLE_RE);
    if (t && !doc.title) doc.title = t[1].trim();
    if (/\\<!--|--\\>|\\\*\\*/.test(line)) {
      doc.stray.push(i + 1);
    }
    const m = cleanEscapes(line).match(FIELD_RE);
    if (m) {
      const key = m[1];
      if (!(key in doc.fields)) {
        doc.fields[key] = m[2].trim();
        doc.fieldLines[key] = i + 1;
      }
    }
  }
  return doc;
}

function cnName(title) {
  return title.replace(/[（(].*$/, '').trim();
}

/**
 * 把字段值切分为条目. 先按列表分隔符切分, 再剥离条目末尾的括注.
 * 括注用于说明别名、文书称呼等; 括注内不得出现列表分隔符(见 CONTRIBUTING.md 09 第三条).
 */
function splitEntries(value) {
  if (!value) return [];
  const out = [];
  let depth = 0;
  let buf = '';
  const flush = function () {
    const v = buf.trim();
    const d = stripAnnotation(v);
    if (d && d !== '无' && d !== '暂无' && d !== '（待补充）' && d !== '(待补充)') out.push(v);
    buf = '';
  };
  for (const ch of value) {
    if (ch === '（' || ch === '(') depth++;
    if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && '、，,；;／/|'.indexOf(ch) >= 0) flush();
    else buf += ch;
  }
  flush();
  return out;
}

/** 剥离「名称（括注）」「名称(括注)」末尾的括注; 括号不配对时视为值的一部分 */
function stripAnnotation(s) {
  let t = s.trim();
  const pairs = [['（', '）'], ['(', ')']];
  for (const pair of pairs) {
    const open = t.lastIndexOf(pair[0]);
    if (open > 0) {
      const close = t.lastIndexOf(pair[1]);
      if (close > open) t = t.slice(0, open).trim();
    }
  }
  return t;
}

/** 取势力字段的势力名: 兼容 `开源协议联盟（天工管理员）` 与 `欧洲企业联合-断点重工` */
function firstFaction(value) {
  if (!value) return '';
  const entries = splitEntries(value);
  const head = entries.length ? entries[0] : value;
  return stripAnnotation(head).split(/\s*-\s*|—/)[0].trim();
}

/** 取条目末尾括注内的文字; 无括注返回 '' */
function annotationOf(s) {
  const m = s.match(/[（(]([^）)]*)[）)]\s*$/);
  return m ? m[1].trim() : '';
}

/**
 * 解析篇目 `**关联人物**` 中的一个条目.
 * 条目形如 `河川爱子（渡边华）`: 括注为别名/文书称呼, 本名与括注均可对应人物文件.
 * 返回 { display, person, unresolved }.
 */
function resolvePerson(entry, personByName) {
  const primary = stripAnnotation(entry);
  const alias = annotationOf(entry);
  const hit = personByName.get(primary) || (alias ? personByName.get(alias) : undefined);
  return { display: primary, alias: alias, person: hit, unresolved: !hit };
}

function hasListSeparatorInAnnotation(value) {
  if (!value) return false;
  const m = value.match(/[（(]([^）)]*)[）)]/);
  return !!m && /[、，,；;／\/|]/.test(m[1]);
}

function mdLink(text, file) {
  const from = path.join(ROOT, OUT_DIR);
  const target = path.relative(from, file).split(path.sep).join('/');
  return '[' + text + '](' + target + ')';
}

function inline(text) {
  return '`' + text + '`';
}

/* ---------- 收集 ---------- */

function collect() {
  const strayFiles = [];
  const data = {
    factions: [],
    factionByName: new Map(),
    persons: [],
    personByName: new Map(),
    chapters: [],
    docs: [],
    weapons: [],
    world: [],
    issues: [],
    unresolved: [],
  };

  function issue(sev, file, line, msg) {
    data.issues.push({ sev: sev, rel: rel(file), line: line, msg: msg });
  }

  for (const f of walk(path.join(ROOT, FACTION_DIR))) {
    const d = readDoc(f);
    const name = cnName(d.title) || path.basename(f, '.md');
    const fac = { name: name, doc: d, persons: [], docs: [], weapons: [] };
    data.factions.push(fac);
    data.factionByName.set(name, fac);
  }

  for (const f of walk(path.join(ROOT, PERSON_DIR))) {
    const d = readDoc(f);
    const parts = rel(f).split('/');
    const dirFaction = parts.length >= 3 ? parts[1] : '';
    const name = path.basename(f, '.md');
    const p = { name: name, doc: d, dirFaction: dirFaction, fieldFaction: d.fields['所属势力'] || '', works: [] };
    data.persons.push(p);
    data.personByName.set(name, p);

    if (!d.fields['所属势力']) {
      issue('warn', f, 0, '缺少登记字段 **所属势力**（人物文件必须登记, 否则无法派生势力成员名单）');
    } else {
      const declared = firstFaction(p.fieldFaction);
      if (declared !== dirFaction) {
        issue('warn', f, d.fieldLines['所属势力'], '**所属势力** 首段「' + declared + '」与所在目录「' + dirFaction + '」不一致');
      }
    }
    if (dirFaction !== '无势力' && !data.factionByName.has(dirFaction)) {
      issue('warn', f, 0, '所在目录「' + dirFaction + '」在 ' + FACTION_DIR + '/ 中没有同名势力文件');
    }
    const fac = data.factionByName.get(dirFaction);
    if (fac) fac.persons.push(p);
    if (d.stray.length) {
      issue('warn', f, d.stray[0], '检测到被转义的标记(如 \\* 或 \\<!--)。若出现在加粗字段或标题上, 会使其无法被解析(见 CONTRIBUTING.md 09 第三条)');
    }
  }

  const groups = [
    { dir: CHAPTER_DIR, kind: '孤章' },
    { dir: DOC_DIR, kind: '文档库' },
  ];
  for (const g of groups) {
    for (const f of walk(path.join(ROOT, g.dir))) {
      const d = readDoc(f);
      const item = {
        kind: g.kind,
        name: cnName(d.title) || path.basename(f, '.md'),
        doc: d,
        factions: splitEntries(d.fields['关联势力']).map(stripAnnotation),
        rawFactions: splitEntries(d.fields['关联势力']),
        rawPersons: splitEntries(d.fields['关联人物']),
        persons: [],
      };
      if (g.kind === '孤章') data.chapters.push(item); else data.docs.push(item);

      if (d.stray.length) {
        issue('warn', f, d.stray[0], '检测到被转义的标记(如 \\* 或 \\<!--)。若出现在加粗字段或标题上, 会使其无法被解析(见 CONTRIBUTING.md 09 第三条)');
      }

      if (d.fields['关联人物'] === undefined) {
        issue('info', f, 0, '未登记 **关联人物**；若本篇有出场角色, 登记后其登场作品才能被派生');
      }

      if (hasListSeparatorInAnnotation(d.fields['关联人物'])) {
        issue('warn', f, d.fieldLines['关联人物'], '**关联人物** 的括注内出现列表分隔符, 会令条目切分错误');
      }
      for (const raw of item.rawPersons) {
        const r = resolvePerson(raw, data.personByName);
        if (r.person) {
          r.person.works.push(item);
          item.persons.push(r.display);
        } else {
          item.persons.push(stripAnnotation(raw));
          data.unresolved.push({ rel: rel(f), line: d.fieldLines['关联人物'], kind: '人物', name: stripAnnotation(raw) });
        }
      }
      for (const fn of item.factions) {
        const fac = data.factionByName.get(fn);
        if (fac) fac.docs.push(item);
        else data.unresolved.push({ rel: rel(f), line: d.fieldLines['关联势力'], kind: '势力', name: fn });
      }
    }
  }

  for (const f of walk(path.join(ROOT, WEAPON_DIR))) {
    const d = readDoc(f);
    const parts = rel(f).split('/');
    const dirFaction = parts.length >= 4 ? parts[1] : '';
    const dirType = parts.length >= 4 ? parts[2] : '';
    const w = {
      name: cnName(d.title) || path.basename(f, '.md'),
      doc: d,
      dirFaction: dirFaction,
      dirType: dirType,
      fieldFaction: d.fields['所属势力'] || '',
      fieldType: d.fields['装备类型'] || '',
      unit: d.fields['研发单位'] || '',
      echelon: d.fields['列装编制'] || '',
    };
    data.weapons.push(w);
    const declared = firstFaction(w.fieldFaction);
    if (!w.fieldFaction) {
      issue('warn', f, 0, '缺少登记字段 **所属势力**');
    } else if (declared !== dirFaction) {
      issue('warn', f, d.fieldLines['所属势力'], '**所属势力** 首段「' + declared + '」与所在目录「' + dirFaction + '」不一致');
    }
    if (w.fieldType && w.fieldType !== dirType) {
      issue('warn', f, d.fieldLines['装备类型'], '**装备类型**「' + w.fieldType + '」与所在目录「' + dirType + '」不一致');
    }
    const fac = data.factionByName.get(dirFaction);
    if (fac) fac.weapons.push(w);
    if (d.stray.length) {
      issue('warn', f, d.stray[0], '检测到被转义的标记(如 \\* 或 \\<!--)。若出现在加粗字段或标题上, 会使其无法被解析(见 CONTRIBUTING.md 09 第三条)');
    }
  }

  for (const f of walk(path.join(ROOT, WORLD_DIR))) {
    const d = readDoc(f);
    data.world.push({ name: cnName(d.title) || path.basename(f, '.md'), doc: d });
  }

  for (const cf of COLLAB_FILES) {
    const full = path.join(ROOT, cf);
    if (!fs.existsSync(full)) {
      issue('error', full, 0, '协作点文件不存在');
      continue;
    }
    const text = fs.readFileSync(full, 'utf8');
    if (!/^##\s*追加区\s*$/m.test(text)) {
      issue('error', full, 0, '协作点缺少 ## 追加区 章节, 协作者将无处追加');
    }
  }

  return data;
}

/* ---------- 生成 ---------- */

function renderIndex(data) {
  const now = new Date();
  const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const L = [];
  L.push('# 派生视图');
  L.push('');
  L.push('> 本目录内容由 ' + inline('工具/派生视图.js') + ' 从各设定文件的登记字段自动生成, **请勿手工编辑**。');
  L.push('> 设定正文以各 .md 源文件为准; 本视图仅用于反向检索（从势力看成员、从人物看登场）。');
  L.push('');
  L.push('生成时间: ' + stamp + ' | 势力 ' + data.factions.length + ' | 人物 ' + data.persons.length +
    ' | 孤章 ' + data.chapters.length + ' | 文档库 ' + data.docs.length + ' | 装备 ' + data.weapons.length +
    ' | 世界观门类 ' + data.world.length);
  L.push('');
  L.push('重新生成: ' + inline('node 工具/派生视图.js') + '　校验: ' + inline('node 工具/派生视图.js --check'));
  L.push('');
  L.push('- [势力名录](#势力名录)');
  L.push('- [人物总表](#人物总表)');
  L.push('- [篇目总表](#篇目总表)');
  L.push('- [装备总表](#装备总表)');
  L.push('- [世界观门类](#世界观门类)');
  L.push('');

  L.push('## 势力名录');
  L.push('');
  for (const fac of data.factions) {
    L.push('### ' + mdLink(fac.doc.title || fac.name, fac.doc.file));
    L.push('');
    if (fac.persons.length) {
      L.push('**成员**（由人物文件的 ' + inline('**所属势力**') + ' 派生, 共 ' + fac.persons.length + '）');
      L.push('');
      for (const p of fac.persons) {
        const job = p.doc.fields['职业'] || '';
        L.push('- ' + mdLink(p.name, p.doc.file) + (job ? '　' + job : ''));
      }
      L.push('');
    }
    if (fac.weapons.length) {
      L.push('**装备**（共 ' + fac.weapons.length + '）');
      L.push('');
      for (const w of fac.weapons) {
        L.push('- ' + mdLink(w.name, w.doc.file) + '　' + w.dirType);
      }
      L.push('');
    }
    if (fac.docs.length) {
      L.push('**关联篇目**（由篇目文件的 ' + inline('**关联势力**') + ' 派生）');
      L.push('');
      for (const d of fac.docs) {
        L.push('- ' + mdLink('《' + d.name + '》', d.doc.file) + '　' + d.kind);
      }
      L.push('');
    }
  }

  L.push('## 人物总表');
  L.push('');
  L.push('| 人物 | 所属势力 | 职业 | 原作者 | 登场作品 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const p of data.persons) {
    const works = p.works.length ? p.works.map(function (w) { return '《' + w.name + '》'; }).join('、') : '暂无';
    L.push('| ' + mdLink(p.name, p.doc.file) + ' | ' + p.dirFaction + ' | ' +
      (p.doc.fields['职业'] || '（待补充）') + ' | ' + (p.doc.fields['原作者'] || '（待补充）') + ' | ' + works + ' |');
  }
  L.push('');

  L.push('## 篇目总表');
  L.push('');
  L.push('| 篇目 | 文集 | 关联势力 | 关联人物 | 时间线 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const d of data.chapters.concat(data.docs)) {
    L.push('| ' + mdLink('《' + d.name + '》', d.doc.file) + ' | ' + d.kind + ' | ' +
      (d.factions.join('、') || '—') + ' | ' + (d.persons.join('、') || '—') + ' | ' +
      (d.doc.fields['时间线'] || '（待补充）') + ' |');
  }
  L.push('');

  L.push('## 装备总表');
  L.push('');
  L.push('| 装备 | 势力 | 类型 | 研发单位 | 列装编制 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const w of data.weapons) {
    L.push('| ' + mdLink(w.name, w.doc.file) + ' | ' + w.dirFaction + ' | ' + w.dirType + ' | ' +
      (w.unit || '（待补充）') + ' | ' + (w.echelon || '（待补充）') + ' |');
  }
  L.push('');

  L.push('## 世界观门类');
  L.push('');
  for (const w of data.world) {
    L.push('- ' + mdLink(w.doc.title || w.name, w.doc.file));
  }
  L.push('');

  return L.join('\n');
}

function renderIssues(data) {
  const L = [];
  const errs = data.issues.filter(function (i) { return i.sev === 'error'; });
  const warns = data.issues.filter(function (i) { return i.sev === 'warn'; });
  const infos = data.issues.filter(function (i) { return i.sev === 'info'; });
  L.push('# 登记字段校验报告');
  L.push('');
  L.push('> 由 ' + inline('工具/派生视图.js --check') + ' 生成。只报告, 不修改设定正文。');
  L.push('> 错误: 必须修复; 提醒: 登记字段缺失或与路径不一致, 建议补齐; 信息: 仅供参考。');
  L.push('');
  L.push('合计: 错误 ' + errs.length + ' | 提醒 ' + warns.length + ' | 信息 ' + infos.length +
    ' | 未建档关联 ' + data.unresolved.length);
  L.push('');
  L.push('## 未建档关联');
  L.push('');
  L.push('以下关联名在设定集中尚无同名文件。这**不是缺陷**: 名称本身即为出处, 建文件后自动链接。');
  L.push('');
  for (const u of data.unresolved) {
    L.push('- ' + u.kind + '「' + u.name + '」← ' + inline(u.rel + (u.line ? ':' + u.line : '')));
  }
  L.push('');
  for (const group of [['错误', errs], ['提醒', warns], ['信息', infos]]) {
    if (!group[1].length) continue;
    L.push('## ' + group[0]);
    L.push('');
    for (const i of group[1]) {
      L.push('- ' + inline(i.rel + (i.line ? ':' + i.line : '')) + '　' + i.msg);
    }
    L.push('');
  }
  return L.join('\n');
}

/* ---------- 主流程 ---------- */

function main() {
  const data = collect();
  const errs = data.issues.filter(function (i) { return i.sev === 'error'; }).length;
  const warns = data.issues.filter(function (i) { return i.sev === 'warn'; }).length;

  console.log('设定集根目录: ' + ROOT);
  console.log('势力 ' + data.factions.length + ' / 人物 ' + data.persons.length +
    ' / 孤章 ' + data.chapters.length + ' / 文档库 ' + data.docs.length +
    ' / 装备 ' + data.weapons.length + ' / 世界观门类 ' + data.world.length);
  console.log('校验: 错误 ' + errs + ', 提醒 ' + warns + ', 信息 ' + (data.issues.length - errs - warns));

  for (const i of data.issues) {
    if (i.sev === 'error' || i.sev === 'warn') {
      console.log('  [' + i.sev + '] ' + i.rel + (i.line ? ':' + i.line : '') + ' ' + i.msg);
    }
  }

  if (data.unresolved.length) {
    console.log('未建档关联 ' + data.unresolved.length + ' 条(非缺陷, 见' + OUT_DIR + '/校验报告.md):');
    for (const u of data.unresolved) {
      console.log('  [' + u.kind + '] ' + u.name + ' ← ' + u.rel + (u.line ? ':' + u.line : ''));
    }
  }

  if (!CHECK_ONLY) {
    const outDir = path.join(ROOT, OUT_DIR);
    fs.mkdirSync(outDir, { recursive: true });
    const index = path.join(outDir, '索引.md');
    const report = path.join(outDir, '校验报告.md');
    fs.writeFileSync(index, renderIndex(data), 'utf8');
    fs.writeFileSync(report, renderIssues(data), 'utf8');
    console.log('已生成: ' + rel(index) + ', ' + rel(report));
  }

  process.exitCode = errs ? 1 : 0;
}

main();
