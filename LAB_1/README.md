# FinTrack: Personal Finance and Investment Manager

A single-page website for personal finance, budgeting and investments, built with HTML5, CSS3 and a small amount of vanilla JavaScript. It was made for a university web-design assignment.

**Student:** Md Kamran S Rashid (Reg. No. 2340236)
**Course / Lab:** <add course name and lab number>

All figures on the site are **demonstration data**. No real money or accounts are involved.

## Folder contents

| File | What it is |
| --- | --- |
| `index.html` | The final website. Open this one. |
| `LAB1_Hardcoded.html` | The original starting version, kept for comparison. |
| `AI_Log.docx` | Log of every prompt given to the AI and the changes made at each step (export of the "FinTrack Project Log" doc; use whatever file name you saved it under). |
| `README.md` | This file. |

## How to run

1. Download or clone the folder.
2. Double-click `index.html`, or open it in any modern browser.

No installation, build step or internet connection is needed. Everything (HTML, CSS, JavaScript) is in the one file.

## What the site includes

- **Header and navigation:** sticky top bar with numbered links to each chapter, plus a skip-to-content link.
- **Cover:** FINTRACK wordmark scaled with `clamp()` and container units, tagline, demo-data sticker.
- **01 Where you stand:** income, expenses, savings and a six-month savings chart.
- **02 Where it went:** donut chart, editable budget tracker, and recent transactions.
- **03 Where it grows:** investment portfolio with allocation bar, holdings, risk meters and milestones.
- **04 The future (plugin):** compound-interest calculator with input validation and a year-by-year chart.
- **05 Footer:** closing sign-off and the full FINTRACK wordmark.

## Functional features (JavaScript)

- **Compound-interest calculator:** `A = P(1 + r/n)^(nt)`. It validates the inputs, shows the result as a sentence, and draws the growth chart.
- **Budget tracker:** type a spent amount per category. The donut, percentages and totals update. A category over budget gets an "Over budget" label, the excess amount, a meter that extends past the limit, and a tinted row, so overspending is not shown by colour alone.

## Modern CSS used

CSS variables, Grid, Flexbox, `clamp()` responsive type, container queries and `cqi` units, `conic-gradient` charts, media queries, transitions, scroll-driven reveals (`animation-timeline: view()`, with a safe fallback), `prefers-reduced-motion`.

## Constraints followed

- One `index.html` file
- No frameworks or external libraries (no React, Bootstrap or Tailwind)
- Responsive layout (checked from 360px to 1920px wide)
- Accessibility: semantic landmarks, labelled form fields, `aria-live` results, visible focus states

## Known limitations

- Tested in Chrome (headless) only. Not yet checked in Safari, Firefox or on a real phone.
- Budget edits are not saved; reloading restores the demo values.
- Scroll-reveal animation needs a recent browser; older browsers simply show the content without it.

## Version history

1. `LAB1_Hardcoded.html`: original static page with a basic calculator.
2. Improved dashboard version: responsive layout, transactions, portfolio, validated calculator, budget tracker.
3. Editorial redesign ("wealth journal"): scroll story, new visual identity.
4. Bug-fix pass: demo sticker overlap, Total Wealth card over the chart, overspending indicators.
5. Typography change: oversized F replaced by the full FINTRACK wordmark in the hero, and the cropped footer wordmark fixed.

The full prompt-by-prompt record is in the AI log.
