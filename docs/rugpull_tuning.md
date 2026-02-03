# Rug-pull tuning roadmap

This document outlines the tasks to fine-tune the simulator so it avoids rug pulls and anticipates high-risk tokens.

## Phase 1: Data capture (now)
- Capture per-scan features, scores, and risk flags to `rugpull_samples.jsonl`.
- Start tagging outcomes (profit/loss, rug event) after exits.
- Build a dataset schema with:
  - token address, timestamps
  - liquidity/volume metrics
  - holder concentration
  - security flags (mintable/freezeable/honeypot/etc.)
  - price impact and volatility metrics

## Phase 2: Labeling & definitions
- Define a **rug-pull event** label:
  - price drop > X% within Y minutes AND liquidity drop > Z%
  - optional: dev wallet dump or ownership changes
- Define a **pre-rug window** (e.g., 6–48 hours) for “about-to-rug” training.
- Enrich samples with post-trade outcomes and rug labels.

## Phase 3: Model training (open source)
- Train a baseline **risk classifier** with scikit-learn (see `modeling/train_rugpull.py`).
- Track precision/recall for:
  - rug detection
  - pre-rug detection
- Calibrate the risk threshold to balance false positives vs. catastrophic loss.

## Phase 4: Simulator parameter tuning
- Use Optuna to optimize:
  - entry thresholds
  - max position size
  - stop-loss + exit timing
  - rug risk weight/threshold
- Objective: maximize return while minimizing tail risk (e.g., CVaR).

## Phase 5: Evaluation & guardrails
- Backtest against known rug events.
- Stress test with synthetic liquidity-rug scenarios.
- Add guardrails:
  - hard block when rug risk is above threshold
  - cooldown after rug-like signals
