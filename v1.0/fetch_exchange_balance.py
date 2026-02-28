#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取 Exchange Balance 并生成 ECharts 图表（Binance/OKX/Bybit/Bitget/Others）
"""

import requests
import json
from datetime import datetime
import os

API_URL = 'https://open-api-v4.coinglass.com/api/exchange/balance/chart'
API_KEY = 'c156d56ebbbc40d9afe695264826efff'
SYMBOL = 'BTC'
OUTPUT_FILE = 'exchange_balance.html'

TARGET_EXCHANGES = ['Binance', 'OKX', 'Bybit']

def fetch_balance_data():
    headers = {
        'CG-API-KEY': API_KEY,
        'accept': 'application/json'
    }
    params = {'symbol': SYMBOL}
    try:
        response = requests.get(API_URL, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"API 请求失败: {e}")
        return None

def parse_data(data):
    if not data or 'data' not in data:
        print("数据为空或格式异常")
        return [], [], []

    payload = data.get('data', {})
    time_list = payload.get('time_list', [])
    price_list = payload.get('price_list', [])
    data_map = payload.get('data_map', {})

    if not time_list or not data_map:
        print("缺少 time_list 或 data_map")
        return [], [], []

    all_exchanges = list(data_map.keys())
    print(f"全量交易所 ({len(all_exchanges)}): {', '.join(all_exchanges)}")

    dates = []
    for ts in time_list:
        try:
            t = ts / 1000 if ts > 1e12 else ts
            dates.append(datetime.fromtimestamp(t).strftime('%Y-%m-%d'))
        except Exception:
            dates.append(str(ts))

    total = [0] * len(time_list)
    for ex, arr in data_map.items():
        if not isinstance(arr, list):
            continue
        vals = [float(x or 0) for x in arr]
        if len(vals) != len(total):
            vals = (vals + [0] * len(total))[:len(total)]
        for i, v in enumerate(vals):
            total[i] += v

    prices = [float(x or 0) for x in price_list] if isinstance(price_list, list) else []
    if len(prices) != len(total):
        prices = (prices + [0] * len(total))[:len(total)]

    return dates, total, prices

def generate_html(dates, total, prices):
    dates_json = json.dumps(dates, ensure_ascii=False)
    total_json = json.dumps(total, ensure_ascii=False)
    price_json = json.dumps(prices, ensure_ascii=False)
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    data_count = len(dates)

    html_template = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Exchange Balance - __SYMBOL__</title>
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
    <h1>Exchange Balance - __SYMBOL__</h1>
    <div class="subtitle">数据来源: Coinglass API | 更新于: __TIME__</div>
  </div>
  <div id="chart-container"></div>
  <div class="info">
    <strong>数据点数量:</strong> __COUNT__ 条
  </div>
  <script>
    const chart = echarts.init(document.getElementById('chart-container'));
    const dates = __DATES__;
    const total = __TOTAL__;
    const prices = __PRICES__;
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
        axisPointer: { type: 'cross', lineStyle: { color: '#444', width: 1, type: 'dashed' } },
        formatter: function(params) {
          let html = '<div style="background: rgba(21,25,36,0.95); border:1px solid #2a2e39; border-radius:6px; padding:12px 16px;">';
          html += '<div style="color:#787b86; font-size:12px; margin-bottom:8px; border-bottom:1px solid #2a2e39; padding-bottom:6px;">' + params[0].axisValue + '</div>';
          params.forEach(function(p) {
            const val = p.seriesType === 'line' ? p.value.toLocaleString() : formatNumber(p.value);
            html += '<div style="display:flex; justify-content:space-between; gap:24px;"><span style="color:#787b86;">' + p.seriesName + '</span><span style="color:#fff; font-family:monospace;">' + val + '</span></div>';
          });
          html += '</div>';
          return html;
        }
      },
      legend: {
        data:['Total Balance','Price'],
        top:10,
        icon:'rect',
        itemWidth:10,
        itemHeight:10,
        textStyle:{ color:'#787b86', fontSize:12 }
      },
      grid: { left:'3%', right:'4%', bottom:'10%', top:'15%', containLabel:true },
      dataZoom: [
        { type:'inside', start:0, end:100 },
        { type:'slider', start:0, end:100, bottom:'2%', height:24, borderColor:'transparent', backgroundColor:'#151924',
          fillerColor:'rgba(41,98,255,0.1)', dataBackground:{ lineStyle:{ color:'#2a2e39', width:1 }, areaStyle:{ color:'#2a2e39', opacity:0.2 } },
          selectedDataBackground:{ lineStyle:{ color:'#2962ff', width:1 }, areaStyle:{ color:'#2962ff', opacity:0.2 } },
          handleStyle:{ color:'#d1d4dc', borderColor:'#151924' }, textStyle:{ color:'#787b86' }
        }
      ],
      xAxis: { type:'category', data:dates, boundaryGap:false, axisLine:{ show:false }, axisTick:{ show:false }, axisLabel:{ color:'#787b86', margin:12, rotate:45 }, splitLine:{ show:false } },
      yAxis: [
        { type:'value', scale:true, position:'right', splitLine:{ lineStyle:{ color:'#2a2e39', type:'dashed' } },
          axisLabel:{ color:'#787b86', formatter:function(value){ return formatNumber(value); } }
        },
        { type:'value', scale:true, position:'left', splitLine:{ show:false },
          axisLabel:{ color:'#787b86', formatter:function(value){ return value.toLocaleString(); } }
        }
      ],
      series: [
        { name:'Total Balance', type:'line', data:total, symbol:'none', lineStyle:{ color:'#f8cb46', width:2 } },
        { name:'Price', type:'line', data:prices, yAxisIndex:1, symbol:'none', lineStyle:{ color:'#2962ff', width:2 } }
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
                    .replace("__SYMBOL__", SYMBOL)
                    .replace("__DATES__", dates_json)
                    .replace("__TOTAL__", total_json)
                    .replace("__PRICES__", price_json))
    return html_content

def main():
    print("正在获取 Exchange Balance 数据...")
    data = fetch_balance_data()
    if not data:
        print("获取数据失败")
        return

    print("数据获取成功，正在解析...")
    dates, total, prices = parse_data(data)
    if not dates:
        print("数据解析失败，原始数据:")
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    output_path = os.path.join(os.path.dirname(__file__), OUTPUT_FILE)
    print(f"正在生成 HTML 文件: {output_path}")
    html_content = generate_html(dates, total, prices)
    try:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
        print(f"完成！图表已保存到: {output_path}")
        print(f"绝对路径: {os.path.abspath(output_path)}")
    except Exception as e:
        print(f"保存文件失败: {e}")

if __name__ == '__main__':
    main()

