#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import datetime as dt
import json
import os
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

# 静默本机 LibreSSL + urllib3 v2 的兼容性警告（不影响 webhook POST，只会污染控制台输出）
warnings.filterwarnings("ignore", message=r"urllib3 v2 only supports OpenSSL.*")

import requests

Number = Union[int, float]


# -----------------------------
# Formatting helpers
# -----------------------------
def _fmt_num(x: Optional[Number], digits: int = 2) -> str:
    if x is None:
        return "-"
    if isinstance(x, float) and not x.is_integer():
        return f"{x:,.{digits}f}"
    return f"{int(x):,}"


def _fmt_pct(x: Optional[Number], digits: int = 2, signed: bool = True) -> str:
    """输入为“百分比数值”，例如 2.52 -> '＋2.52%'."""
    if x is None:
        return "-"
    s = f"{x:.{digits}f}%"
    if signed and x > 0:
        s = f"+{s}"
    return s


def _pad_right(s: str, width: int) -> str:
    return s + " " * max(0, width - len(s))


def _as_codeblock(lines: List[str], lang: str = "") -> str:
    body = "\n".join(lines).rstrip("\n")
    return f"```{lang}\n{body}\n```"



def _iso_utc_now() -> str:
    # Discord 对 timestamp 的解析更偏好 RFC3339 的 Z 结尾格式
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


# -----------------------------
# Discord payload builder
# -----------------------------
_SIGNAL_EMOJI = {
    # 用同一套“方块”符号，避免不同圆点 emoji 在 Discord 上显示大小不一致
    "no_signal": "⬜",
    "ok": "🟩",
    "watch": "🟨",
    "triggered": "🟥",
}

# Discord 推送侧的分类（示例：后续你可以自行补充/改文案）
_DEFAULT_SIGNAL_CATEGORIES = {
    "crash_down": {"title": "大跌信号", "desc": "捕捉快速下跌/风险事件驱动的下行阶段（示例文案）。"},
    "surge_up": {"title": "大涨信号", "desc": "捕捉趋势加速/情绪共振的上行阶段（示例文案）。"},
    "cyclical_short": {"title": "周期性空头", "desc": "识别周期结构下的偏空窗口（示例文案）。"},
}

# 监控报表使用固定的“独特主题色”，避免与开多/开空信号（常用红/绿边框）混淆
# 选用偏紫的靛蓝色，辨识度高且不表达方向含义
_REPORT_COLOR = 0x6D28D9  # Indigo / Purple


def _normalize_date_key(date_str: str) -> str:
    """
    支持：
    - 2026/2/18
    - 2026-02-18
    - 2026-02-18T00:00:00
    """
    if not date_str:
        return ""
    s0 = str(date_str).strip().split("T")[0].split(" ")[0]
    s = s0.replace("/", "-")
    parts = s.split("-")
    if len(parts) == 3 and len(parts[0]) == 4:
        y, m, d = parts
        try:
            return f"{y}-{int(m):02d}-{int(d):02d}"
        except Exception:
            return s
    return s


def _load_latest_signal_item(signal_data_path: Path) -> Dict:
    """从 signal_data.json 读取最新一条记录（默认取 signal_list 最后一条）。"""
    with signal_data_path.open("r", encoding="utf-8") as f:
        obj = json.load(f)
    lst = (((obj or {}).get("data") or {}).get("signal_list")) or []
    if not isinstance(lst, list) or len(lst) == 0:
        raise ValueError("signal_data.json 中未找到 data.signal_list 或为空")
    return lst[-1]


def _status_for_signal_value(
    *,
    signal_key: str,
    value: Optional[Number],
) -> Tuple[str, str]:
    """
    返回 (status, label)
    - status: no_signal / triggered / watch
    规则：
    - CrashRF_DOWN(signal2)：
        - value==3 -> watch(高概率预警, 黄色)
        - value in (1,2,5) -> triggered(触发信号)
        - else -> no_signal
    - 其它信号：只有 0/1 两种
        - value==1 -> triggered
        - else -> no_signal
    """
    try:
        v = int(value) if value is not None else 0
    except Exception:
        v = 0

    if signal_key == "signal2":
        if v == 3:
            return "watch", "高概率预警"
        if v in (1, 2, 5):
            return "triggered", "触发信号"
        return "no_signal", "无信号"

    # 其它信号仅按 0/1 判断
    if v == 1:
        return "triggered", "触发信号"
    return "no_signal", "无信号"


