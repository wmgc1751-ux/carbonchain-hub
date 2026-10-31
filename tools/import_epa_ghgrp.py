#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
import_epa_ghgrp.py —— 导入 EPA 温室气体报告计划（GHGRP）真实企业排放数据
==================================================================================
【这是整个平台唯一真正的"企业级真实数据"来源】

EPA GHGRP（Greenhouse Gas Reporting Program）是美国环保署的强制排放报告制度，
按《清洁空气法》第 98 部分（40 CFR Part 98）要求年排放 ≥25,000 tCO2e 的设施
逐年报告排放数据，并**全部向社会公开**。

数据规模：每年约 8,000 家直接排放设施 + 数千家供应商，含
  · 设施名称、地址、经纬度、NAICS 行业码
  · 分气体排放（CO2 / CH4 / N2O / HFC / PFC / SF6 / NF3）
  · **分行业工艺排放明细**（水泥生产、钢铁生产、铝生产、发电、炼油…）
  · 生物质 CO2 单独列示

这正是平台需要的"真实企业 + 真实排放 + 真实行业分类"。

【与平台原有合成数据的对应关系】
| EPA 字段                    | 平台字段              | 说明 |
|-----------------------------|-----------------------|------|
| Facility Name               | enterprise.ent_name   | 真实设施名 |
| Facility Id                 | enterprise.ent_code   | 用 EPA-{id} 形式，可回溯 |
| Industry Type (sectors)     | enterprise.industry   | 映射到平台 7 行业 |
| State                       | enterprise.region     | 真实所在州 |
| Latitude / Longitude        | enterprise 扩展字段    | 真实坐标 |
| Total reported direct emissions | emission_report    | **真实排放量** |
| Cement Production 等分项     | emission_item          | **真实工艺明细** |

【数据使用声明 —— 必须随数据一起输出】
  本数据来自美国环保署 GHGRP 公开数据集（Public Domain），
  **不是中国企业数据**。平台使用它是为了：
    ① 提供真实的、可核查的企业级排放样本，使核算引擎在真实量级上被检验；
    ② 让"零知识证明 / 不确定度 / 配额缺口"等能力在真实分布上运行；
  平台**不声称**这些企业是中国控排企业。

【用法】
  python tools/import_epa_ghgrp.py --year 2018
  python tools/import_epa_ghgrp.py --year 2018 --limit 200
"""

import argparse
import json
import os
import sys
from datetime import datetime

try:
    import openpyxl
except ImportError:
    print('✘ 需要 openpyxl：pip install openpyxl', file=sys.stderr)
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EPA_DIR = os.path.join(ROOT, '.cache', 'realdata', 'epa')
OUT_DIR = os.path.join(ROOT, 'tools', 'out')

# ---------------------------------------------------------------- 行业映射
# EPA 的 sector 字段是**逗号分隔的多值**（如 "Pulp and Paper,Waste"、
# "Chemicals,Petroleum Product Suppliers,Refineries"），
# 因此必须拆开逐项匹配，并按优先级取第一个能映射的。
#
# ⚠ 这个细节当初漏掉过：直接拿整串去字典里查，导致
#   多值 sector 全部落空 —— 表现为"石化/有色金属 0 家"，
#   而实际 EPA 里炼油厂有 68+40+8 家、金属冶炼有 287 家。
SECTOR_RULES = [
    # (匹配关键词, 平台行业, 优先级)  —— 优先级小的先匹配
    ('power plants', '电力', 10),
    ('refineries', '石化', 20),
    ('petroleum and natural gas systems', '石化', 30),
    ('petroleum product suppliers', '石化', 40),
    ('cement', '建材', 10),
    ('minerals', '建材', 50),
    ('iron and steel', '钢铁', 10),
    ('metals', '钢铁', 50),          # 有色金属并入钢材类（EPA 的 Metals 含铝/铜/铅/镁）
    ('chemicals', '化工', 10),
    ('pulp and paper', '造纸', 10),
    ('waste', None, 999),            # 不纳入
    ('other', None, 999),
]

# 分行业工艺排放列（用于生成 emission_item 真实明细）
PROCESS_COLS = {
    'Stationary Combustion': '固定源燃烧',
    'Electricity Generation': '发电',
    'Aluminum Production': '电解铝',
    'Cement Production': '水泥熟料',
    'Iron and Steel Production': '钢铁冶炼',
    'Ammonia Manufacturing': '合成氨',
    'Hydrogen Production': '制氢',
    'Lime Production': '石灰',
    'Nitric Acid Production': '硝酸',
    'Petroleum and Natural Gas Systems – Processing': '油气加工',
}

# 平台行业 → 该行业应关注的工艺列（用于校验"分项是否齐全"）
INDUSTRY_PROCESS = {
    '建材': ['Cement Production', 'Lime Production'],
    '钢铁': ['Iron and Steel Production'],
    '化工': ['Ammonia Manufacturing', 'Nitric Acid Production'],
    '电力': ['Electricity Generation'],
    '石化': ['Petroleum and Natural Gas Systems – Processing'],
    '造纸': ['Stationary Combustion'],
}


def map_sector(raw):
    """把 EPA 的多值 sector 串映射到平台行业；无法映射返回 None（跳过）"""
    s = str(raw or '').lower()
    if not s:
        return None
    parts = [p.strip() for p in s.split(',') if p.strip()]
    # 逐个规则匹配，取优先级最小的命中
    best = None
    best_pri = 1e9
    for kw, ind, pri in SECTOR_RULES:
        if any(kw in p for p in parts):
            if pri < best_pri:
                best_pri = pri
                best = ind
    return best


def num(v):
    """把单元格转成 float；空/None/非数字返回 None"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(',', '').strip())
    except (ValueError, AttributeError):
        return None


