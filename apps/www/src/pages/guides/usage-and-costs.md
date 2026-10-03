---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: usage-and-costs
---

CodeSesh summarizes tokens and costs from supported AI coding session records. Use the dashboard to compare a date range, then narrow the view by project, agent, or source. The figures describe indexed activity; they are not a replacement for a provider's invoice or subscription usage page.

## Set the period and scope first

Start CodeSesh and open the overview. Choose a recent period or a custom date range. For older history, start with:

```sh
codesesh --days 0
```

For a single project, run from that project's directory:

```sh
codesesh --cwd . --days 0
```

You can also open a project in the interface. In a Hub setup, use the source selector to distinguish one computer from the combined archive. Keep the same dates and filters when comparing results.

The default startup period is seven local calendar days. Worker collection and Hub viewing are separate: changing the Hub window does not instruct Workers to discard older source history.

## Read token categories

Input and output tokens represent different parts of model usage. Supported records may also include reasoning, cache-read, and cache-creation tokens. Availability and accounting depend on what the source agent records and how its adapter interprets those fields.

Do not manually add every displayed category to a provider's number without checking its definition. Some providers include cached or reasoning usage within other reported totals. The model distribution and project summaries help locate where indexed activity came from; open a session to inspect the underlying context.

## Distinguish recorded and estimated costs

The cost breakdown distinguishes amounts from agent records and estimates calculated from model unit prices. A recorded cost comes from the source data. An estimate depends on recognized model names, available token counts, and the pricing data used by CodeSesh.

An unfamiliar model, incomplete usage record, or missing price can leave the cost incomplete. Zero displayed cost alone does not establish that the work was free. Different model labels or pricing data can also explain changes in an estimate.

## Investigate a surprising total

1. Confirm that the date range and project, agent, and source filters match your intended comparison.
2. Check whether initial indexing has finished or a Worker still has pending uploads.
3. Open the relevant sessions and look at which models and token categories were recorded.
4. Compare estimated costs separately from recorded costs.
5. For billing questions, use the provider's own account records. Subscription fees, credits, discounts, and activity absent from local session logs need not match this archive.

Large archives can take time to populate statistics on first open. If the dashboard stays slow, include the CodeSesh version and relevant application-log timings in a bug report. The [background service guide](/guides/background-services/) explains where to find those logs.

## Use the figures to find the conversation

A high-usage project or model is a starting point for inspection. Use [session search and replay](/guides/session-history/) to read the associated conversation and tool activity. To combine the same view across your own computers, configure [Hub and Workers](/guides/multi-machine-sync/).
