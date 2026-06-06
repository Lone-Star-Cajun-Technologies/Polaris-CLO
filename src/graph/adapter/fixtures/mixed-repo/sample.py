import os
from pathlib import Path


class Worker:
  def run(self) -> str:
    return "ok"


def build() -> Worker:
  return Worker()
