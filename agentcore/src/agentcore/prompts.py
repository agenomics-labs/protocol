"""Prompts used by the Strands agent.

The economic-reasoning prompt is **verbatim** from master spec lines 433-452
(acceptance criterion AC-13). Any change requires a written ADR — this is the
artefact the AWS judges read on the phone.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Master spec: docs/aep-reflex-tech-spec.md lines 433-452 (verbatim).
# Do not paraphrase, reformat, or "fix" capitalization. AC-13 enforces this.
# ---------------------------------------------------------------------------

ECONOMIC_REASONING_PROMPT = """\
You are an autonomous agent with a budget of {budget_micros} USDC micros.
You are choosing between {N} candidate services to complete this task:

  {task}

Candidates:
{candidates_table}  # name, source (AEP/Bazaar), price, reputation, reliability

Score each by: (1 / price_usdc) * reputation * historical_reliability.
Pick the top {k} that fit the budget.

Output JSON:
{{
  "ranked_candidates": [...],
  "selection": [...],
  "reasoning": "Two to three sentences. Be concrete about why each was picked.
                Mention the score numerically. Do not hedge."
}}
"""

# Master leaves SYNTHESIS_PROMPT undefined (open question OQ-S4-C). This is a
# DRAFT placeholder — Surface 4 owner finalizes by Day 5-7. Constraint per
# spec: synthesized output cites which candidates were used and matches the
# pitch deck's narrative tone.
SYNTHESIS_PROMPT = """\
You just spent {total_spent_micros} USDC micros across {n_calls} service calls
to satisfy this task:

  {task}

Raw results from each call:
{results_table}

Write a 2-4 sentence answer for the user. Cite which services contributed
(by name) and what each provided. Do not hedge. Do not apologise for cost.
"""


def render_candidates_table(candidates: list[dict]) -> str:
    """Pipe-formatted Markdown table of candidate rows.

    Kept here (next to the prompt that consumes it) so prompt + format drift
    together. Columns chosen to match master line 441 verbatim:
    name | source | price | reputation | reliability.
    """
    header = "| name | source | price (USDC micros) | reputation | reliability |"
    sep = "|---|---|---|---|---|"
    rows = [
        "| {name} | {source} | {price} | {rep} | {rel} |".format(
            name=c["name"],
            source=c["source"].upper(),
            price=c["price_usdc_micros"],
            rep=f'{c["reputation"]:.2f}',
            rel=f'{c["historical_reliability"]:.2f}',
        )
        for c in candidates
    ]
    return "\n".join([header, sep, *rows])
