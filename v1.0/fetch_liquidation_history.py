#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取 Liquidation 历史数据并生成 ECharts 图表
"""

import requests
import json
from datetime import datetime
import os

API_URL = 'https://open-api-v4.coinglass.com/api/futures/liquidation/exchange-list'
API_KEY = 'c156d56ebbbc40d9afe695264826efff'
OUTPUT_FILE = 'liquidation.html'
RANGE = '1d'
TARGET_EXCHANGES = ['All', 'Binance', 'OKX', 'Bybit', 'Hyperliquid', 'Bitget']

def fetch_liquidation_data():
    headers = {
        'CG-API-KEY': API_KEY,
        'accept': 'application/json'
    }
    params = {
        'range': RANGE
    }
    try:
        response = requests.get(API_URL, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"API 请求失败: {e}")
        return None

def parse_data(data):
    exchanges = []
    totals = []
    long_vals = []
    short_vals = []

    if not data:
        print("数据为空")
        return exchanges, totals, long_vals, short_vals

    data_list = data.get('data', [])
    if not data_list:
        print("数据格式异常，尝试直接解析...")
        if isinstance(data, list):
            data_list = data
        else:
            print(f"未知数据格式: {type(data)}")
            return exchanges, totals, long_vals, short_vals

    for item in data_list:
        if not isinstance(item, dict):
            continue
        try:
            ex = item.get('exchange')
            if ex not in TARGET_EXCHANGES:
                continue
            total_liq = float(item.get('liquidation_usd', 0))
            long_liq = float(item.get('longLiquidation_usd', item.get('long_liquidation_usd', 0)))
            short_liq = float(item.get('shortLiquidation_usd', item.get('short_liquidation_usd', 0)))
        except (ValueError, TypeError):
            continue

        exchanges.append(ex)
        totals.append(total_liq)
        long_vals.append(long_liq)
        short_vals.append(short_liq)

    ordered = []
    for name in TARGET_EXCHANGES:
        if name in exchanges:
            idx = exchanges.index(name)
            ordered.append((exchanges[idx], totals[idx], long_vals[idx], short_vals[idx]))

    ordered.sort(key=lambda x: x[1], reverse=True)
    exchanges = [x[0] for x in ordered]
    totals = [x[1] for x in ordered]
    long_vals = [x[2] for x in ordered]
    short_vals = [x[3] for x in ordered]

    return exchanges, totals, long_vals, short_vals

def generate_html(exchanges, totals, long_vals, short_vals):
    exchanges_json = json.dumps(exchanges, ensure_ascii=False)
    total_json = json.dumps(totals, ensure_ascii=False)
    long_json = json.dumps(long_vals, ensure_ascii=False)
    short_json = json.dumps(short_vals, ensure_ascii=False)
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    data_count = len(exchanges)
    max_total = f"{max(totals):,.0f}" if totals else 'N/A'

    html_template = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Liquidation by Exchange</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#121826; color:#d1d4dc; font-family:-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif; padding:24px; }
    .header { margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid #2a2e39; }
    h1 { color:#fff; font-size:24px; font-weight:600; margin-bottom:8px; }
    .subtitle { color:#787b86; font-size:14px; }
    #chart-container { width:100%; height:70vh; min-height:520px; background:#151924; border-radius:12px; padding:16px; box-shadow:0 14px 34px rgba(0,0,0,0.42); }
    .info { margin-top:16px; padding:12px; background:#151924; border-radius:8px; border:1px solid #2a2e39; font-size:12px; color:#787b86; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Liquidation by Exchange</h1>
    <div class="subtitle">数据来源: Coinglass API | 更新于: __TIME__ | Range: __RANGE__</div>
  </div>
  <div id="chart-container"></div>
  <div class="info">
    <strong>数据点数量:</strong> __COUNT__ 条 |
    <strong>最大总清算:</strong> __MAX_TOTAL__
  </div>
  <script>
    const chart = echarts.init(document.getElementById('chart-container'));
    const exchanges = __EXCHANGES__;
    const longVals = __LONGS__;
    const shortVals = __SHORTS__;
    function formatNumber(value) {
      const v = Math.abs(value || 0);
      if (v >= 1e9) return (value / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (value / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (value / 1e3).toFixed(2) + 'K';
      return (value || 0).toLocaleString();
    }
    const option = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: function(params) {
          const name = params[0].axisValue;
          const longItem = params.find(p => p.seriesName === 'Long') || { value: 0 };
          const shortItem = params.find(p => p.seriesName === 'Short') || { value: 0 };
          const longV = longItem.value || 0;
          const shortV = shortItem.value || 0;
          const total = longV + shortV;
          return '<div style="background: rgba(21,25,36,0.95); border:1px solid #2a2e39; border-radius:6px; padding:12px 16px;">' +
                 '<div style="color:#787b86; font-size:12px; margin-bottom:8px; border-bottom:1px solid #2a2e39; padding-bottom:6px;">' + name + '</div>' +
                 '<div style="display:flex; justify-content:space-between; gap:24px;"><span style="color:#26a69a;">Long</span><span style="color:#fff;">' + formatNumber(longV) + '</span></div>' +
                 '<div style="display:flex; justify-content:space-between; gap:24px;"><span style="color:#f23645;">Short</span><span style="color:#fff;">' + formatNumber(shortV) + '</span></div>' +
                 '<div style="display:flex; justify-content:space-between; gap:24px;"><span style="color:#787b86;">Total</span><span style="color:#fff;">' + formatNumber(total) + '</span></div>' +
                 '</div>';
        }
      },
      legend: { data:['Long','Short'], textStyle:{ color:'#787b86', fontSize:12 }, top:10, selectedMode:true },
      grid: { left:'3%', right:'4%', bottom:'8%', top:'15%', containLabel:true },
      xAxis: { type:'value', scale:true, axisLine:{ show:false }, axisTick:{ show:false }, splitLine:{ lineStyle:{ color:'#2a2e39', type:'dashed' } },
        axisLabel:{ color:'#787b86', formatter:function(value){ if(value>=1e9) return (value/1e9).toFixed(2)+'B'; if(value>=1e6) return (value/1e6).toFixed(2)+'M'; if(value>=1e3) return (value/1e3).toFixed(2)+'K'; return value.toLocaleString(); } }
      },
      yAxis: { type:'category', data:exchanges, inverse:true, axisLine:{ show:false }, axisTick:{ show:false }, axisLabel:{ color:'#787b86' } },
      series: [
        { name:'Long', type:'bar', stack:'total', data:longVals, barWidth:18, barMinHeight:2, itemStyle:{ color:'#26a69a', opacity:0.9 }, emphasis:{ focus:'series' } },
        { name:'Short', type:'bar', stack:'total', data:shortVals, barWidth:18, barMinHeight:2, itemStyle:{ color:'#f23645', opacity:0.9 }, emphasis:{ focus:'series' } }
      ]
    };
    chart.setOption(option);
    window.addEventListener('resize', function(){ chart.resize(); });
  </script>
</body>
</html>
"""

    html_content = (html_template
                    .replace("__TIME__", current_time)
                    .replace("__COUNT__", str(data_count))
                    .replace("__MAX_TOTAL__", max_total)
                    .replace("__RANGE__", RANGE)
                    .replace("__EXCHANGES__", exchanges_json)
                    .replace("__LONGS__", long_json)
                    .replace("__SHORTS__", short_json))
    return html_content

def main():
    print("正在获取 Liquidation 交易所分布数据...")

    data = fetch_liquidation_data()
    if not data:
        print("获取数据失败")
        return

    print("数据获取成功，正在解析...")
    print(f"原始数据结构: {list(data.keys()) if isinstance(data, dict) else type(data)}")

    exchanges, totals, long_vals, short_vals = parse_data(data)
    if not exchanges:
        print("数据解析失败，原始数据:")
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    print(f"解析成功: {len(exchanges)} 条交易所数据")
    print(f"交易所: {', '.join(exchanges)}")

    output_path = os.path.join(os.path.dirname(__file__), OUTPUT_FILE)
    print(f"正在生成 HTML 文件: {output_path}")

    html_content = generate_html(exchanges, totals, long_vals, short_vals)
    try:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
        print(f"完成！图表已保存到: {output_path}")
        print(f"绝对路径: {os.path.abspath(output_path)}")
    except Exception as e:
        print(f"保存文件失败: {e}")

if __name__ == '__main__':
    main()

