export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderInline(value: string): string {
	return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function splitTableRow(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
	const cells = splitTableRow(line);
	return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

const MARKDOWN_ROW_LIMIT = 8;

function renderTableRows(rows: string[]): string {
	return rows.map((line) => `<tr>${splitTableRow(line).map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("");
}

function renderTable(rows: string[]): string {
	const headerLine = rows[0] ?? "";
	const bodyLines = rows.slice(2);
	const headers = splitTableRow(headerLine);
	const headerHtml = headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
	const visibleRows = bodyLines.slice(0, MARKDOWN_ROW_LIMIT);
	const hiddenRows = bodyLines.slice(MARKDOWN_ROW_LIMIT);
	const overflow = hiddenRows.length
		? `<tr class="overflow-row"><td colspan="${headers.length}"><details class="overflow-details"><summary class="show-all-summary">Show all ${bodyLines.length} table rows</summary><div class="wide-table"><table><thead><tr>${headerHtml}</tr></thead><tbody>${renderTableRows(hiddenRows)}</tbody></table></div></details></td></tr>`
		: "";
	return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${renderTableRows(visibleRows)}${overflow}</tbody></table>`;
}

export function renderMarkdownSafe(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const html: string[] = [];
	let paragraph: string[] = [];
	let listItems: string[] = [];
	let listTag: "ul" | "ol" | undefined;
	let codeLines: string[] | undefined;

	const flushParagraph = () => {
		if (!paragraph.length) return;
		html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
		paragraph = [];
	};
	const flushList = () => {
		if (!listItems.length || !listTag) return;
		const visibleItems = listItems.slice(0, MARKDOWN_ROW_LIMIT).map((item) => `<li>${renderInline(item)}</li>`).join("");
		const hiddenItems = listItems.slice(MARKDOWN_ROW_LIMIT).map((item) => `<li>${renderInline(item)}</li>`).join("");
		const overflow = hiddenItems
			? `<li class="overflow-row"><details class="overflow-details"><summary class="show-all-summary">Show all ${listItems.length} list items</summary><${listTag}${listTag === "ol" ? ` start="${MARKDOWN_ROW_LIMIT + 1}"` : ""}>${hiddenItems}</${listTag}></details></li>`
			: "";
		html.push(`<${listTag}>${visibleItems}${overflow}</${listTag}>`);
		listItems = [];
		listTag = undefined;
	};
	const flushBlocks = () => {
		flushParagraph();
		flushList();
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (codeLines) {
			if (/^```/.test(line.trim())) {
				html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
				codeLines = undefined;
			} else {
				codeLines.push(line);
			}
			continue;
		}
		if (/^```/.test(line.trim())) {
			flushBlocks();
			codeLines = [];
			continue;
		}
		if (!line.trim()) {
			flushBlocks();
			continue;
		}
		const tableLines: string[] = [];
		if (line.trim().startsWith("|") && lines[index + 1]?.trim().startsWith("|") && isTableSeparator(lines[index + 1])) {
			flushBlocks();
			tableLines.push(line, lines[index + 1]);
			index += 2;
			while (index < lines.length && lines[index].trim().startsWith("|")) {
				tableLines.push(lines[index]);
				index += 1;
			}
			index -= 1;
			html.push(renderTable(tableLines));
			continue;
		}
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			flushBlocks();
			const level = heading[1].length;
			html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			continue;
		}
		const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
		const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
		if (bullet || ordered) {
			flushParagraph();
			const nextTag = ordered ? "ol" : "ul";
			if (listTag && listTag !== nextTag) flushList();
			listTag = nextTag;
			listItems.push((bullet?.[1] ?? ordered?.[1] ?? "").trim());
			continue;
		}
		flushList();
		paragraph.push(line.trim());
	}
	if (codeLines) html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
	flushBlocks();
	return html.join("\n");
}
