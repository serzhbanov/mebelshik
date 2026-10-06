const XLSX = require('xlsx');

const API_URL = 'https://viyar.ua/apiNew/products';
const CITY_ID = '67d2fa32a2f1420664e13d8a';
const BATCH_SIZE = 100;

// Читает таблицу «Расчет стоимости материалов» (xls/xlsx/csv) и возвращает строки с артикулами.
function parseSpreadsheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    const table = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    const headerIdx = table.findIndex(r => r.some(c => String(c).trim().toLowerCase() === 'артикул'));
    const header = headerIdx >= 0 ? table[headerIdx].map(c => String(c).trim().toLowerCase()) : [];
    const col = name => header.findIndex(h => h.startsWith(name));
    const cArticle = Math.max(col('артикул'), 0);
    const cName = col('наименование');
    const cNote = col('примечание');

    for (const r of table.slice(headerIdx + 1)) {
      const article = String(r[cArticle] ?? '').trim();
      if (!article) continue;
      const note = cNote >= 0 ? String(r[cNote] ?? '') : '';
      rows.push({
        article,
        name: cName >= 0 ? String(r[cName] ?? '').trim() : '',
        isViyar: cNote >= 0 ? /viyar\.ua/i.test(note) : /^\d+$/.test(article),
      });
    }
  }
  return rows;
}

async function fetchBatch(codes) {
  const url = new URL(API_URL);
  url.searchParams.set('limit', '200');
  url.searchParams.set('lang', 'uk');
  url.searchParams.set('extend_additional', 'true');
  url.searchParams.set('filter_query', JSON.stringify({ product_code: { $in: codes } }));
  url.searchParams.set('city_id', CITY_ID);
  const started = Date.now();
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    console.error(`[viyar] ${codes.length} арт. → HTTP ${res.status} ${res.statusText} (${Date.now() - started} мс)`);
    throw new Error(`viyar.ua ответил ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const items = data.items || [];
  console.log(`[viyar] запрос ${codes.length} арт. → получено ${items.length} (${Date.now() - started} мс)`);
  return items;
}

async function fetchProducts(articles) {
  const unique = [...new Set(articles.map(a => String(a).trim()).filter(Boolean))];
  const byCode = new Map();
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    for (const item of await fetchBatch(unique.slice(i, i + BATCH_SIZE))) {
      if (!byCode.has(item.product_code)) byCode.set(item.product_code, item);
    }
  }
  const products = unique.filter(a => byCode.has(a)).map(a => toMaterial(byCode.get(a)));
  const missing = unique.filter(a => !byCode.has(a));
  console.log(`[viyar] итого: найдено ${products.length} из ${unique.length}` +
    (missing.length ? `, не найдены: ${missing.join(', ')}` : ''));
  return { products, missing };
}

const UNIT_MAP = { 'м2': 'м.кв', 'м.п.': 'м.пог' };
const round2 = n => Math.round(n * 100) / 100;
const num = v => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

// Перевод товара из API Вияра в материал базы: цена пересчитывается
// в единицу с коэффициентом 1 (лист → м², шт трубы → м.п. и т.д.).
function toMaterial(item) {
  const attrs = Object.fromEntries(
    (item.product_details?.[0]?.attributes || []).map(a => [a.attribute_name, a.characteristic_value]),
  );
  const unitNames = (item.measures || []).filter(m => m.coefficient === 1).map(m => m.measure.name);
  const unitName = ['м2', 'м.п.'].find(u => unitNames.includes(u)) || unitNames[0] || item.base_measure?.name;
  const unit = UNIT_MAP[unitName] || 'шт';
  const coef = item.base_measure_coefficient || 1;

  const isEdge = attrs.furniture_type === 'KROMKA' || /кромк|крайк/i.test(item.product_title);
  let length = 0, width = 0, thickness = 0, sign = '', overhang = 0;
  if (unit === 'м.кв') {
    length = num(attrs.length_mm);
    width = num(attrs.width_mm);
    thickness = num(attrs.thickness_mm);
  } else if (isEdge) {
    // У части кромок размеры есть только в названии: «21х0,6 мм»
    const m = item.product_title.match(/(\d+(?:[.,]\d+)?)\s*[хx]\s*(\d+(?:[.,]\d+)?)\s*мм/i);
    width = num(attrs.width_mm) || (m ? num(m[1]) : 0);
    thickness = num(attrs.thickness_mm) || (m ? num(m[2]) : 0);
    sign = String(attrs['decor_code_(front)'] || '');
    overhang = 30;
  }

  return {
    article: item.product_code,
    name: item.product_title,
    group: `Вияр/${attrs.site_group || item.site_category?.name || ''}`.replace(/\/$/, ''),
    unit,
    price: round2(item.price / coef),
    length, width, thickness, sign, overhang,
    available: item.availability_status_type,
  };
}

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tag = (name, value) => (value === '' ? `<${name}/>` : `<${name}>${esc(value)}</${name}>`);

function buildXml(materials) {
  const body = materials.map(m => '<Material>' + [
    tag('Article', m.article),
    tag('Name', m.name),
    tag('Group_Name', m.group),
    tag('Unit_Measure', m.unit),
    tag('Price', m.price.toFixed(2)),
    tag('Coef', 1),
    tag('Length', m.length),
    tag('Width', m.width),
    tag('Thickness', m.thickness),
    tag('Sign', m.sign),
    tag('Overhang', m.overhang),
    tag('Color', 8369910),
    tag('Texture', `files/ph${m.article}.jpg`),
    tag('Class', ''),
    tag('Sync_External', ''),
  ].join('') + '</Material>').join('');
  return `﻿<?xml version="1.0" encoding="UTF-8"?>\n<Database><Materials>${body}</Materials></Database>\n`;
}

module.exports = { parseSpreadsheet, fetchProducts, buildXml };
