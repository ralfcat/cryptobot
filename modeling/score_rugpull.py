import argparse
import json
from pathlib import Path

import joblib
import pandas as pd

from train_rugpull import FEATURE_COLUMNS, build_dataframe, load_jsonl


def main() -> None:
    parser = argparse.ArgumentParser(description="Score rug-pull risk model.")
    parser.add_argument("--data", required=True, help="Path to rugpull_samples.jsonl")
    parser.add_argument("--model-in", required=True, help="Trained model path")
    parser.add_argument("--out", required=True, help="Output JSONL with scores")
    args = parser.parse_args()

    records = load_jsonl(Path(args.data))
    if not records:
        raise SystemExit("No records found in dataset.")

    feature_df = build_dataframe(records).fillna(0)
    model = joblib.load(args.model_in)

    proba = model.predict_proba(feature_df[FEATURE_COLUMNS])[:, 1]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        for record, score in zip(records, proba, strict=False):
            payload = {
                "t": record.get("t"),
                "address": record.get("address"),
                "name": record.get("name"),
                "model_score": float(score),
            }
            handle.write(json.dumps(payload) + "\n")


if __name__ == "__main__":
    main()
