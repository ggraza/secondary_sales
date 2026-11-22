"""Outstanding ageing buckets, matching ERPNext's Accounts Receivable ranges."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date


def bucket_labels(ranges: Iterable[int]) -> list[str]:
	ranges = sorted({int(r) for r in ranges if int(r) > 0})
	labels = ["Not Due"]
	lower = 0
	for upper in ranges:
		labels.append(f"{lower + 1}-{upper}")
		lower = upper
	labels.append(f"{lower + 1}+")
	return labels


def age_invoices(invoices: Iterable[dict], as_of: date, ranges: Iterable[int] = (30, 60, 90, 120)) -> dict:
	"""Sum invoice outstanding into ageing buckets by due date.

	Each invoice needs ``outstanding_amount`` and ``due_date`` (or ``posting_date``).
	"""
	ranges = sorted({int(r) for r in ranges if int(r) > 0})
	labels = bucket_labels(ranges)
	buckets = dict.fromkeys(labels, 0.0)
	total = 0.0
	oldest = 0
	for inv in invoices:
		amount = float(inv.get("outstanding_amount") or 0)
		due = inv.get("due_date") or inv.get("posting_date")
		if isinstance(due, str):
			due = date.fromisoformat(due[:10])
		days = (as_of - due).days if due else 0
		total += amount
		if days <= 0:
			buckets["Not Due"] += amount
			continue
		oldest = max(oldest, days)
		for upper, label in zip(ranges, labels[1:], strict=False):
			if days <= upper:
				buckets[label] += amount
				break
		else:
			buckets[labels[-1]] += amount
	return {
		"total": round(total, 2),
		"buckets": [{"label": k, "amount": round(v, 2)} for k, v in buckets.items()],
		"oldest_days": oldest,
	}
