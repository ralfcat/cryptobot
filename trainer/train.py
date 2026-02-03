"""Placeholder training entrypoint.

Mount your datasets/models into /trainer/data and /trainer/models and replace
this script with your actual training logic.
"""

from pathlib import Path


def main() -> None:
    data_dir = Path("/trainer/data")
    models_dir = Path("/trainer/models")
    print("Trainer container ready.")
    print(f"Dataset mount: {data_dir} (exists={data_dir.exists()})")
    print(f"Models mount: {models_dir} (exists={models_dir.exists()})")


if __name__ == "__main__":
    main()
