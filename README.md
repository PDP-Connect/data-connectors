Evidence for the brand-icons-fill-gaps PR. Not for merge.

- contact-sheet.png: each new icon rendered with resvg on its manifest
  background_color, with six existing icons in the last row for comparison.
- build.mjs, tool.mjs: the script that produced the icons. It fits each
  owner-published mark to 24x24, rewrites even-odd fills as nonzero, and
  pixel-diffs each result against its source shape.
- report.json: that diff (diffPixels out of 57,600) and the source of each mark.
