#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取 ETF Flow 历史数据并生成 ECharts 图表（IBIT/FBTC/ARKB）
"""

import requests
import json
from datetime import datetime
import os

API_KEY = 'c156d56ebbbc40d9afe695264826efff'
OUTPUT_FILE = 'etf_flow_history.html'
SYMBOLS = {
    'BTC': 'https://open-api-v4.coinglass.com/api/etf/bitcoin/flow-history',
    'ETH': 'https://open-api-v4.coinglass.com/api/etf/ethereum/flow-history',
    'SOL': 'https://open-api-v4.coinglass.com/api/etf/solana/flow-history',
    'XRP': 'https://open-api-v4.coinglass.com/api/etf/xrp/flow-history',
}
SYMBOL_TICKERS = {
    'BTC': ['IBIT', 'FBTC', 'ARKB', 'GBTC'],
    'ETH': ['ETHA', 'FETH', 'ETHW'],
    'SOL': ['BSOL', 'VSOL', 'FSOL'],
    'XRP': [],
}

def fetch_etf_flow_data(api_url):
    headers = {
        'CG-API-KEY': API_KEY,
        'accept': 'application/json'
    }
    try:
        response = requests.get(api_url, headers=headers, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"API 请求失败: {e}")
        return None

def parse_data(data, tickers):
    dates = []
    total_flows = []
    detail = {t: [] for t in tickers}
    others = []

    if not data:
        print("数据为空")
        return dates, total_flows, detail, others

    data_list = data.get('data', [])
    if not data_list:
        print("数据格式异常")
        return dates, total_flows, detail, others

    for item in data_list:
        if not isinstance(item, dict):
            continue
        ts = item.get('timestamp')
        if not ts:
            continue
        try:
            if ts > 1e12:
                ts = ts / 1000
            dt = datetime.fromtimestamp(ts)
            dates.append(dt.strftime('%Y-%m-%d'))
        except (ValueError, TypeError):
            continue

        flows = item.get('etf_flows', [])
        flow_map = {}
        for f in flows:
            if not isinstance(f, dict):
                continue
            ticker = f.get('etf_ticker')
            if not ticker:
                continue
            flow_map[ticker] = float(f.get('flow_usd', 0) or 0)

        day_total = sum(flow_map.values())
        tracked_sum = 0
        for t in tickers:
            v = flow_map.get(t, 0)
            detail[t].append(v)
            tracked_sum += v
        others.append(day_total - tracked_sum)
        total_flows.append(day_total)

    return dates, total_flows, detail, others

def generate_html(data_by_symbol):
    default_symbol = 'BTC'
    if default_symbol not in data_by_symbol:
        default_symbol = list(data_by_symbol.keys())[0]

    data_json = json.dumps(data_by_symbol, ensure_ascii=False)
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    data_count = len(data_by_symbol.get(default_symbol, {}).get('dates', []))

    html_template = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ETF Flow History</title>
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
    <h1>ETF Total Flow (IBIT / FBTC / ARKB / GBTC)</h1>
    <div class="subtitle">数据来源: Coinglass API | 更新于: __TIME__</div>
  </div>
  <div style="margin:0 0 12px 0;">
    <select id="symbol-select" style="background:#151924; color:#d1d4dc; border:1px solid #2a2e39; border-radius:6px; padding:6px 8px;">
      <option value="BTC">BTC</option>
      <option value="ETH">ETH</option>
      <option value="SOL">SOL</option>
      <option value="XRP">XRP</option>
    </select>
  </div>
  <div id="chart-container"></div>
  <div class="info">
    <strong>数据点数量:</strong> __COUNT__ 条
  </div>
  <script>
    const chart = echarts.init(document.getElementById('chart-container'));
    const dataBySymbol = __DATA__;
    const selectEl = document.getElementById('symbol-select');
    function formatNumber(value) {
      const v = Math.abs(value || 0);
      if (v >= 1e9) return (value / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (value / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (value / 1e3).toFixed(2) + 'K';
      return (value || 0).toLocaleString();
    }
    function getSymbolData(sym) {
      return dataBySymbol[sym] || { dates: [], total: [], detail: {}, others: [], tickers: [] };
    }
    let currentSymbol = '__DEFAULT__';
    selectEl.value = currentSymbol;
    function applyOption() {
      const d = getSymbolData(currentSymbol);
      const dates = d.dates || [];
      const totalFlows = d.total || [];
      const detail = d.detail || {};
      const tickers = d.tickers || [];
      const others = d.others || [];
    const option = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: function(params) {
          let html = '<div style="background: rgba(21,25,36,0.95); border:1px solid #2a2e39; border-radius:6px; padding:12px 16px;">';
          html += '<div style="color:#787b86; font-size:12px; margin-bottom:8px; border-bottom:1px solid #2a2e39; padding-bottom:6px;">' + params[0].axisValue + '</div>';
          const v = params[0].value || 0;
          const color = v >= 0 ? '#26a69a' : '#f23645';
          html += '<div style="display:flex; justify-content:space-between; gap:24px;"><span style="color:#787b86;">Total Flow</span><span style="color:' + color + '; font-family:monospace;">' + formatNumber(v) + '</span></div>';
          const idx = params[0].dataIndex;
          tickers.forEach(function(tk) {
            const rv = (detail[tk] || [])[idx] || 0;
            const rc = rv >= 0 ? '#26a69a' : '#f23645';
            html += '<div style="display:flex; justify-content:space-between; gap:24px;"><span style="color:#787b86;">' + tk + '</span><span style="color:' + rc + '; font-family:monospace;">' + formatNumber(rv) + '</span></div>';
          });
          const otherVal = others[idx] || 0;
          const otherColor = otherVal >= 0 ? '#26a69a' : '#f23645';
          html += '<div style="display:flex; justify-content:space-between; gap:24px;"><span style="color:#787b86;">OTHERS</span><span style="color:' + otherColor + '; font-family:monospace;">' + formatNumber(otherVal) + '</span></div>';
          html += '</div>';
          return html;
        }
      },
      legend: { show:false },
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
        axisLabel:{ color:'#787b86', formatter:function(value){ return formatNumber(value); } }
      },
      series: [
        { name:'Total Flow', type:'bar', data:totalFlows, barWidth:2,
          itemStyle:{ color:function(p){ return (p.value || 0) >= 0 ? '#26a69a' : '#f23645'; } }
        }
      ]
    };
    chart.setOption(option, { notMerge: true, lazyUpdate: false });
    }
    applyOption();
    selectEl.addEventListener('change', function() {
      currentSymbol = selectEl.value;
      applyOption();
    });
    window.addEventListener('resize', function(){ chart.resize(); });
  </script>
</body>
</html>
"""

    html_content = (html_template
                    .replace("__TIME__", current_time)
                    .replace("__COUNT__", str(data_count))
                    .replace("__DATA__", data_json)
                    .replace("__DEFAULT__", default_symbol))
    return html_content

def main():
    print("正在获取 ETF Flow 历史数据...")
    data_by_symbol = {}
    for sym, url in SYMBOLS.items():
        print(f"拉取 {sym} ...")
        data = fetch_etf_flow_data(url)
        if not data:
            print(f"{sym} 获取失败")
            continue
        tickers = SYMBOL_TICKERS.get(sym, [])
        dates, total_flows, detail, others = parse_data(data, tickers)
        if not dates:
            print(f"{sym} 数据解析失败")
            continue
        data_by_symbol[sym] = {
            'dates': dates,
            'total': total_flows,
            'detail': detail,
            'others': others,
            'tickers': tickers,
        }
    if not data_by_symbol:
        print("全部标的数据获取失败")
        return
    output_path = os.path.join(os.path.dirname(__file__), OUTPUT_FILE)
    print(f"正在生成 HTML 文件: {output_path}")

    html_content = generate_html(data_by_symbol)
    try:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
        print(f"完成！图表已保存到: {output_path}")
        print(f"绝对路径: {os.path.abspath(output_path)}")
    except Exception as e:
        print(f"保存文件失败: {e}")

if __name__ == '__main__':
    main()