def build_signals_from_latest_item(latest_item: Dict) -> Tuple[str, List[Dict]]:
    """
    从最新数据行构建 signals 列表（含分类与状态）。
    返回： (data_date, signals)
    """
    data_date = _normalize_date_key(str(latest_item.get("date", "")))

    # 与 index.html 的信号配置保持一致
    signal_defs = [
        ("signal1", "CrashRF1_DOWN", "crash_down"),
        ("signal2", "CrashRF2_DOWN", "crash_down"),
        ("signal18", "CrashMLP_DOWN", "crash_down"),
        ("signal7", "SurgeGB_UP", "surge_up"),
        ("signal13", "SurgeLG_UP", "surge_up"),
        ("signal15", "SurgeLDA_UP", "surge_up"),
        ("signal9", "CyclicalLG_D2U", "cyclical_short"),
    ]

    out: List[Dict] = []
    for key, name, cat in signal_defs:
        status, label = _status_for_signal_value(signal_key=key, value=latest_item.get(key))
        out.append({"name": name, "category": cat, "status": status, "label": label})
    return data_date, out


def build_discord_market_report_payload(
    *,
    report_title: str = "📡 信号雷达",
    data_date: str,
    signals: List[Dict],
    exchange_balance_change_24h: Optional[Dict[str, Number]] = None,
    market_metrics: Optional[Dict[str, Union[Number, str]]] = None,
    detail_url: str,
    bot_name: str = "S&L Bro. Monitor",
    footer_text: str = "Automated report • For internal use",
    embed_color: Optional[int] = None,
    signal_categories: Optional[Dict[str, Dict[str, str]]] = None,
    signal_category_order: Optional[List[str]] = None,
) -> Dict:
    """
    signals 示例:
    [
      {"name":"Signal1_CrashRF1","status":"no_signal","label":"无信号"},
      {"name":"Signal2-SurgeGB2","status":"triggered","label":"触发信号"},
    ]

    exchange_balance_change_24h 示例: {"BTC": -0.23, "USDC": 2.52, "USDT": -0.06}
    market_metrics 示例:
    {
      "Funding Rate": 0.0000,
      "RV (1 week)": "34.86%",
      "DVOL (7 day)": 52.72,
      ...
    }
    """
    # 信号组渲染：支持按 category 分组（若 signals 里提供 category 字段）
    cats = signal_categories or _DEFAULT_SIGNAL_CATEGORIES
    order = signal_category_order or ["crash_down", "surge_up", "cyclical_short"]

    def _render_signal_line(s: Dict) -> str:
        status = str(s.get("status", "no_signal")).lower().strip()
        emoji = _SIGNAL_EMOJI.get(status, "⬜")
        name = str(s.get("name", "")).strip()
        label = str(s.get("label", "")).strip()
        return f"{emoji}  {name}  —  **{label}**" if label else f"{emoji}  {name}"

    has_category = any(bool(str(s.get("category", "")).strip()) for s in signals)

    def _render_signal_line_compact(s: Dict) -> str:
        status = str(s.get("status", "no_signal")).lower().strip()
        emoji = _SIGNAL_EMOJI.get(status, "⬜")
        name = str(s.get("name", "")).strip()
        label = str(s.get("label", "")).strip()
        return f"{emoji} {name} | {label}" if label else f"{emoji} {name}"

    fields: List[Dict[str, object]] = []
    if has_category:
        for cat_key in order:
            members = [s for s in signals if str(s.get("category", "")).strip() == cat_key]
            if not members:
                continue
            lines = [_render_signal_line_compact(s) for s in members]
            fields.append({"name": cats.get(cat_key, {}).get("title", cat_key), "value": "\n".join(lines), "inline": False})
    else:
        lines = [_render_signal_line_compact(s) for s in signals]
        fields.append({"name": "信号组", "value": "\n".join(lines), "inline": False})

    if market_metrics:
        metric_items: List[Tuple[str, str]] = []
        for k, v in market_metrics.items():
            if isinstance(v, (int, float)):
                k_str = str(k)
                if "funding" in k_str.lower():
                    metric_items.append((k_str, f"{float(v):.4f}"))
                else:
                    metric_items.append((k_str, _fmt_num(v, digits=2)))
            else:
                metric_items.append((str(k), str(v)))

        if metric_items:
            k_w = max([len(k) for k, _ in metric_items] + [8])
            m_lines = [f"{_pad_right(k, k_w)}  {v}" for k, v in metric_items]
            metrics_block = _as_codeblock(m_lines)
            fields.append({"name": "市场快照", "value": metrics_block, "inline": False})

    if exchange_balance_change_24h:
        assets = list(exchange_balance_change_24h.keys())
        left_w = max([len(a) for a in assets] + [3])
        bal_lines: List[str] = []
        for asset, chg in exchange_balance_change_24h.items():
            bal_lines.append(f"{_pad_right(asset, left_w)}  {_fmt_pct(float(chg), digits=2, signed=True)}")
        bal_block = _as_codeblock(bal_lines)
        fields.insert(1, {"name": "交易所余额变化 (24h)", "value": bal_block, "inline": False})

    embed = {
        "title": report_title,
        "color": int(embed_color) if embed_color is not None else _REPORT_COLOR,
        # 链接与日期放同一行（更像“快报头部”）
        "description": f"**数据日期**：`{data_date}`  ｜  **详情**：[点击此处]({detail_url})",
        "fields": fields,
        "footer": {"text": footer_text},
        # 不设置 timestamp，避免 Discord 右下角出现“今天 15:53”之类的时间戳结尾
    }

    return {
        "username": bot_name,
        "allowed_mentions": {"parse": []},  # 避免意外 @everyone/@here
        "embeds": [embed],
    }


