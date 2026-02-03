# Rug-pull modeling (Python)

This folder provides a lightweight Python baseline for training and scoring a rug-pull risk model from
the `rugpull_samples.jsonl` data emitted by the bot.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r modeling/requirements.txt
```

## Training

`rugpull_samples.jsonl` must contain labels (e.g., `rug_label: 0/1`) once you add labeling logic.

```bash
python modeling/train_rugpull.py \
  --data rugpull_samples.jsonl \
  --label-field rug_label \
  --model-out modeling/rugpull_model.joblib \
  --metrics-out modeling/metrics.json
```

## Scoring

```bash
python modeling/score_rugpull.py \
  --data rugpull_samples.jsonl \
  --model-in modeling/rugpull_model.joblib \
  --out modeling/scored.jsonl
```
