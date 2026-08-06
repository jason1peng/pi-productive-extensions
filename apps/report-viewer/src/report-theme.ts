export const REPORT_VIEWER_CSS = `
:root {
  color-scheme: light;
  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-subtle: #f1f5f9;
  --text: #182230;
  --muted: #667085;
  --muted-strong: #475467;
  --border: #d0d5dd;
  --border-subtle: #eaecf0;
  --accent: #175cd3;
  --ok: #067647;
  --ok-bg: #ecfdf3;
  --warn: #b54708;
  --warn-bg: #fffaeb;
  --bad: #b42318;
  --bad-bg: #fef3f2;
  --neutral-bg: #f2f4f7;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --shadow-primary: 0 8px 24px rgba(16, 24, 40, .10), 0 2px 6px rgba(16, 24, 40, .06);
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 40px;
  --measure: 78ch;
}

* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0 auto;
  max-width: 1180px;
  padding: var(--space-6) var(--space-4) var(--space-7);
  background: var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { line-height: 1.2; }
h1 { margin: 0 0 var(--space-4); letter-spacing: -.02em; }
h2 { margin: var(--space-6) 0 var(--space-3); }
h3 { margin: var(--space-4) 0 var(--space-2); }
p, li, .prose, .summary, .outcome-line { max-width: var(--measure); }

/* The outcome is the one intentionally elevated surface. Other containers are flat. */
.panel, .card, details, .phase-card, .section-card, .attention-card, .report-row {
  background: transparent;
  border: 0;
  border-top: 1px solid var(--border-subtle);
  border-radius: 0;
  box-shadow: none;
}
.panel, .card, .phase-card, .section-card, .attention-card { padding: var(--space-4) 0; }
details { margin: var(--space-4) 0; padding: var(--space-3) 0; }
details > :not(summary) { margin-left: var(--space-2); }
summary { cursor: pointer; font-weight: 700; }
.outcome-summary {
  margin: var(--space-5) 0;
  padding: var(--space-5);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-primary);
}
.outcome-summary h2 { margin-top: 0; }
.outcome-line { margin: var(--space-2) 0 var(--space-4); font-size: 1.08rem; }
.outcome-metrics { display: flex; flex-wrap: wrap; gap: var(--space-5); margin: var(--space-4) 0; }
.outcome-metrics > div { display: flex; flex-direction: column; gap: var(--space-1); min-width: 10ch; }

.grid, .phase-grid, .section-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
  margin: var(--space-4) 0;
}
.card { min-width: 0; }
.value { margin-top: var(--space-1); font-size: 1.25rem; font-weight: 700; }
.label {
  color: var(--muted);
  font-size: .8rem;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.muted { color: var(--muted); }
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: var(--space-1) var(--space-2);
  background: var(--neutral-bg);
  color: var(--muted-strong);
  font-size: .82rem;
  font-weight: 700;
  line-height: 1.2;
}
/* Visible glyphs keep verdict meaning available without relying on colour alone. */
.badge.ok { background: var(--ok-bg); border-color: #abefc6; color: var(--ok); }
.badge.warn { background: var(--warn-bg); border-color: #fedf89; color: var(--warn); }
.badge.bad { background: var(--bad-bg); border-color: #fecdca; color: var(--bad); }
.badge:not(.ok):not(.warn):not(.bad)::before { content: "•"; }
.badge.ok::before { content: "✓"; }
.badge.warn::before { content: "!"; }
.badge.bad::before { content: "×"; }
.signal-list, .candidate-actions, .filters, .usage-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.button, button {
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font-weight: 700;
}
.button.secondary { background: transparent; color: var(--accent); }

.project-groups, .report-list, .phase-groups, .artifact-sections, .attention-grid, .phase-summary-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.project-heading, .report-row, .report-row-aside, .timeline-label {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: baseline;
  flex-wrap: wrap;
}
.project-heading h2 { margin-bottom: var(--space-1); }
.project-metadata { border-top: 0; padding-top: 0; }
.report-row { padding: var(--space-4) 0; }
.report-row-main { min-width: 0; flex: 1; }
.report-row-aside { align-items: flex-end; white-space: nowrap; }
.report-title { display: inline-block; max-width: 100%; font-size: 1.02rem; overflow-wrap: anywhere; }
.report-meta, .report-brief { margin: var(--space-2) 0; }
.report-brief { color: var(--muted-strong); }
.artifact-links { margin: var(--space-2) 0 0; padding-left: var(--space-5); }
.artifact-unavailable { font-size: .9rem; }

.wide-table { width: 100%; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: transparent; }
td, th { border-bottom: 1px solid var(--border-subtle); padding: var(--space-3) var(--space-2); text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; }
tr:last-child td { border-bottom: 0; }
.numeric, th.numeric, td.numeric, .usage-number { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
code, pre, .path, .command, .identifier { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
code { overflow-wrap: anywhere; }
pre { max-width: 100%; overflow: auto; padding: var(--space-4); border-radius: var(--radius-sm); background: var(--surface-subtle); }
.markdown-report { max-height: 520px; }

.filters { align-items: end; }
.filters label { display: flex; flex-direction: column; gap: var(--space-1); }
.filters input, .filters select {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  background: var(--surface);
  color: var(--text);
}
.section-grid { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.phase-summary-card { width: 100%; }
.phase-summary-card ul { margin: var(--space-2) 0 0 var(--space-5); padding: 0; }
.phase-summary-meta { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: var(--space-2) 0; }
.phase-timeline { display: flex; flex-direction: column; gap: var(--space-2); margin: var(--space-4) 0; padding: 0; list-style: none; }
.phase-timeline li { border-top: 1px solid var(--border-subtle); padding: var(--space-3) 0; min-width: 0; }
.timeline-summary { margin-top: var(--space-1); overflow-wrap: anywhere; }
.structured-note { border-left: 4px solid var(--warn); padding-left: var(--space-3); }
.usage-pie { width: 180px; height: 180px; margin: var(--space-4) auto; border: 1px solid var(--border); border-radius: 50%; }
.usage-legend-item { display: inline-flex; align-items: center; gap: var(--space-1); font-size: .9rem; }
.usage-swatch { display: inline-block; width: .8rem; height: .8rem; margin-right: var(--space-1); border-radius: 3px; vertical-align: -.1rem; }
.usage-phase-filter { display: flex; flex-wrap: wrap; gap: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); }
.usage-phase-filter legend { padding: 0 var(--space-1); }
.usage-stack { display: flex; height: .8rem; min-width: 140px; overflow: hidden; border-radius: 999px; background: var(--surface-subtle); }
.usage-stack span { display: block; height: 100%; }
.usage-stack-input { background: #2563eb; }
.usage-stack-output { background: #16a34a; }
.usage-stack-cache { background: #f59e0b; }
.usage-offenders { margin: var(--space-3) 0 0 var(--space-5); padding: 0; }
.usage-offenders li { margin: var(--space-2) 0; }
.overflow-details { border-top: 1px dashed var(--border); }
.show-all-summary { color: var(--accent); }

@media (max-width: 700px) {
  body { padding: var(--space-4) var(--space-3) var(--space-6); }
  .wide-table { display: block; overflow-x: auto; }
  .phase-grid { grid-template-columns: 1fr; }
  .report-row { align-items: flex-start; flex-direction: column; }
  .report-row-aside { align-items: flex-start; white-space: normal; }
}

@media print {
  @page { margin: 14mm; }
  body { max-width: none; padding: 0; font-size: 10pt; background: #fff; color: #000; }
  a { color: inherit; text-decoration: none; }
  .outcome-summary { box-shadow: none; break-inside: avoid; }
  #debug-details, #usage-breakdown, .phase-attempt-details, .candidate-actions, form, button { display: none !important; }
  details:not([open]) > :not(summary) { display: none; }
  .panel, .card, details, .phase-card, .section-card, .attention-card, .report-row { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
`;
