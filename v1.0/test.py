#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import requests
from typing import Dict, List, Optional, Union


Number = Union[int, float]
DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1475412756663632012/lQ40WDWxj76v7-RpyeroxFFLYQYjpNU0RS6TUF8vuoVRzEgZOOx9wbD2ZZEzY1x9j8up"


def _to_num(value: Number) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        head = value.split("(")[0].strip()
        try:
            return float(head)
        except Exception:
            return None
    return None


def fmt_price(value: Number) -> str:
    """格式化价格：整数带千分位，小数保留最多 4 位并去掉尾零。"""
    if isinstance(value, str):
        # 支持 "70388(20%)" 或 "70388" 这类字符串
        head = value.split("(")[0].strip()
        try:
            value = float(head)
        except Exception:
            return value
    if isinstance(value, float) and not value.is_integer():
        s = f"{value:,.4f}".rstrip("0").rstrip(".")
        return s
    return f"{int(value):,}"


def _fmt_percent(value: Number) -> str:
    if isinstance(value, float) and not value.is_integer():
        return f"{value:.2f}".rstrip("0").rstrip(".")
    return str(int(value))


def _direction_style(direction: str) -> Dict:
    normalized = direction.lower().strip()
    if "long" in normalized or "多" in normalized:
        return {"emoji": "🟢", "color": 5763719}
    if "short" in normalized or "空" in normalized:
        return {"emoji": "🔴", "color": 15548997}
    return {"emoji": "🔵", "color": 3447003}


def _build_tp_text(tps: List[Dict]) -> str:
    lines: List[str] = []
    for i, tp in enumerate(tps, start=1):
        ratio = _fmt_percent(tp["ratio"])
        price = tp["price"]
        lines.append(f"TP{i}: {ratio}% @ {fmt_price(price)}")
    return "\n".join(lines)


def _filter_valid_tps(tps: List[Dict]) -> List[Dict]:
    valid: List[Dict] = []
    for tp in tps:
        ratio = _to_num(tp.get("ratio", 0))
        price = _to_num(tp.get("price", 0))
        if (ratio or 0) > 0 and (price or 0) > 0:
            valid.append(tp)
    return valid


def _build_entry_text(order_type: str, entry: Number) -> str:
    if order_type == "market":
        return f"Around {_raw_or_fmt(entry)}"
    return _raw_or_fmt(entry)


def _raw_or_fmt(value: Number) -> str:
    if isinstance(value, str):
        return value
    return fmt_price(value)


def _group_lines(lines: List[str], per_line: int = 1) -> List[str]:
    out: List[str] = []
    for i in range(0, len(lines), per_line):
        out.append("  ".join(lines[i:i + per_line]))
    return out


def build_lines(signal: Dict) -> List[str]:
    ot = str(signal["order_type"]).lower().strip()
    if ot not in ("market", "limit"):
        raise ValueError("order_type 必须是 market 或 limit")

    lines = [
        f"**Direction：**{signal['direction']}",
        f"**OrderType：**{ot.capitalize()}",
    ]

    entry = signal["entry"]
    if ot == "market":
        lines.append(f"**Entry：**around {_raw_or_fmt(entry)}")
    else:
        lines.append(f"**Entry：**{_raw_or_fmt(entry)}")

    add1 = _to_num(signal.get("add1", 0)) or 0
    add2 = _to_num(signal.get("add2", 0)) or 0
    if add1 > 0:
        lines.append(f"**Add1：**{_raw_or_fmt(signal.get('add1', add1))}")
    if add2 > 0:
        lines.append(f"**Add2：**{_raw_or_fmt(signal.get('add2', add2))}")

    lines.append(f"**Leverage：**{signal['leverage']}x")
    lines.append(f"**Stop Loss：**{_raw_or_fmt(signal['stop_loss'])}")

    tps = _filter_valid_tps(signal["tps"])
    for i, tp in enumerate(tps, start=1):
        ratio = _fmt_percent(tp["ratio"])
        price = tp["price"]
        lines.append(f"**TP{i}：**{ratio}% @ {fmt_price(price)}")

    return _group_lines(lines)