def load_year(year, limit=None):
    """读取某年度 GHGRP 数据，返回统一结构的 dict 列表"""
    path = os.path.join(EPA_DIR, 'ghgp_data_%d.xlsx' % year)
    if not os.path.exists(path):
        raise FileNotFoundError('缺少数据文件：%s（请先下载并解压 EPA ZIP）' % path)
    if os.path.getsize(path) == 0:
        raise ValueError('数据文件为空：%s（该年度可能未随 ZIP 提供）' % path)

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = 'Direct Point Emitters'
    if sheet not in wb.sheetnames:
        sheet = wb.sheetnames[0]
    ws = wb[sheet]

    rows = ws.iter_rows(min_row=1, values_only=True)
    header = None
    for r in rows:
        if r and r[0] == 'Facility Id':
            header = list(r)
            break
    if not header:
        wb.close()
        raise ValueError('未找到表头行（Facility Id）')

    idx = {}
    for i, h in enumerate(header):
        if h:
            idx[str(h).strip()] = i

    def col(row, name):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else None

    out = []
    for r in rows:
        if not r or r[0] is None:
            continue
        total = num(col(r, 'Total reported direct emissions'))
        if total is None or total <= 0:
            continue
        sector = col(r, 'Industry Type (sectors)')
        sector = str(sector).strip() if sector else ''
        industry = map_sector(sector)
        if industry is None:
            continue  # 非控排行业，跳过

        processes = []
        for cname, cn in PROCESS_COLS.items():
            v = num(col(r, cname))
            if v is not None and v > 0:
                processes.append({'name': cname, 'nameCn': cn, 'emission': round(v, 3)})

        rec = {
            'facilityId': str(int(num(col(r, 'Facility Id')) or 0)),
            'frsId': (str(col(r, 'FRS Id')) if col(r, 'FRS Id') else None),
            'name': str(col(r, 'Facility Name') or '').strip(),
            'city': (str(col(r, 'City')).strip() if col(r, 'City') else None),
            'state': (str(col(r, 'State')).strip() if col(r, 'State') else None),
            'zip': (str(col(r, 'Zip Code')).strip() if col(r, 'Zip Code') else None),
            'county': (str(col(r, 'County')).strip() if col(r, 'County') else None),
            'lat': num(col(r, 'Latitude')),
            'lon': num(col(r, 'Longitude')),
            'naics': (str(col(r, 'Primary NAICS Code')).strip() if col(r, 'Primary NAICS Code') else None),
            'sector': sector,
            'industry': industry,
            'total': round(total, 3),
            'co2': num(col(r, 'CO2 emissions (non-biogenic)')),
            'ch4': num(col(r, 'Methane (CH4) emissions')),
            'n2o': num(col(r, 'Nitrous Oxide (N2O) emissions')),
            'biogenic': num(col(r, 'Biogenic CO2 emissions (metric tons)')),
            'processes': processes,
            'year': int(year),
        }
        out.append(rec)

    wb.close()
    out.sort(key=lambda x: -x['total'])
    if limit:
        out = out[:limit]
    return out