# -----------------------------
# Discord sender
# -----------------------------
def send_to_discord(webhook_url: str, payload: Dict, timeout: int = 12) -> Dict:
    resp = requests.post(webhook_url, json=payload, timeout=timeout)

    # Discord webhook 成功常见返回 204 No Content
    if resp.status_code in (200, 204):
        return {"status_code": resp.status_code, "ok": True}

    # 失败时把 Discord 的返回体带出来（通常会告诉你哪个字段不合法/超长）
    detail: Dict[str, object] = {
        "status_code": resp.status_code,
        "ok": False,
        "text": resp.text,
    }
    try:
        detail["json"] = resp.json()
    except Exception:
        pass
    return detail


# -----------------------------
# Example (your provided content)
# -----------------------------
if __name__ == "__main__":
    # 从 signal_data.json 读取最新一条记录生成推送
    base_dir = Path(__file__).resolve().parent
    signal_data_path = Path(os.getenv("SIGNAL_DATA_PATH", str(base_dir / "signal_data.json")))

    latest_item = _load_latest_signal_item(signal_data_path)
    data_date, signals = build_signals_from_latest_item(latest_item)

    payload = build_discord_market_report_payload(
        data_date=data_date,
        signals=signals,
        market_metrics=None,  # 如需市场指标，可在此处接入你自己的数据源
        detail_url="https://signals-dashboard-one.vercel.app/",
        footer_text="S&L Bro. Signal Bot",
    )

    print(json.dumps(payload, ensure_ascii=False, indent=2))

    # 发送（可选）：用环境变量，避免 webhook 泄露
    # zsh 示例：
    #   export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
    #   export DISCORD_SEND=1
    # webhook_url = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    # should_send = os.getenv("DISCORD_SEND", "").strip() in ("1", "true", "True", "YES", "yes")
    webhook_url = "https://discord.com/api/webhooks/1475412756663632012/lQ40WDWxj76v7-RpyeroxFFLYQYjpNU0RS6TUF8vuoVRzEgZOOx9wbD2ZZEzY1x9j8up"
    should_send = True
    if should_send and webhook_url:
        print(send_to_discord(webhook_url, payload))
    # elif should_send and not webhook_url:
    #     print("DISCORD_SEND 已开启但未设置 DISCORD_WEBHOOK_URL：未发送。", file=sys.stderr)