def build_lark_payload(signal: Dict) -> Dict:
    """构造 Lark interactive card。"""
    markdown_text = "\n".join(build_lines(signal))
    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "template": "green",
                "title": {
                    "tag": "plain_text",
                    "content": signal["symbol"],
                },
            },
            "elements": [
                {
                    "tag": "markdown",
                    "content": markdown_text,
                }
            ],
        },
    }


def build_discord_payload(signal: Dict) -> Dict:
    """
    构造 Discord webhook payload，支持三种样式:
    - pro: 专业卡片，字段分区
    - compact: 简洁模式，一眼看重点
    - alert: 强提醒模式，适合高优先级信号
    """
    ot = str(signal["order_type"]).lower().strip()
    style = str(signal.get("style", "pro")).lower().strip()
    ds = _direction_style(str(signal["direction"]))
    valid_tps = _filter_valid_tps(signal["tps"])
    tp_text = _build_tp_text(valid_tps)
    entry_text = _build_entry_text(ot, signal["entry"])
    leverage_text = f"{signal['leverage']}x"
    add1 = _to_num(signal.get("add1", 0)) or 0
    add2 = _to_num(signal.get("add2", 0)) or 0

    add_text = "None"
    add_lines: List[str] = []
    if add1 > 0:
        add_lines.append(f"Add1: {_raw_or_fmt(signal.get('add1', add1))}")
    if add2 > 0:
        add_lines.append(f"Add2: {_raw_or_fmt(signal.get('add2', add2))}")
    if add_lines:
        add_text = "\n".join(add_lines)

    note = signal.get("note", "")

    if style == "compact":
        compact_lines = [
            f"**Direction:** {signal['direction']}",
            f"**OrderType:** {ot.capitalize()}",
            f"**Entry:** {entry_text}",
            f"**Leverage:** {leverage_text}",
            f"**Stop Loss:** {_raw_or_fmt(signal['stop_loss'])}",
        ]
        if tp_text:
            compact_lines.append(f"**TP Plan:**\n{tp_text}")
        if add_lines:
            compact_lines.insert(3, f"**Adds:**\n{add_text}")
        if note:
            compact_lines.append(f"**Note:** {note}")
        description = "\n".join(_group_lines(compact_lines))
        embed = {
            "title": f"{ds['emoji']} {signal['symbol']}",
            "description": description,
            "color": ds["color"],
        }
    elif style == "alert":
        alert_title = f"{ds['emoji']} SIGNAL ALERT | {signal['symbol']}"
        alert_desc = [
            f"**{signal['direction']} / {ot.capitalize()}**",
            f"Entry: {entry_text}",
            f"Leverage: {leverage_text}",
            f"Stop Loss: {fmt_price(signal['stop_loss'])}",
        ]
        if tp_text:
            alert_desc.append(f"TP Plan:\n{tp_text}")
        if add_lines:
            alert_desc.append(f"Adds:\n{add_text}")
        if note:
            alert_desc.append(f"Note: {note}")
        embed = {
            "title": alert_title,
            "description": "\n".join(alert_desc),
            "color": ds["color"],
        }
    else:
        # 默认 pro 样式：字段分区更清晰，可扩展更多个性化信息
        fields = [
            {"name": "方向", "value": signal["direction"], "inline": True},
            {"name": "订单类型", "value": ot.capitalize(), "inline": True},
            {"name": "杠杆", "value": leverage_text, "inline": True},
            {"name": "开仓价", "value": entry_text, "inline": True},
            {"name": "加仓点", "value": add_text, "inline": True},
            {"name": "信心度", "value": str(signal.get("confidence", "-")), "inline": True},
            {"name": "止损", "value": fmt_price(signal["stop_loss"]), "inline": True},

        ]
        if tp_text:
            fields.append({"name": "TP Plan", "value": tp_text, "inline": True})
        if note:
            fields.append({"name": "Note", "value": note, "inline": False})

        embed = {
            "title": f"{ds['emoji']} {signal['symbol']}",
            # "description": "Automated trading signal",
            "color": ds["color"],
            "fields": fields,
            "footer": {"text": "S&L Bro. Signal Bot"},
        }

    return {
        "username": signal.get("bot_name", "S&L Bro."),
        "embeds": [
            embed
        ]
    }