def summarize(records, year):
    """生成导入摘要（用于写库前的自检与报告）"""
    by_ind = {}
    for r in records:
        by_ind.setdefault(r['industry'], {'count': 0, 'total': 0.0})
        by_ind[r['industry']]['count'] += 1
        by_ind[r['industry']]['total'] += r['total']
    states = {}
    for r in records:
        if r['state']:
            states[r['state']] = states.get(r['state'], 0) + 1
    return {
        'year': year,
        'facilities': len(records),
        'totalEmission': round(sum(r['total'] for r in records), 1),
        'byIndustry': {k: {'count': v['count'], 'total': round(v['total'], 1)}
                       for k, v in sorted(by_ind.items(), key=lambda x: -x[1]['total'])},
        'topStates': sorted(states.items(), key=lambda x: -x[1])[:10],
        'withProcessDetail': sum(1 for r in records if r['processes']),
        'withCoords': sum(1 for r in records if r['lat'] is not None and r['lon'] is not None),
    }


def main():
    ap = argparse.ArgumentParser(description='导入 EPA GHGRP 真实企业排放数据')
    ap.add_argument('--year', type=int, default=2018, help='数据年度（2010-2018 可用）')
    ap.add_argument('--limit', type=int, default=None, help='只取排放量前 N 家')
    ap.add_argument('--out', default=None, help='输出 JSON 路径')
    args = ap.parse_args()

    print('═' * 76)
    print('EPA GHGRP 真实企业排放数据导入 · %d 年度' % args.year)
    print('═' * 76)

    recs = load_year(args.year, args.limit)
    s = summarize(recs, args.year)

    print('\n数据源：US EPA Greenhouse Gas Reporting Program（40 CFR Part 98）')
    print('许可：Public Domain（美国政府公开数据）')
    print('说明：这是**美国**企业的真实排放数据，不是中国企业数据\n')
    print('  设施数        %d 家' % s['facilities'])
    print('  排放总量      %s tCO2e' % format(s['totalEmission'], ',.0f'))
    print('  含坐标        %d 家' % s['withCoords'])
    print('  含工艺明细    %d 家' % s['withProcessDetail'])
    print('\n  分行业：')
    for k, v in s['byIndustry'].items():
        print('    %-8s %4d 家   %s t' % (k, v['count'], format(v['total'], ',.0f')))
    print('\n  排放量前 5 家：')
    for r in recs[:5]:
        print('    %-38s %-6s %12s t' % (r['name'][:36], r['state'] or '', format(r['total'], ',.0f')))

    os.makedirs(OUT_DIR, exist_ok=True)
    out = args.out or os.path.join(OUT_DIR, 'epa-ghgrp-%d.json' % args.year)
    payload = {
        'source': {
            'name': 'US EPA Greenhouse Gas Reporting Program (GHGRP)',
            'regulation': '40 CFR Part 98',
            'url': 'https://www.epa.gov/ghgreporting/data-sets',
            'license': 'Public Domain',
            'real': True,
            'region': 'United States',
            'note': '美国企业真实排放数据，非中国企业。用于在真实量级上检验核算引擎与零知识证明。',
        },
        'generatedAt': datetime.now().isoformat(),
        'summary': s,
        'records': recs,
    }
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print('\n已写出：%s（%.1f MB）' % (out, os.path.getsize(out) / 1048576))
    print('═' * 76)


if __name__ == '__main__':
    main()
