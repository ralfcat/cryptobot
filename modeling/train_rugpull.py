import argparse
import json
from pathlib import Path

import joblib
import pandas as pd
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.ensemble import HistGradientBoostingClassifier


FEATURE_COLUMNS = [
    "score",
    "rug_risk_score",
    "rug_holders_pct",
    "rug_liquidity_usd",
    "rug_vol24h_usd",
    "price_impact_pct",
    "volatility_range_pct",
    "volatility_chop_pct",
    "signal_score",
    "momentum_score",
    "momentum_pct_short",
    "momentum_pct_long",
]


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def flatten_record(record: dict) -> dict:
    rug = record.get("rugRisk") or {}
    volatility = record.get("volatility") or {}
    signal = record.get("signal") or {}
    momentum = record.get("momentum") or {}

    return {
        "score": record.get("score"),
        "rug_risk_score": rug.get("score"),
        "rug_holders_pct": rug.get("holdersPct"),
        "rug_liquidity_usd": rug.get("liquidityUsd"),
        "rug_vol24h_usd": rug.get("vol24hUsd"),
        "price_impact_pct": record.get("priceImpactPct"),
        "volatility_range_pct": volatility.get("rangePct"),
        "volatility_chop_pct": volatility.get("chopPct"),
        "signal_score": signal.get("score"),
        "momentum_score": momentum.get("score"),
        "momentum_pct_short": momentum.get("pctShort"),
        "momentum_pct_long": momentum.get("pctLong"),
    }


def build_dataframe(records: list[dict]) -> pd.DataFrame:
    flat = [flatten_record(record) for record in records]
    return pd.DataFrame(flat)


def build_labels(records: list[dict], label_field: str) -> pd.Series:
    labels = []
    for record in records:
        label = record.get(label_field)
        labels.append(label)
    return pd.Series(labels, dtype="float")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a rug-pull risk classifier.")
    parser.add_argument("--data", required=True, help="Path to rugpull_samples.jsonl")
    parser.add_argument("--label-field", default="rug_label", help="JSON field containing 0/1 labels")
    parser.add_argument("--model-out", default="rugpull_model.joblib", help="Output model path")
    parser.add_argument("--metrics-out", default="metrics.json", help="Metrics JSON output")
    parser.add_argument("--test-size", type=float, default=0.2, help="Test split size")
    args = parser.parse_args()

    data_path = Path(args.data)
    records = load_jsonl(data_path)
    if not records:
        raise SystemExit("No records found in dataset.")

    labels = build_labels(records, args.label_field)
    feature_df = build_dataframe(records)

    mask = labels.notna()
    feature_df = feature_df.loc[mask].fillna(0)
    labels = labels.loc[mask].astype(int)

    if labels.nunique() < 2:
        raise SystemExit("Labels must contain at least two classes.")

    x_train, x_test, y_train, y_test = train_test_split(
        feature_df[FEATURE_COLUMNS],
        labels,
        test_size=args.test_size,
        random_state=42,
        stratify=labels,
    )

    model = HistGradientBoostingClassifier(max_depth=5, learning_rate=0.1)
    model.fit(x_train, y_train)

    proba = model.predict_proba(x_test)[:, 1]
    preds = (proba >= 0.5).astype(int)

    report = classification_report(y_test, preds, output_dict=True)
    auc = roc_auc_score(y_test, proba)

    metrics = {
        "auc": auc,
        "report": report,
        "features": FEATURE_COLUMNS,
        "train_rows": int(len(x_train)),
        "test_rows": int(len(x_test)),
    }

    Path(args.model_out).parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, args.model_out)

    with Path(args.metrics_out).open("w", encoding="utf-8") as handle:
        json.dump(metrics, handle, indent=2)


if __name__ == "__main__":
    main()