def send_to_lark(webhook_url: str, payload: Dict, timeout: int = 10) -> Dict:
    resp = requests.post(
        webhook_url,
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload),
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()


def send_to_discord(webhook_url: str, payload: Dict, timeout: int = 10) -> Dict:
    resp = requests.post(
        webhook_url,
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload),
        timeout=timeout,
    )
    resp.raise_for_status()
    # Discord webhook 通常返回 204 No Content
    return {"status_code": resp.status_code, "ok": True}


def validate_signal(signal: Dict) -> None:
    required = ["symbol", "direction", "order_type", "entry", "leverage", "tps", "stop_loss"]
    missing = [k for k in required if k not in signal]
    if missing:
        raise ValueError(f"缺少必要字段: {missing}")

    if not str(signal.get("symbol", "")).strip():
        raise ValueError("symbol 不能为空")
    if not str(signal.get("direction", "")).strip():
        raise ValueError("direction 不能为空")

    tps = signal["tps"]
    if not isinstance(tps, list):
        raise ValueError("tps 必须是 list，例如 [{'ratio':30,'price':70000}]")

    for idx, tp in enumerate(tps, start=1):
        if "ratio" not in tp or "price" not in tp:
            raise ValueError(f"tps 第 {idx} 项缺少 ratio 或 price")
        # 允许 ratio/price 为 0，表示暂不设置该 TP

    style = str(signal.get("style", "pro")).lower().strip()
    if style not in ("pro", "compact", "alert"):
        raise ValueError("style 必须是 pro / compact / alert")

    if not str(signal.get("entry", "")).strip():
        raise ValueError("entry 必须是非空字符串")
    if not str(signal.get("stop_loss", "")).strip():
        raise ValueError("stop_loss 必须是非空字符串")
    if (_to_num(signal.get("leverage")) or 0) <= 0:
        raise ValueError("leverage 必须是正数")


def send_signal(signal: Dict, platform: str, webhook_url: str, timeout: int = 10) -> Dict:
    """
    signal 结构示例:
    {
      "symbol": "BTCUSDT",
      "direction": "Long",
      "order_type": "market",  # market / limit
      "entry": 65000,
      "add1": 63000,           # <=0 不展示
      "add2": 60000,           # <=0 不展示
      "leverage": 3,
      "tps": [
        {"ratio": 30, "price": 70000},
        {"ratio": 50, "price": 72000},
        {"ratio": 20, "price": 75000}
      ]
    }
    """
    validate_signal(signal)

    platform_normalized = platform.lower().strip()
    if platform_normalized == "lark":
        payload = build_lark_payload(signal)
        return send_to_lark(webhook_url, payload, timeout=timeout)
    if platform_normalized == "discord":
        payload = build_discord_payload(signal)
        return send_to_discord(webhook_url, payload, timeout=timeout)
    raise ValueError("platform 必须是 lark 或 discord")


if __name__ == "__main__":
    # 这里模拟你后续策略逻辑输出的结构化入参
    signal_data = {
        "symbol": "BTCUSDT",
        "direction": "开空",
        "order_type": "限价单",
        "entry": "70388 (20%仓位)",
        "add1": "71588 (30%仓位)",
        "add2": "73588 (50%仓位)",
        "leverage": 2,
        "stop_loss": "此单不预设止损；但如果 add2 加仓成交，则需要在价格跌回成本价后减仓 50%，后续没额外通知则长线持有",
        "style": "compact",
        "confidence": "高",
        "note": "2x杠杆指总本金的 2 倍，比如你有 10000u的本金，那么预期总仓位数量为 20000。进入U本位合约 BTCUSDT 界面，选择限价单，价格输入 70388， 在数量框货币单位选择 USDT，数量为 20000\*20%=4000，点击开空；然后修改价格为 71588，数量 20000\*30%=6000，点击开空；73588 的点同理，下 10000 仓位数量的单，这时候就会有三个挂单",
        "bot_name": "S&L Bro. Bot",
        "tps": [
            {"ratio": 0, "price": 65000},
            {"ratio": 0, "price": 60000},
            {"ratio": 0, "price": 0},
        ],
    }

    print(send_signal(signal_data, platform="discord", webhook_url=DISCORD_WEBHOOK_URL))