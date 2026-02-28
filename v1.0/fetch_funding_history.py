#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取 Funding Rate 历史数据并生成 ECharts 图表
"""

import requests
import json
from datetime import datetime
import os

API_URL = 'https://open-api-v4.coinglass.com/api/futures/funding-rate/history'
API_KEY = 'c156d56ebbbc40d9afe695264826efff'
EXCHANGE = 'Binance'
SYMBOL = 'BTCUSDT'
INTERVAL = '1d'
OUTPUT_FILE = 'funding.html'

def fetch_funding_data():
    headers = {
        'CG-API-KEY': API_KEY,
        'accept': 'application/json'
    }
    params = {
        'exchange': EXCHANGE,
        'symbol': SYMBOL,
        'interval': INTERVAL
    }
    try:
        response = requests.get(API_URL, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"API 请求失败: {e}")
        return None

def parse_data(data):
    dates = []
    values = []

    if not data:
        print("数据为空")
        return dates, values

    data_list = data.get('data', [])
    if not data_list:
        print("数据格式异常，尝试直接解析...")
        if isinstance(data, list):
            data_list = data
        else:
            print(f"未知数据格式: {type(data)}")
            return dates, values

    for item in data_list:
        if not isinstance(item, dict):
            continue

        time_val = item.get('time') or item.get('date') or item.get('timestamp') or item.get('t')
        if not time_val:
            continue

        rate_val = None
        for k in ['fundingRate', 'funding_rate', 'rate', 'value', 'close', 'open']:
            if k in item:
                try:
                    rate_val = float(item[k])
                    break
                except (ValueError, TypeError):
                    continue

        if rate_val is None:
            continue

        try:
            if isinstance(time_val, (int, float)):
                if time_val > 1e12:
                    time_val = time_val / 1000
                dt = datetime.fromtimestamp(time_val)
                dates.append(dt.strftime('%Y-%m-%d'))
            else:
                dates.append(str(time_val))
            values.append(rate_val)
        except (ValueError, TypeError) as e:
            print(f"解析时间失败: {time_val}, 错误: {e}")
            continue

    return dates, values

def generate_html(dates, values):
    dates_json = json.dumps(dates, ensure_ascii=False)
    values_json = json.dumps(values, ensure_ascii=False)
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    data_count = len(dates)
    latest_val = f"{values[-1]:.6f}" if values else 'N/A'
    max_val = f"{max(values):.6f}" if values else 'N/A'
    min_val = f"{min(values):.6f}" if values else 'N/A'

    html_template = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Funding Rate History - __SYMBOL__</title>
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
    <h1>__SYMBOL__ Funding Rate History</h1>
    <div class="subtitle">数据来源: Coinglass API | 更新于: __TIME__</div>
  </div>
  <div id="chart-container"></div>
  <div class="info">
    <strong>数据点数量:</strong> __COUNT__ 条 |
    <strong>最新 Funding:</strong> __LATEST__ |
    <strong>最高 Funding:</strong> __MAX__ |
    <strong>最低 Funding:</strong> __MIN__
  </div>
  <script>
    const chart = echarts.init(document.getElementById('chart-container'));
    const dates = __DATES__;
    const values = __VALUES__;
    const option = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: '#444', width: 1, type: 'dashed' } },
        formatter: function(params) {
          const item = params[0];
          return '<div style="background: rgba(21,25,36,0.95); border:1px solid #2a2e39; border-radius:6px; padding:12px 16px;">' +
                 '<div style="color:#787b86; font-size:12px; margin-bottom:8px; border-bottom:1px solid #2a2e39; padding-bottom:6px;">' + item.axisValue + '</div>' +
                 '<div style="display:flex; justify-content:space-between; align-items:center; gap:24px;">' +
                 '<span style="color:#787b86;">Funding Rate</span>' +
                 '<span style="font-family:monospace; font-weight:600; font-size:14px; color:#fff;">' + item.value.toFixed(6) + '</span>' +
                 '</div></div>';
        }
      },
      legend: { data:['Funding Rate'], textStyle:{ color:'#787b86', fontSize:12 }, top:10 },
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
      yAxis: { type:'value', scale:true, position:'right', splitLine:{ lineStyle:{ color:'#2a2e39', type:'dashed' } },
        axisLabel:{ color:'#787b86', formatter:function(value){ return value.toFixed(4); } }
      },
      series: [
        { name:'Funding Rate', type:'line', data:values, smooth:false, symbol:'none',
          lineStyle:{ color:'#f8cb46', width:2 },
          areaStyle:{ color:new echarts.graphic.LinearGradient(0,0,0,1,[{ offset:0, color:'rgba(248,203,70,0.35)' },{ offset:1, color:'rgba(248,203,70,0)' }]) },
          emphasis:{ focus:'series' }
        }
      ]
    };
    chart.setOption(option);
    window.addEventListener('resize', function(){ chart.resize(); });
  </script>
</body>
</html>
"""

    html_content = (html_template
                    .replace("__SYMBOL__", SYMBOL)
                    .replace("__TIME__", current_time)
                    .replace("__COUNT__", str(data_count))
                    .replace("__LATEST__", latest_val)
                    .replace("__MAX__", max_val)
                    .replace("__MIN__", min_val)
                    .replace("__DATES__", dates_json)
                    .replace("__VALUES__", values_json))
    return html_content

def main():
    print(f"正在获取 {SYMBOL} Funding Rate 历史数据...")

    data = fetch_funding_data()
    if not data:
        print("获取数据失败")
        return

    print("数据获取成功，正在解析...")
    print(f"原始数据结构: {list(data.keys()) if isinstance(data, dict) else type(data)}")

    dates, values = parse_data(data)
    if not dates or not values:
        print("数据解析失败，原始数据:")
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    print(f"解析成功: {len(dates)} 条数据")
    print(f"日期范围: {dates[0]} 至 {dates[-1]}")
    print(f"Funding 范围: {min(values):.6f} 至 {max(values):.6f}")

    output_path = os.path.join(os.path.dirname(__file__), OUTPUT_FILE)
    print(f"正在生成 HTML 文件: {output_path}")

    html_content = generate_html(dates, values)
    try:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
        print(f"完成！图表已保存到: {output_path}")
        print(f"绝对路径: {os.path.abspath(output_path)}")
    except Exception as e:
        print(f"保存文件失败: {e}")

if __name__ == '__main__':
    main()

